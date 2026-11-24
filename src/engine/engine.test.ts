import { describe, expect, it } from "vitest";
import { runBrief } from "./engine";
import { SAMPLES } from "./samples";
import type { DeviceStatus } from "./types";

const deviceReady: DeviceStatus = { supported: true, availability: "available", note: "ready" };
const noDevice: DeviceStatus = { supported: false, availability: "unavailable", note: "none" };

const sample = (id: string) => SAMPLES.find((s) => s.id === id)!.text;

const base = {
  client: null, // simulated: exercises the whole pipeline without a Firebase project
  cloudModel: "gemini-3.5-flash-lite",
};

describe("runBrief (simulated pipeline)", () => {
  it("keeps a sensitive document entirely on the device", async () => {
    const outcome = await runBrief({
      ...base,
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.plan.mode).toBe("only_on_device");
    expect(outcome.result.receipt.source).toBe("on_device");
    expect(outcome.result.receipt.cloudChars).toBe(0);
    expect(outcome.result.receipt.stayedLocalChars).toBe(outcome.result.receipt.inputChars);
    expect(outcome.result.receipt.simulated).toBe(true);
    expect(outcome.result.brief.tldr.length).toBeGreaterThan(10);
  });

  it("map-reduces a long private document on the device", async () => {
    const outcome = await runBrief({
      ...base,
      text: sample("nda"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.receipt.chunks).toBeGreaterThan(1);
    expect(outcome.result.receipt.cloudChars).toBe(0);
    expect(outcome.result.receipt.notes.join(" ")).toMatch(/map-reduce/);
    expect(outcome.result.brief.points.length).toBeGreaterThan(0);
  });

  it("sends the long public document to the cloud", async () => {
    const outcome = await runBrief({
      ...base,
      text: sample("brief"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.plan.expectedSource).toBe("in_cloud");
    expect(outcome.result.receipt.cloudChars).toBeGreaterThan(2000);
    expect(outcome.result.receipt.stayedLocalChars).toBe(0);
  });

  it("masks the private document when only the cloud is available", async () => {
    const outcome = await runBrief({
      ...base,
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: true,
      device: noDevice,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.plan.redactBeforeSending).toBe(true);
    expect(outcome.result.receipt.redacted).toBe(true);
    expect(outcome.result.brief.tldr).not.toMatch(/okafor@mailbox/i);
  });

  it("blocks rather than uploading when masking is off and no model is local", async () => {
    const outcome = await runBrief({
      ...base,
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: false,
      device: noDevice,
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.plan.sensitive).toBe(true);
  });

  it("produces a receipt with a stable shape for the ledger", async () => {
    const outcome = await runBrief({
      ...base,
      text: sample("korean-record"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const r = outcome.result.receipt;
    expect(r.id).toBeTruthy();
    expect(new Date(r.startedAt).toString()).not.toBe("Invalid Date");
    expect(r.tokensIn).toBeGreaterThan(0);
    expect(r.latencyMs).toBeGreaterThan(0);
    expect(r.notes.some((n) => n.startsWith("Simulated"))).toBe(true);
  });
});
