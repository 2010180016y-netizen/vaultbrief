import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "./components/Header";
import { KpiStrip } from "./components/KpiStrip";
import { DocumentPanel } from "./components/DocumentPanel";
import { BriefPanel } from "./components/BriefPanel";
import { ConsolePanel } from "./components/ConsolePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ReceiptVerifier } from "./components/ReceiptVerifier";
import { loadConfig, loadLocalConfig, saveLocalConfig, type AppConfig, type LocalModelConfig } from "./engine/config";
import { probeRuntime, type DeviceRuntime } from "./engine/deviceRuntime";
import { TransformersEmbedder, type Embedder } from "./engine/embeddings";
import { planFor, runBrief, type RunOutcome } from "./engine/engine";
import { HybridClient } from "./engine/hybrid";
import { maskDocument, mergeScans } from "./engine/pii";
import { APP_VERSION, isTrustedBridgeOrigin, parseDocumentMessage, parseIncoming, readyMessage, receiptMessage } from "./engine/bridge";
import { SAMPLES } from "./engine/samples";
import { clampThreshold } from "./engine/router";
import { scan } from "./engine/sensitivity";
import { loadRemoteOverrides, type RemoteOverrides } from "./engine/remote";
import { loadLedger, saveLedger, syncReceipt } from "./engine/store";
import type { DeviceStatus, Policy, Progress, RunReceipt } from "./engine/types";
import { WebLlmEngine } from "./engine/webllm";

const UNKNOWN_DEVICE: DeviceStatus = {
  supported: false,
  availability: "unknown",
  note: "Checking the on-device model…",
};

