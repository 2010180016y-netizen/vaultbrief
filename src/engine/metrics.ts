import type { RunReceipt } from "./types";

/**
 * Ledger maths.
 *
 * Cloud tokens are the ones that would have consumed Gemini API quota; on-device
 * tokens consume nothing. The dollar figure is an explicit estimate at a rate
 * you can change (`CLOUD_RATE`), because published prices move and this app
 * should not pretend to know them. Token counts are exact-ish (chars / 4).
 *
 * Simulated runs (demo mode, no Firebase project) never produce a dollar
 * figure: a run in which no model was called cannot have saved a bill.
 */

export const CLOUD_RATE = {
  inputPerMillionUsd: 0.1,
  outputPerMillionUsd: 0.4,
  /** Where the numbers came from — shown in the UI next to the figure. */
  label: "gemini-3.5-flash-lite list price, editable in src/engine/metrics.ts",
};

export interface LedgerSummary {
  runs: number;
  realRuns: number;
  onDeviceRuns: number;
  cloudRuns: number;
  simulatedRuns: number;
  onDeviceShare: number;
  localChars: number;
  cloudChars: number;
  localCharShare: number;
  cloudTokens: number;
  onDeviceTokens: number;
  avgLatencyOnDeviceMs: number;
  avgLatencyCloudMs: number;
  estimatedCloudCostUsd: number;
  estimatedSavedUsd: number;
}

export function estimateCost(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * CLOUD_RATE.inputPerMillionUsd + (tokensOut / 1_000_000) * CLOUD_RATE.outputPerMillionUsd;
}

export function summarize(runs: RunReceipt[]): LedgerSummary {
  const onDevice = runs.filter((r) => r.source === "on_device");
  const cloud = runs.filter((r) => r.source === "in_cloud");
  const measured = runs.filter((r) => !r.simulated);
  const sum = (list: RunReceipt[], pick: (r: RunReceipt) => number) => list.reduce((total, r) => total + pick(r), 0);
  const avg = (list: RunReceipt[]) => (list.length === 0 ? 0 : Math.round(sum(list, (r) => r.latencyMs) / list.length));

  const localChars = sum(runs, (r) => r.stayedLocalChars);
  const cloudChars = sum(runs, (r) => r.cloudChars);
  const totalChars = localChars + cloudChars;

  const measuredCloud = measured.filter((r) => r.source === "in_cloud");
  const measuredDevice = measured.filter((r) => r.source === "on_device");
  const cloudTokens = sum(measuredCloud, (r) => r.tokensIn + r.tokensOut);
  const onDeviceTokens = sum(measuredDevice, (r) => r.tokensIn + r.tokensOut);

  const billed = measuredCloud.reduce((total, r) => total + estimateCost(r.tokensIn, r.tokensOut), 0);
  const ifAllCloud = measured.reduce((total, r) => total + estimateCost(r.tokensIn, r.tokensOut), 0);

  return {
    runs: runs.length,
    realRuns: measured.length,
    onDeviceRuns: onDevice.length,
    cloudRuns: cloud.length,
    simulatedRuns: runs.filter((r) => r.simulated).length,
    onDeviceShare: runs.length === 0 ? 0 : onDevice.length / runs.length,
    localChars,
    cloudChars,
    localCharShare: totalChars === 0 ? 0 : localChars / totalChars,
    cloudTokens,
    onDeviceTokens,
    avgLatencyOnDeviceMs: avg(measuredDevice),
    avgLatencyCloudMs: avg(measuredCloud),
    estimatedCloudCostUsd: billed,
    estimatedSavedUsd: Math.max(0, ifAllCloud - billed),
  };
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatChars(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
