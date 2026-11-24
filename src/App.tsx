import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { KpiStrip } from "./components/KpiStrip";
import { DocumentPanel } from "./components/DocumentPanel";
import { BriefPanel } from "./components/BriefPanel";
import { ConsolePanel } from "./components/ConsolePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { loadConfig, type AppConfig } from "./engine/config";
import { probeDevice } from "./engine/device";
import { planFor, runBrief, type RunOutcome } from "./engine/engine";
import { HybridClient } from "./engine/hybrid";
import { SAMPLES } from "./engine/samples";
import { scan } from "./engine/sensitivity";
import { loadRemoteOverrides, type RemoteOverrides } from "./engine/remote";
import { loadLedger, saveLedger, syncReceipt } from "./engine/store";
import type { DeviceStatus, Policy, Progress, RunReceipt } from "./engine/types";

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
  const [policy, setPolicy] = useState<Policy>("auto");
  const [masking, setMasking] = useState(true);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [download, setDownload] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [ledger, setLedger] = useState<RunReceipt[]>(() => loadLedger());
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    probeDevice().then((status) => {
      if (alive) setDevice(status);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  // Chrome extension bridge: the side panel extracts the page and posts it here.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: string; text?: string };
      if (data?.type !== "vaultbrief:document" || typeof data.text !== "string") return;
      setText(data.text.slice(0, 60000));
      setActiveSample(null);
      setOutcome(null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const cloudModel = overrides.cloudModel ?? config.cloudModel;
  const live = client !== null;
  const scanResult = useMemo(() => (text.trim() ? scan(text) : null), [text]);
  const plan = useMemo(
    () =>
      text.trim()
        ? planFor({ text, policy, maskingAllowed: masking, device, threshold: overrides.threshold }, scanResult ?? undefined)
        : null,
    [text, policy, masking, device, scanResult, overrides.threshold],
  );

  const handleRun = useCallback(async () => {
    if (running || !text.trim()) return;
    setRunning(true);
    setOutcome(null);
    setProgress({ phase: "scan", message: "Scanning for identifiers on this device…" });
    setDownload(null);

    try {
      if (client && device.availability === "available") {
        // Must happen inside the click handler: Chrome only starts or resumes a
        // model download with user activation.
        await client.prepareDevice((value) => setDownload(value)).catch(() => undefined);
      }
      const result = await runBrief({
        text,
        policy,
        maskingAllowed: masking,
        device,
        client,
        cloudModel,
        threshold: overrides.threshold,
        onProgress: setProgress,
      });
      setOutcome(result);
      if (result.status === "ok") {
        const receipt = result.result.receipt;
        setLedger((previous) => {
          const next = [receipt, ...previous].slice(0, 60);
          saveLedger(next);
          return next;
        });
        if (client) void syncReceipt(receipt);
      }
      probeDevice().then(setDevice);
    } finally {
      setRunning(false);
      setProgress(null);
      setDownload(null);
    }
  }, [running, text, policy, masking, device, client, cloudModel, overrides.threshold]);

  const handleConfigChange = useCallback((next: AppConfig) => {
    setConfig(next);
    setOutcome(null);
  }, []);

  return (
    <div className="app">
      <Header
        live={live}
        onOpenSettings={() => setSettingsOpen(true)}
        configComplete={config.missing.length === 0}
      />

      {!live && (
        <div className="banner">
          <span aria-hidden>⚠</span>
          <div>
            <strong>Demo mode — no Firebase project connected.</strong> Briefs are produced by a local
            extractive summariser so every route, masking rule and receipt can be inspected, but no model is
            called and nothing leaves the browser. Connect a project in Settings to run the real hybrid path.
          </div>
        </div>
      )}

      {clientError && (
        <div className="banner error">
          <span aria-hidden>✕</span>
          <div>
            <strong>Firebase connection failed.</strong> {clientError}
          </div>
        </div>
      )}

      <KpiStrip ledger={ledger} />

      <div className="grid">
        <div className="col-doc">
          <DocumentPanel
            text={text}
            activeSample={activeSample}
            policy={policy}
            masking={masking}
            running={running}
            progress={progress}
            download={download}
            device={device}
            plan={plan}
            onText={(value) => {
              setText(value);
              setActiveSample(null);
            }}
            onSample={(id) => {
              const sample = SAMPLES.find((s) => s.id === id);
              if (!sample) return;
              setText(sample.text);
              setActiveSample(id);
            }}
            onPolicy={setPolicy}
            onMasking={setMasking}
            onRun={handleRun}
            onPrepareDevice={async () => {
              if (!client) return;
              await client.prepareDevice((value) => setDownload(value)).catch(() => undefined);
              const status = await probeDevice();
              setDevice(status);
            }}
          />
        </div>

        <div className="col-brief">
          <BriefPanel outcome={outcome} running={running} progress={progress} plan={plan} live={live} />
        </div>

        <div className="col-console">
          <ConsolePanel
            scan={scanResult}
            plan={plan}
            ledger={ledger}
            onClearLedger={() => {
              setLedger([]);
              saveLedger([]);
            }}
          />
        </div>
      </div>

      <div className="footer">
        <span>VaultBrief · #BuildHybridAI 2026 · Firebase AI Logic hybrid inference (Gemini Nano → Gemini 3.5 Flash Lite)</span>
        <span>Dollar figures are estimates at a configurable list price; token counts are character-based approximations.</span>
      </div>

      {settingsOpen && (
        <SettingsPanel
          config={config}
          onChange={handleConfigChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
