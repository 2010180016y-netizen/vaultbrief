import { formatChars, formatUsd, summarize } from "../engine/metrics";
import type { RunReceipt } from "../engine/types";

export function KpiStrip({ ledger }: { ledger: RunReceipt[] }) {
  const summary = summarize(ledger);
  const totalChars = summary.localChars + summary.cloudChars;

  return (
    <div className="kpis">
      <div className="kpi">
        <div className="kpi-label">On-device share</div>
        <div className="kpi-value" style={{ color: "var(--device)" }}>
          {summary.runs === 0 ? "—" : `${Math.round(summary.onDeviceShare * 100)}%`}
        </div>
        <div className="kpi-sub">
          {summary.onDeviceRuns} on device · {summary.cloudRuns} in cloud
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Characters kept local</div>
        <div className="kpi-value">{formatChars(summary.localChars)}</div>
        <div className="kpi-sub">
          {totalChars === 0 ? "no documents yet" : `${Math.round(summary.localCharShare * 100)}% of all text processed`}
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Cloud tokens avoided</div>
        <div className="kpi-value">{summary.onDeviceTokens.toLocaleString()}</div>
        <div className="kpi-sub">{summary.cloudTokens.toLocaleString()} tokens were billed to the cloud</div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Estimated cloud spend avoided</div>
        <div className="kpi-value" style={{ color: "var(--accent)" }}>
          {formatUsd(summary.estimatedSavedUsd)}
        </div>
        <div className="kpi-sub">at list price · estimates, not a bill</div>
      </div>
    </div>
  );
}
