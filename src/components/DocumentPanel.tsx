import { useRef, useState } from "react";
import type { RouteOutcome } from "../engine/router";
import { SAMPLES } from "../engine/samples";
import type { DeviceStatus, Policy, Progress } from "../engine/types";

interface Props {
  text: string;
  documentTitle: string | null;
  activeSample: string | null;
  policy: Policy;
  masking: boolean;
  running: boolean;
  cancelling: boolean;
  progress: Progress | null;
  download: number | null;
  device: DeviceStatus;
  /** Human name of the engine that will serve the private route. */
  engineName: string;
  /** Why that engine (or none) — WebGPU, Nano, download size. */
  engineNote: string;
  /** transformers.js status for the local semantic layer. */
  embedderStatus: "off" | "loading" | "ready" | "error";
  plan: RouteOutcome | null;
  onText: (value: string) => void;
  onSample: (id: string) => void;
  onPolicy: (policy: Policy) => void;
  onMasking: (value: boolean) => void;
  onRun: () => void;
  onCancel: () => void;
  onPrepareDevice: () => void;
}

const POLICIES: { id: Policy; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Private → device only. Public → on-device first, cloud for long documents." },
  { id: "device_only", label: "Device only", hint: "Never send anything to the cloud, even if that means refusing." },
  { id: "cloud_quality", label: "Cloud quality", hint: "Always use the cloud model; sensitive text is masked first." },
];

const MAX_CHARS = 60000;
const MAX_FILE_BYTES = 2_000_000;

