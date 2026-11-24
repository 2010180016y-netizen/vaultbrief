import { useRef, useState } from "react";
import type { RouteOutcome } from "../engine/router";
import { SAMPLES } from "../engine/samples";
import type { DeviceStatus, Policy, Progress } from "../engine/types";

interface Props {
  text: string;
  activeSample: string | null;
  policy: Policy;
  masking: boolean;
  running: boolean;
  progress: Progress | null;
  download: number | null;
  device: DeviceStatus;
  plan: RouteOutcome | null;
  onText: (value: string) => void;
  onSample: (id: string) => void;
  onPolicy: (policy: Policy) => void;
  onMasking: (value: boolean) => void;
  onRun: () => void;
  onPrepareDevice: () => void;
}

const POLICIES: { id: Policy; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Private → device only. Public → on-device first, cloud for long documents." },
  { id: "device_only", label: "Device only", hint: "Never send anything to the cloud, even if that means refusing." },
  { id: "cloud_quality", label: "Cloud quality", hint: "Always use the cloud model; sensitive text is masked first." },
];

const MAX_CHARS = 60000;

export function DocumentPanel({
  text,
  activeSample,
  policy,
  masking,
  running,
  progress,
  download,
  device,
  plan,
  onText,
  onSample,
  onPolicy,
  onMasking,
  onRun,
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
    const content = await file.text();
    onText(content.slice(0, MAX_CHARS));
    setDropNote(`${file.name} · ${content.length.toLocaleString()} characters`);
  };

  const deviceTone =
    device.availability === "available"
      ? "ok"
      : device.availability === "downloadable" || device.availability === "downloading"
        ? "warn"
        : "bad";

  const canRun = text.trim().length > 0 && !running;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Document</h2>
          <div className="spacer" />
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
            {text.length.toLocaleString()} chars
          </span>
        </div>
        <div className="panel-body">
          <div className="samples">
            {SAMPLES.map((sample) => (
              <button
                key={sample.id}
                className={`chip ${activeSample === sample.id ? "active" : ""}`}
                title={sample.blurb}
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
            placeholder="Paste a note, a contract, a medical record or a page of research…"
            onChange={(event) => onText(event.target.value.slice(0, MAX_CHARS))}
          />

          <div className="doc-meta">
            <span>{(text.match(/\S+/g) ?? []).length.toLocaleString()} words</span>
            <span>{plan ? `plan: ${plan.mode.replaceAll("_", " ")}` : "plan: —"}</span>
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
              <div className="field-label">Routing policy</div>
              <div className="segmented">
                {POLICIES.map((item) => (
                  <button
                    key={item.id}
                    className={policy === item.id ? "on" : ""}
                    title={item.hint}
                    onClick={() => onPolicy(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <button className="switch" onClick={() => onMasking(!masking)} type="button">
              <span className="switch-text">
                <strong>Mask identifiers before cloud</strong>
                <span>Emails, numbers and card data become typed placeholders.</span>
              </span>
              <span className={`toggle ${masking ? "on" : ""}`} aria-hidden />
            </button>
          </div>

          <button className="run" onClick={onRun} disabled={!canRun}>
            {running ? (
              <>
                <span className="spin" />
                {progress?.message ?? "Working…"}
              </>
            ) : (
              "Brief this document"
            )}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>On-device model</h2>
        </div>
        <div className="panel-body device">
          <div className="device-row">
            <span className={`status-dot ${deviceTone}`} />
            <strong style={{ fontSize: 13 }}>Gemini Nano</strong>
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

          {device.availability === "downloadable" && download === null && (
            <button className="ghost" onClick={onPrepareDevice} style={{ justifySelf: "start" }}>
              Prepare on-device model
            </button>
          )}

          <div className="device-note" style={{ color: "var(--dim)" }}>
            Requires Chrome 139+ on desktop with the Prompt API flag enabled.
          </div>
        </div>
      </section>
    </>
  );
}
