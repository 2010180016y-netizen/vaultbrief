import { describe, expect, it } from "vitest";
import { parseBrief } from "./prompt";
import { estimateCost, summarize } from "./metrics";
import type { RunReceipt } from "./types";

const receipt = (over: Partial<RunReceipt>): RunReceipt => ({
  id: "r",
  startedAt: "2026-11-24T00:00:00.000Z",
  policy: "auto",
  requestedMode: "prefer_on_device",
  source: "on_device",
  simulated: false,
  latencyMs: 800,
  inputChars: 1000,
  cloudChars: 0,
  stayedLocalChars: 1000,
  tokensIn: 250,
  tokensOut: 100,
  chunks: 1,
  redacted: false,
  model: "gemini-nano",
  notes: [],
  ...over,
});

describe("parseBrief", () => {
  it("reads plain JSON", () => {
    const brief = parseBrief('{"title":"T","tldr":"D","points":["a","b"],"flags":[]}');
    expect(brief).toEqual({ title: "T", tldr: "D", points: ["a", "b"], flags: [] });
  });

  it("reads JSON wrapped in fences and prose", () => {
    const raw = 'Here you go:\n```json\n{"title":"T","tldr":"D","points":["a"],"flags":["f"]}\n```\nThanks';
    expect(parseBrief(raw).flags).toEqual(["f"]);
  });

  it("ignores empty strings inside arrays", () => {
    const brief = parseBrief('{"title":"T","tldr":"D","points":["a","","  "],"flags":[]}');
    expect(brief.points).toEqual(["a"]);
  });

  it("falls back to sentences when the model returns prose", () => {
    const brief = parseBrief("The plant reopened. Output is rising. Costs are flat.", "Fallback");
    expect(brief.title).toBe("Fallback");
    expect(brief.tldr).toContain("reopened");
    expect(brief.points.length).toBeGreaterThan(0);
  });

  it("does not throw on broken JSON", () => {
    expect(() => parseBrief('{"title": "broken"')).not.toThrow();
  });

  it("keeps a title that arrived without content instead of echoing JSON", () => {
    const brief = parseBrief('{"title":"Quarterly report","tldr":"","points":[],"flags":[]}');
    expect(brief.title).toBe("Quarterly report");
    expect(brief.tldr).toBe("");
  });

  it("strips fences from a prose answer", () => {
    const brief = parseBrief("```\nThe plant reopened. Output is rising.\n```", "Fallback");
    expect(brief.tldr).not.toContain("```");
  });
});

describe("ledger maths", () => {
  it("counts nothing as spent when everything ran on-device", () => {
    const summary = summarize([receipt({}), receipt({ id: "r2" })]);
    expect(summary.onDeviceRuns).toBe(2);
    expect(summary.cloudTokens).toBe(0);
    expect(summary.estimatedCloudCostUsd).toBe(0);
    expect(summary.localCharShare).toBe(1);
    expect(summary.estimatedSavedUsd).toBeGreaterThan(0);
  });

  it("bills cloud runs and keeps the two pools separate", () => {
    const summary = summarize([
      receipt({}),
      receipt({ id: "r2", source: "in_cloud", cloudChars: 900, stayedLocalChars: 100, latencyMs: 2200 }),
    ]);
    expect(summary.cloudRuns).toBe(1);
    expect(summary.onDeviceShare).toBeCloseTo(0.5);
    expect(summary.cloudTokens).toBe(350);
    expect(summary.avgLatencyCloudMs).toBe(2200);
    expect(summary.avgLatencyOnDeviceMs).toBe(800);
    expect(summary.localChars).toBe(1100);
    expect(summary.estimatedCloudCostUsd).toBeCloseTo(estimateCost(250, 100), 10);
  });

  it("handles an empty ledger", () => {
    const summary = summarize([]);
    expect(summary.runs).toBe(0);
    expect(summary.onDeviceShare).toBe(0);
    expect(summary.estimatedSavedUsd).toBe(0);
  });

  it("never bills a simulated run", () => {
    const summary = summarize([
      receipt({ simulated: true, tokensIn: 5000, tokensOut: 900 }),
      receipt({ id: "r2", simulated: true, tokensIn: 5000, tokensOut: 900 }),
    ]);
    expect(summary.runs).toBe(2);
    expect(summary.simulatedRuns).toBe(2);
    expect(summary.realRuns).toBe(0);
    expect(summary.estimatedCloudCostUsd).toBe(0);
    expect(summary.estimatedSavedUsd).toBe(0);
    expect(summary.onDeviceTokens).toBe(0);
  });

  it("measures only real runs when demo and live runs are mixed", () => {
    const summary = summarize([
      receipt({ simulated: true, source: "in_cloud", tokensIn: 100, tokensOut: 100 }),
      receipt({ id: "r2", simulated: false, source: "in_cloud", tokensIn: 200, tokensOut: 50 }),
    ]);
    expect(summary.realRuns).toBe(1);
    expect(summary.cloudTokens).toBe(250);
    expect(summary.estimatedCloudCostUsd).toBeCloseTo(estimateCost(200, 50), 10);
  });
});