export function DocumentPanel({
  text,
  documentTitle,
  activeSample,
  policy,
  masking,
  running,
  cancelling,
  progress,
  download,
  device,
  engineName,
  engineNote,
  embedderStatus,
  plan,
  onText,
  onSample,
  onPolicy,
  onMasking,
  onRun,
  onCancel,
  onPrepareDevice,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const readFile = async (file: File) => {
    const isText =
      file.type.startsWith("text/") ||
      /\.(txt|md|markdown|json|csv|log|html?)$/i.test(file.name);
    if (!isText) {
      setDropNote(`${file.name}: only plain text files are read in the browser. Paste PDF or Word content instead.`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setDropNote(`${file.name} is ${(file.size / 1_000_000).toFixed(1)} MB. VaultBrief reads up to 2 MB / 60,000 characters — paste the relevant part instead.`);
      return;
    }
    const content = await file.text();
    const clipped = content.slice(0, MAX_CHARS);
    onText(clipped);
    setDropNote(
      content.length > MAX_CHARS
        ? `${file.name} · kept the first ${MAX_CHARS.toLocaleString()} of ${content.length.toLocaleString()} characters`
        : `${file.name} · ${content.length.toLocaleString()} characters`,
    );
  };

  const deviceTone =
    device.availability === "available"
      ? "ok"
      : device.availability === "downloadable" || device.availability === "downloading"
        ? "warn"
        : "bad";

  const canRun = text.trim().length > 0 && !running;
  // Only offer the download when it can actually help: an "unavailable" model
  // on this hardware will fail to install, and pretending otherwise wastes a
  // judge's click (and a few hundred megabytes).
  const canDownload =
    device.supported &&
    (device.availability === "downloadable" ||
      device.availability === "downloading" ||
      device.availability === "unknown");

  const planLabel = plan
    ? plan.blocked
      ? "blocked"
      : plan.expectedSource === "on_device"
        ? plan.mode.replaceAll("_", " ")
        : `${plan.mode.replaceAll("_", " ")} · ${plan.redactBeforeSending ? "masked" : "unmasked"}`
    : "—";

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Document</h2>
          {documentTitle && (
            <span className="doc-title" title={documentTitle}>
              {documentTitle}
            </span>
          )}
          <div className="spacer" />
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
            {text.length.toLocaleString()} chars
          </span>
        </div>
        <div className="panel-body">
          <div className="samples" role="group" aria-label="Sample documents">
            {SAMPLES.map((sample) => (
              <button
                key={sample.id}
                className={`chip ${activeSample === sample.id ? "active" : ""}`}
                title={sample.blurb}
                aria-pressed={activeSample === sample.id}
                onClick={() => onSample(sample.id)}
              >
                {sample.label}
              </button>
            ))}
          </div>

          <textarea
            className="doc-input"
            value={text}
            spellCheck={false}
            aria-label="Document to brief"
            placeholder="Paste a note, a contract, a medical record or a page of research…"
            onChange={(event) => onText(event.target.value.slice(0, MAX_CHARS))}
          />

          <div className="doc-meta">
            <span>{(text.match(/\S+/g) ?? []).length.toLocaleString()} words</span>
            <span>plan: {planLabel}</span>
          </div>

          <div
            className={`dropzone ${dragging ? "over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file) void readFile(file);
            }}
          >
            <span>{dropNote ?? "Drop a .txt or .md file, or"}</span>
            <button className="ghost" style={{ padding: "4px 10px" }} onClick={() => fileInput.current?.click()}>
              Choose file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md,.markdown,.json,.csv,.log,.html,text/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </div>

          <div className="controls">
            <div>
              <div className="field-label" id="policy-label">
                Routing policy
              </div>
              <div className="segmented" role="group" aria-labelledby="policy-label">
                {POLICIES.map((item) => (
                  <button
                    key={item.id}
                    className={policy === item.id ? "on" : ""}
                    title={item.hint}
                    aria-pressed={policy === item.id}
                    onClick={() => onPolicy(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              className="switch"
              onClick={() => onMasking(!masking)}
              type="button"
              role="switch"
              aria-checked={masking}
            >
              <span className="switch-text">
                <strong>Mask identifiers before cloud</strong>
                <span>Emails, numbers and card data become typed placeholders.</span>
              </span>
              <span className={`toggle ${masking ? "on" : ""}`} aria-hidden />
            </button>
          </div>

          <div className="run-row">
            <button className="run" onClick={onRun} disabled={!canRun}>
              {running ? (
                <>
                  <span className="spin" />
                  {cancelling ? "Stopping…" : (progress?.message ?? "Working…")}
                </>
              ) : (
                "Brief this document"
              )}
            </button>
            {running && (
              <button className="ghost stop" onClick={onCancel} disabled={cancelling} type="button">
                Stop
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>On-device model</h2>
        </div>
        <div className="panel-body device">
          <div className="device-row">
            <span className={`status-dot ${deviceTone}`} />
            <strong style={{ fontSize: 13 }}>{engineName}</strong>
            <span style={{ color: "var(--dim)" }}>·</span>
            <span style={{ color: "var(--muted)" }}>{device.availability}</span>
          </div>
          <div className="device-note">{device.note}</div>

          {download !== null && (
            <>
              <div className="progress">
                <i style={{ width: `${Math.round(Math.min(1, download) * 100)}%` }} />
              </div>
              <div className="device-note">Downloading the on-device model… {Math.round(download * 100)}%</div>
            </>
          )}

          {canDownload && download === null && (
            <button className="ghost" onClick={onPrepareDevice} style={{ justifySelf: "start" }}>
              {device.availability === "downloading"
                ? "Prepare on-device model"
                : engineName.startsWith("WebLLM")
                  ? "Download WebLLM model"
                  : "Download Gemini Nano"}
            </button>
          )}

          <div className="device-note">{engineNote}</div>

          <div className="device-note" style={{ color: "var(--dim)" }}>
            <span className="mono">transformers.js</span> ·{" "}
            {embedderStatus === "ready"
              ? "local embeddings ready: semantic sensitivity + duplicate removal"
              : embedderStatus === "loading"
                ? "loading the embedding model (about 23 MB, cached after the first run)"
                : embedderStatus === "off"
                  ? "local semantic layer off"
                  : "embedding model unavailable — keyword and entity layers still run"}
          </div>
        </div>
      </section>
    </>
  );
}
