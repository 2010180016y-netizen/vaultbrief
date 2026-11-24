import { useState } from "react";
import type { RunOutcome } from "../engine/engine";
import type { RouteOutcome } from "../engine/router";
import type { Brief, Progress, RunReceipt } from "../engine/types";

interface Props {
  outcome: RunOutcome | null;
  running: boolean;
  progress: Progress | null;
  plan: RouteOutcome | null;
  live: boolean;
}

function routeName(source: string) {
  return source === "on_device" ? "On device · Gemini Nano" : "Cloud · Gemini";
}

function SourcePill({ source }: { source: string }) {
  return (
    <span className={`pill ${source === "on_device" ? "device" : "cloud"}`}>
      {source === "on_device" ? "◆" : "☁"} {routeName(source)}
    </span>
  );
}

function briefToMarkdown(brief: Brief, receipt: RunReceipt): string {
  const lines = [
    `# ${brief.title}`,
    "",
    brief.tldr,
    "",
    ...brief.points.map((point) => `- ${point}`),
  ];
  if (brief.flags.length > 0) {
    lines.push("", "## Flags", ...brief.flags.map((flag) => `- ${flag}`));
  }
  lines.push(
    "",
    "---",
    `Route: ${receipt.source === "on_device" ? "on-device (Gemini Nano)" : "cloud (Gemini)"} · ${receipt.latencyMs} ms · ${receipt.chunks} pass(es)`,
    `Characters sent to the cloud: ${receipt.cloudChars.toLocaleString()} of ${receipt.inputChars.toLocaleString()}`,
    receipt.simulated ? "Simulated run: no model was called." : "Produced with Firebase AI Logic.",
  );
  return lines.join("\n");
}

export function BriefPanel({ outcome, running, progress, plan, live }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  if (running) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Brief</h2>
          <div className="spacer" />
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
            {progress?.completed !== undefined && progress.total
              ? `pass ${progress.completed + 1}/${progress.total}`
              : "working"}
          </span>
        </div>
        <div className="panel-body">
          <div style={{ fontSize: 13.5, color: "var(--muted)", marginBottom: 12 }}>{progress?.message}</div>
          <div className="progress">
            <i
              style={{
                width:
                  progress?.total && progress.completed !== undefined
                    ? `${Math.round((progress.completed / progress.total) * 100)}%`
                    : "24%",
              }}
            />
          </div>
          <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 10 }}>
            {plan?.expectedSource === "on_device"
              ? "Text stays in this tab. The receipt shows exactly what crosses the boundary."
              : "Only the text shown in the receipt is sent."}
          </p>
        </div>
      </section>
    );
  }

  if (!outcome) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Brief</h2>
        </div>
        <div className="brief-empty">
          <strong>Nothing briefed yet</strong>
          Pick a sample on the left and press “Brief this document”. The routing console explains where the
          text will run before you press anything.
        </div>
      </section>
    );
  }

  const receipt = outcome.status === "ok" ? outcome.result.receipt : null;
  const brief = outcome.status === "ok" ? outcome.result.brief : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Brief</h2>
        <div className="spacer" />
        {brief && receipt && (
          <button className="ghost" style={{ padding: "5px 10px" }} onClick={() => copy(briefToMarkdown(brief, receipt))}>
            {copied ? "Copied" : "Copy markdown"}
          </button>
        )}
      </div>

      <div className="route-line">
        {receipt && <SourcePill source={receipt.source} />}
        {outcome.status === "blocked" && <span className="pill blocked">⛔ Held back</span>}
        {outcome.status === "error" && <span className="pill blocked">✕ Failed</span>}
        {receipt && <span>{receipt.latencyMs.toLocaleString()} ms</span>}
        {receipt && <span>· {receipt.chunks} pass{receipt.chunks === 1 ? "" : "es"}</span>}
        {receipt?.redacted && <span className="pill plain">masked copy</span>}
        {receipt?.simulated && <span className="pill plain">simulated</span>}
        {!live && !receipt && <span className="pill plain">demo mode</span>}
      </div>

      <div className="panel-body">
        {outcome.status === "blocked" && (
          <div className="blocked-box">
            <h3>This document was not sent anywhere</h3>
            <p>{outcome.reason}</p>
            {outcome.plan.notes.map((note) => (
              <p key={note} style={{ color: "#e0b9b9" }}>
                · {note}
              </p>
            ))}
          </div>
        )}

        {outcome.status === "error" && (
          <div className="blocked-box">
            <h3>The model call did not complete</h3>
            <p>{outcome.error}</p>
            <p style={{ color: "#e0b9b9" }}>· {outcome.hint}</p>
          </div>
        )}

        {brief && receipt && (
          <>
            <h3 className="brief-title">{brief.title}</h3>
            <p className="brief-tldr">{brief.tldr}</p>

            {brief.points.length > 0 && (
              <>
                <div className="section-label">Key points</div>
                <ul className="points">
                  {brief.points.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              </>
            )}

            {brief.flags.length > 0 && (
              <>
                <div className="section-label">Flags &amp; obligations</div>
                <div className="flags">
                  {brief.flags.map((flag, index) => (
                    <div className="flag" key={index}>
                      <span aria-hidden>⚑</span>
                      <span>{flag}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="receipt">
              <div className="receipt-head">
                <span>Privacy receipt</span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", textTransform: "none" }}>
                  {receipt.id.slice(0, 18)}
                </span>
              </div>
              <div className="receipt-grid">
                <div className="receipt-cell">
                  <div className="k">Ran on</div>
                  <div className="v" style={{ color: receipt.source === "on_device" ? "var(--device)" : "var(--cloud)" }}>
                    {receipt.source === "on_device" ? "device" : "cloud"}
                  </div>
                </div>
                <div className="receipt-cell">
                  <div className="k">Sent to cloud</div>
                  <div className="v">{receipt.cloudChars.toLocaleString()}</div>
                </div>
                <div className="receipt-cell">
                  <div className="k">Stayed local</div>
                  <div className="v">{receipt.stayedLocalChars.toLocaleString()}</div>
                </div>
                <div className="receipt-cell">
                  <div className="k">Tokens in / out</div>
                  <div className="v">
                    {receipt.tokensIn} / {receipt.tokensOut}
                  </div>
                </div>
              </div>
              <div className="receipt-notes">
                {receipt.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
                <p>
                  Routing policy: {receipt.policy.replace("_", " ")} · requested mode:{" "}
                  {receipt.requestedMode.replaceAll("_", " ")}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
