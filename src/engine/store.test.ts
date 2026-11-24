// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearLedger, loadLedger, saveLedger } from "./store";
import type { RunReceipt } from "./types";

const receipt: RunReceipt = {
  id: "r1",
  startedAt: "2026-11-24T00:00:00.000Z",
  policy: "auto",
  requestedMode: "only_in_cloud",
  source: "in_cloud",
  simulated: false,
  latencyMs: 900,
  inputChars: 1200,
  cloudChars: 1100,
  stayedLocalChars: 100,
  tokensIn: 300,
  tokensOut: 120,
  chunks: 2,
  redacted: true,
  model: "gemini-3.5-flash-lite",
  notes: ["Only the masked copy left the device."],
};

beforeEach(() => {
  localStorage.clear();
});

describe("ledger storage", () => {
  it("round-trips receipts", () => {
    saveLedger([receipt]);
    expect(loadLedger()).toEqual([receipt]);
  });

  it("drops corrupted entries instead of breaking the ledger maths", () => {
    localStorage.setItem(
      "vaultbrief.ledger.v1",
      JSON.stringify([receipt, { id: "broken" }, null, "nope", { ...receipt, id: 7 }]),
    );
    const loaded = loadLedger();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("r1");
  });

  it("survives invalid JSON", () => {
    localStorage.setItem("vaultbrief.ledger.v1", "{not json");
    expect(loadLedger()).toEqual([]);
  });

  it("fills a missing model for receipts written by the previous version", () => {
    const { model: _ignored, ...old } = receipt;
    localStorage.setItem("vaultbrief.ledger.v1", JSON.stringify([old]));
    // The old schema did not record a model name; "cloud" stays honest rather
    // than guessing which cloud model answered.
    expect(loadLedger()[0].model).toBe("cloud");
  });

  it("clears the ledger", () => {
    saveLedger([receipt]);
    clearLedger();
    expect(loadLedger()).toEqual([]);
  });
});
