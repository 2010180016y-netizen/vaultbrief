import { formatChars, formatUsd, summarize } from "../engine/metrics";
import type { PiiAnalysis } from "../engine/pii";
import type { RouteOutcome } from "../engine/router";
import type { RunReceipt, ScanResult } from "../engine/types";

interface Props {
  scan: ScanResult | null;
  /** Presidio-shaped entity layer for the same text. */
  pii: PiiAnalysis | null;
  plan: RouteOutcome | null;
  ledger: RunReceipt[];
  /** Live threshold (Remote Config can change it). */
  threshold: number;
  remoteError?: string;
  onClearLedger: () => void;
}

function scoreColor(score: number, threshold: number): string {
  if (score >= threshold) return "var(--blocked)";
  if (score >= threshold * 0.6) return "var(--cloud)";
  return "var(--device)";
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ConsolePanel({ scan, pii, plan, ledger, threshold, remoteError, onClearLedger }: Props) {
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
                <span
                  className="mono"
                  style={{ fontSize: 26, fontWeight: 600, color: scoreColor(scan.score, threshold) }}
                >
                  {scan.score}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--dim)" }}>/ 100 · threshold {threshold}</span>
              </div>
              <div className="meter">
                <i style={{ width: `${scan.score}%`, background: scoreColor(scan.score, threshold) }} />
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

              {scan.residual.length > 0 && (
                <div className="plan-note" style={{ marginTop: 10 }}>
                  · Topics that masking cannot remove: {scan.residual.join(", ").toLowerCase()}.
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Presidio entity layer</h2>
          <div className="spacer" />
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
            local · checksum+context
          </span>
        </div>
        <div className="panel-body">
          {!pii || pii.entities.length === 0 ? (
            <div className="ledger-empty">
              {pii ? "No entity above the 0.4 confidence threshold." : "Paste or pick a document to analyse it."}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8 }}>
                {pii.entities.length} entit{pii.entities.length === 1 ? "y" : "ies"} ·{" "}
                {pii.stats.validated} checksum-validated · {pii.stats.contextBoosted} context-boosted
              </div>
              <div className="scan-list">
                {pii.entities.map((entity) => (
                  <div className="scan-item" key={entity.entityType}>
                    <span title={entity.entityType}>
                      {entity.label}
                      {entity.validated > 0 && <span style={{ color: "var(--device)" }}> ✓</span>}
                      {entity.contextBoosted > 0 && <span style={{ color: "var(--cloud)" }}> ctx</span>}
                    </span>
                    <span className="n">
                      ×{entity.count} · {entity.maxScore.toFixed(2)} · {entity.examples[0]}
                    </span>
                  </div>
                ))}
              </div>
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
              {plan.chunked && (
                <div className="plan-note">
                  · {plan.estimatedChunks} pass{plan.estimatedChunks === 1 ? "" : "es"} expected.
                </div>
              )}
              {remoteError && <div className="plan-note">· {remoteError}</div>}
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
              <strong>{summary.realRuns === 0 ? "—" : formatUsd(summary.estimatedSavedUsd)}</strong> est. saved
            </span>
          </div>

          {ledger.length === 0 ? (
            <div className="ledger-empty">No briefs yet. Every run leaves a receipt here.</div>
          ) : (
            <div className="ledger">
              {ledger.map((run) => (
                <div
                  className="ledger-row"
                  key={run.id}
                  title={`${run.notes.join(" · ") || run.model} · ${new Date(run.startedAt).toLocaleString()}`}
                >
                  <span className={`status-dot ${run.source === "on_device" ? "ok" : "warn"}`} />
                  <span className="what">
                    {run.chunks} pass{run.chunks === 1 ? "" : "es"}
                    {run.redacted ? " · masked" : ""}
                    {run.simulated ? " · sim" : ""}
                    {" · "}
                    <span className="when">{timeOf(run.startedAt)}</span>
                  </span>
                  <span className="num">
                    {run.cloudChars === 0 ? "0 sent" : `${formatChars(run.cloudChars)} sent`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {summary.simulatedRuns > 0 && (
            <div className="plan-note" style={{ marginTop: 8 }}>
              · {summary.simulatedRuns} simulated run{summary.simulatedRuns === 1 ? "" : "s"} excluded from
              token and dollar totals — no model was called.
            </div>
          )}
        </div>
      </section>
    </>
  );
}
