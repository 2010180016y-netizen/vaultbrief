import { formatChars, formatUsd, summarize } from "../engine/metrics";
import type { RouteOutcome } from "../engine/router";
import type { RunReceipt, ScanResult } from "../engine/types";

interface Props {
  scan: ScanResult | null;
  plan: RouteOutcome | null;
  ledger: RunReceipt[];
  onClearLedger: () => void;
}

function scoreColor(score: number): string {
  if (score >= 70) return "var(--blocked)";
  if (score >= 40) return "var(--cloud)";
  return "var(--device)";
}

export function ConsolePanel({ scan, plan, ledger, onClearLedger }: Props) {
  const summary = summarize(ledger);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Sensitivity scan</h2>
          <div className="spacer" />
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
            local only
          </span>
        </div>
        <div className="panel-body">
          {!scan ? (
            <div className="ledger-empty">Paste or pick a document to scan it.</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="mono" style={{ fontSize: 26, fontWeight: 600, color: scoreColor(scan.score) }}>
                  {scan.score}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--dim)" }}>/ 100 · threshold 40</span>
              </div>
              <div className="meter">
                <i style={{ width: `${scan.score}%`, background: scoreColor(scan.score) }} />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {scan.hits === 0
                  ? "No identifiers found."
                  : `${scan.hits} match${scan.hits === 1 ? "" : "es"} · ${scan.redactable} can be masked (${formatChars(scan.redactedChars)} chars)`}
              </div>

              {scan.detections.length > 0 && (
                <div className="scan-list">
                  {scan.detections.map((detection) => (
                    <div className="scan-item" key={detection.label}>
                      <span>{detection.label}</span>
                      <span className="n">
                        ×{detection.count} · {detection.examples[0]}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Routing decision</h2>
        </div>
        <div className="panel-body">
          {!plan ? (
            <div className="ledger-empty">Nothing to route yet.</div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                {plan.blocked ? (
                  <span className="pill blocked">⛔ will not send</span>
                ) : plan.expectedSource === "on_device" ? (
                  <span className="pill device">◆ {plan.mode.replaceAll("_", " ")}</span>
                ) : (
                  <span className="pill cloud">☁ {plan.mode.replaceAll("_", " ")}</span>
                )}
              </div>
              <div className="plan">{plan.reason}</div>
              {plan.notes.slice(0, 3).map((note) => (
                <div className="plan-note" key={note}>
                  · {note}
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Ledger</h2>
          <div className="spacer" />
          {ledger.length > 0 && (
            <button className="ghost" style={{ padding: "3px 8px", fontSize: 11 }} onClick={onClearLedger}>
              clear
            </button>
          )}
        </div>
        <div className="panel-body">
          <div style={{ display: "flex", gap: 14, marginBottom: 10, fontSize: 11.5, color: "var(--muted)" }}>
            <span>
              <strong style={{ color: "var(--device)" }}>{summary.onDeviceRuns}</strong> device
            </span>
            <span>
              <strong style={{ color: "var(--cloud)" }}>{summary.cloudRuns}</strong> cloud
            </span>
            <span>
              <strong>{formatUsd(summary.estimatedSavedUsd)}</strong> est. saved
            </span>
          </div>

          {ledger.length === 0 ? (
            <div className="ledger-empty">No briefs yet. Every run leaves a receipt here.</div>
          ) : (
            <div className="ledger">
              {ledger.map((run) => (
                <div className="ledger-row" key={run.id} title={run.notes.join(" · ")}>
                  <span className={`status-dot ${run.source === "on_device" ? "ok" : "warn"}`} />
                  <span className="what">
                    {run.chunks} pass{run.chunks === 1 ? "" : "es"}
                    {run.redacted ? " · masked" : ""}
                    {run.simulated ? " · sim" : ""}
                  </span>
                  <span className="num">
                    {run.cloudChars === 0 ? "0 sent" : `${formatChars(run.cloudChars)} sent`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