export default function App() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [device, setDevice] = useState<DeviceStatus>(UNKNOWN_DEVICE);
  const [client, setClient] = useState<HybridClient | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<RemoteOverrides>({});

  const [text, setText] = useState<string>(SAMPLES[0].text);
  const [activeSample, setActiveSample] = useState<string | null>(SAMPLES[0].id);
  const [documentTitle, setDocumentTitle] = useState<string | null>(SAMPLES[0].label);
  const [policy, setPolicy] = useState<Policy>("auto");
  const [masking, setMasking] = useState(true);

  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [download, setDownload] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [outcomeText, setOutcomeText] = useState<string | null>(null);
  const [ledger, setLedger] = useState<RunReceipt[]>(() => loadLedger());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [verifierOpen, setVerifierOpen] = useState(false);
  const [local, setLocal] = useState<LocalModelConfig>(() => loadLocalConfig());
  const [runtime, setRuntime] = useState<DeviceRuntime | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [embedderStatus, setEmbedderStatus] = useState<"off" | "loading" | "ready" | "error">("off");
  const abortRef = useRef<AbortController | null>(null);
  const engineRef = useRef<WebLlmEngine | null>(null);
  const embedderRef = useRef<Embedder | null>(null);
  /** Where to answer the extension side panel, if it is the one talking. */
  const bridgeRef = useRef<{ source: MessageEventSource | null; origin: string } | null>(null);

  const refreshRuntime = useCallback(async () => {
    const next = await probeRuntime({
      preference: local.engine,
      modelId: local.webllmModel,
      webllmReady: engineRef.current?.ready ?? false,
    });
    setRuntime(next);
    return next;
  }, [local.engine, local.webllmModel]);

  useEffect(() => {
    let alive = true;
    refreshRuntime().then((next) => {
      if (alive) setDevice(next.status);
    });
    return () => {
      alive = false;
    };
  }, [refreshRuntime]);

  useEffect(() => {
    let alive = true;
    setClientError(null);
    if (!config.firebase) {
      setClient(null);
      return;
    }
    HybridClient.connect(config)
      .then((instance) => {
        if (alive) setClient(instance);
      })
      .catch((error: Error & { hint?: string }) => {
        if (!alive) return;
        setClient(null);
        setClientError([error.message, error.hint].filter(Boolean).join(" "));
      });
    return () => {
      alive = false;
    };
  }, [config]);

  useEffect(() => {
    if (!client) {
      setOverrides({});
      return;
    }
    let alive = true;
    loadRemoteOverrides().then((next) => {
      if (alive) setOverrides(next);
    });
    return () => {
      alive = false;
    };
  }, [client]);

  // Chrome extension bridge: the side panel says hello, hands over a document,
  // and gets the receipt summary back. Replies go to the exact frame and origin
  // that spoke, never to "*": a page that merely frames VaultBrief must not be
  // able to harvest receipts.
  useEffect(() => {
    const reply = (payload: unknown) => {
      const target = bridgeRef.current;
      const source = target?.source as Window | null | undefined;
      if (target && source && typeof source.postMessage === "function") {
        source.postMessage(payload, target.origin);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (!isTrustedBridgeOrigin(event.origin, window.location.origin)) return;
      const message = parseIncoming(event.data);
      if (!message) return;
      if (message.type === "vaultbrief:hello") {
        bridgeRef.current = { source: event.source, origin: event.origin };
        reply(readyMessage());
        return;
      }
      const accepted = parseDocumentMessage(event.data);
      if (!accepted) return;
      bridgeRef.current = { source: event.source, origin: event.origin };
      setText(accepted.text);
      setActiveSample(null);
      setDocumentTitle(accepted.title);
      setOutcome(null);
      setOutcomeText(null);
      reply(readyMessage());
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const cloudModel = overrides.cloudModel ?? config.cloudModel;
  const threshold = clampThreshold(overrides.threshold);
  const live = client !== null;
  // One pass over the document per edit, not four: `maskDocument` already
  // analyses the text, so its analysis is reused for the Presidio panel and the
  // router instead of running the recognizer registry twice on every keystroke.
  const analysis = useMemo(() => {
    if (!text.trim()) return null;
    const ruleScan = scan(text);
    const masked = maskDocument(text);
    return { ruleScan, masked, pii: masked.analysis };
  }, [text]);
  const pii = analysis?.pii ?? null;
  const scanResult = analysis?.ruleScan ?? null;
  const routedScan = useMemo(() => {
    if (!analysis) return undefined;
    const merged = mergeScans(analysis.ruleScan, analysis.pii);
    return { ...merged, redactable: Math.max(merged.redactable, analysis.masked.replaced) };
  }, [analysis]);
  const plan = useMemo(
    () =>
      text.trim()
        ? planFor({ text, policy, maskingAllowed: masking, device, threshold }, routedScan)
        : null,
    [text, policy, masking, device, routedScan, threshold],
  );
  const stale = outcome !== null && outcomeText !== null && outcomeText !== text;

  const ensureEmbedder = useCallback(async (): Promise<Embedder | null> => {
    if (embedderRef.current?.ready) return embedderRef.current;
    setEmbedderStatus("loading");
    const embedder = embedderRef.current ?? new TransformersEmbedder();
    embedderRef.current = embedder;
    try {
      await embedder.prepare();
      setEmbedderStatus("ready");
      return embedder;
    } catch {
      setEmbedderStatus("error");
      return null;
    }
  }, []);

  const handleRun = useCallback(async () => {
    if (running || !text.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setCancelling(false);
    setOutcome(null);
    setOutcomeText(null);
    setProgress({ phase: "scan", message: "Scanning for identifiers on this device…" });
    setDownload(null);
    setDeviceError(null);

    try {
      // The device state the router sees must be the state *after* preparation:
      // pressing the button on a machine where Nano was still downloadable used
      // to prepare the model and then route as if it were absent.
      let activeDevice = device;
      if (runtime?.engine === "nano" && client) {
        // Must happen inside the click handler: Chrome only starts or resumes a
        // model download with user activation.
        try {
          await client.prepareDevice((value) => setDownload(value));
        } catch (error) {
          const hint = (error as { hint?: string }).hint;
          setDeviceError([(error as Error).message, hint].filter(Boolean).join(" "));
        }
        const refreshed = await refreshRuntime();
        activeDevice = refreshed.status;
        setDevice(refreshed.status);
      }
      // transformers.js is loaded on the first run only: 23 MB, cached after.
      let embedder: Embedder | null = null;
      if (local.embeddings) {
        embedder = await ensureEmbedder();
      }
      const result = await runBrief({
        text,
        policy,
        maskingAllowed: masking,
        device: activeDevice,
        client,
        deviceEngine: engineRef.current?.ready ? engineRef.current : null,
        embedder: embedder?.ready ? embedder : null,
        cloudModel,
        threshold,
        signal: controller.signal,
        titleFallback: documentTitle ?? "Brief",
        previousDigest: ledger[0]?.integrity?.digest,
        sequence: (ledger[0]?.integrity?.seq ?? 0) + 1,
        onProgress: setProgress,
      });
      setOutcome(result);
      setOutcomeText(text);
      if (result.status === "ok") {
        const receipt = result.result.receipt;
        setLedger((previous) => {
          const next = [receipt, ...previous].slice(0, 60);
          saveLedger(next);
          return next;
        });
        const target = bridgeRef.current;
        const source = target?.source as Window | null | undefined;
        if (target && source && typeof source.postMessage === "function") {
          source.postMessage(receiptMessage(receipt), target.origin);
        }
        if (client) void syncReceipt(receipt);
      }
      await refreshRuntime();
    } finally {
      abortRef.current = null;
      setRunning(false);
      setCancelling(false);
      setProgress(null);
      setDownload(null);
    }
  }, [running, text, policy, masking, device, client, cloudModel, threshold, documentTitle, runtime, local.embeddings, ledger, ensureEmbedder, refreshRuntime]);

  const handleCancel = useCallback(() => {
    setCancelling(true);
    abortRef.current?.abort();
  }, []);

  const prepareDevice = useCallback(async () => {
    setDeviceError(null);
    try {
      if (runtime?.engine === "nano" || (runtime?.promptApi.availability === "available" && local.engine !== "webllm")) {
        if (!client) {
          setDeviceError("Gemini Nano is prepared through Firebase AI Logic; connect a project in Settings first.");
        } else {
          await client.prepareDevice((value) => setDownload(value));
        }
      } else {
        engineRef.current = engineRef.current ?? new WebLlmEngine(local.webllmModel);
        await engineRef.current.prepare((value, message) => {
          setDownload(value);
          setProgress({ phase: "prepare", message: message || "Loading the on-device model…" });
        });
      }
    } catch (error) {
      const hint = (error as { hint?: string }).hint;
      setDeviceError([(error as Error).message, hint].filter(Boolean).join(" "));
    } finally {
      setDownload(null);
      setProgress(null);
      const next = await refreshRuntime();
      setDevice(next.status);
    }
  }, [runtime, local.engine, local.webllmModel, client, refreshRuntime]);

  const updateLocal = useCallback((patch: Partial<LocalModelConfig>) => {
    const next = saveLocalConfig(patch);
    setLocal(next);
    if (patch.embeddings === false) {
      embedderRef.current?.dispose?.();
      embedderRef.current = null;
      setEmbedderStatus("off");
    }
  }, []);

  const handleConfigChange = useCallback((next: AppConfig) => {
    setConfig(next);
    setOutcome(null);
    setOutcomeText(null);
  }, []);

  // What the verifier pre-fills: the run just made, or the newest ledger entry.
  const verifierReceipt = outcome?.status === "ok" ? outcome.result.receipt : (ledger[0] ?? null);
  const verifierPrevious =
    verifierReceipt && ledger[0]?.id === verifierReceipt.id ? ledger[1]?.integrity?.digest : undefined;

  return (
    <div className="app">
      <Header
        live={live}
        onOpenSettings={() => setSettingsOpen(true)}
        configComplete={config.missing.length === 0}
      />

      {!live && !clientError && (
        <div className="banner">
          <span aria-hidden>⚠</span>
          <div>
            <strong>Demo mode — no Firebase project connected.</strong> Briefs are produced by a local
            extractive summariser so every route, masking rule and receipt can be inspected, but no model is
            called and nothing leaves the browser. <strong>Press “Brief this document” to try it.</strong>{" "}
            Connect a project in Settings to run the real hybrid path.
          </div>
        </div>
      )}

      {clientError && (
        <div className="banner error">
          <span aria-hidden>✕</span>
          <div>
            <strong>Firebase connection failed — the app stays in demo mode.</strong> {clientError}
          </div>
        </div>
      )}

      <KpiStrip ledger={ledger} />

      <div className="grid">
        <div className="col-doc">
          <DocumentPanel
            text={text}
            documentTitle={documentTitle}
            activeSample={activeSample}
            policy={policy}
            masking={masking}
            running={running}
            cancelling={cancelling}
            progress={progress}
            download={download}
            device={device}
            plan={plan}
            onText={(value) => {
              setText(value);
              setActiveSample(null);
              // A pasted or dropped document has no title; do not keep the sample's.
              setDocumentTitle(null);
            }}
            onSample={(id) => {
              const sample = SAMPLES.find((s) => s.id === id);
              if (!sample) return;
              setText(sample.text);
              setActiveSample(id);
              setDocumentTitle(sample.label);
            }}
            onPolicy={setPolicy}
            onMasking={setMasking}
            onRun={handleRun}
            onCancel={handleCancel}
            engineName={
              runtime?.engine === "webllm"
                ? "WebLLM (WebGPU)"
                : runtime?.engine === "nano"
                  ? "Gemini Nano"
                  : "No on-device engine"
            }
            engineNote={deviceError ?? runtime?.note ?? device.note}
            embedderStatus={embedderStatus}
            onPrepareDevice={prepareDevice}
          />
        </div>

        <div className="col-brief">
          <BriefPanel
            outcome={outcome}
            running={running}
            progress={progress}
            plan={plan}
            live={live}
            stale={stale}
            onVerify={() => setVerifierOpen(true)}
          />
        </div>

        <div className="col-console">
          <ConsolePanel
            scan={scanResult}
            pii={pii}
            plan={plan}
            ledger={ledger}
            threshold={threshold}
            remoteError={overrides.error}
            onVerifyReceipt={() => setVerifierOpen(true)}
            onClearLedger={() => {
              setLedger([]);
              saveLedger([]);
            }}
          />
        </div>
      </div>

      <div className="footer">
        <span>
          VaultBrief v{APP_VERSION} · #BuildHybridAI 2026 · Firebase AI Logic hybrid inference (Gemini Nano → Gemini 3.5
          Flash Lite)
        </span>
        <span>Dollar figures are estimates at a configurable list price; token counts are character-based approximations.</span>
      </div>

      <ReceiptVerifier
        open={verifierOpen}
        receipt={verifierReceipt}
        documentText={text}
        previousDigest={verifierPrevious}
        onClose={() => setVerifierOpen(false)}
      />

      {settingsOpen && (
        <SettingsPanel
          config={config}
          onChange={handleConfigChange}
          local={local}
          onLocal={updateLocal}
          runtimeNote={runtime?.note ?? "Checking browser capabilities…"}
          webgpuNote={runtime?.webgpu.note ?? ""}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
