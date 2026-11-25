import { describe, expect, it } from "vitest";
import { runBrief } from "./engine";
import type { HybridClient } from "./hybrid";
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
    expect(outcome.result.receipt.model).toBe("gemini-nano");
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
    expect(outcome.result.brief.tldr.length).toBeGreaterThan(10);
  });

  it("sends the long public document to the cloud, masking its incidental identifiers", async () => {
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
    // The newsletter is public (14/100), but its footer address is still an
    // identifier: the cloud only ever sees the masked copy.
    expect(outcome.plan.sensitive).toBe(false);
    expect(outcome.plan.redactBeforeSending).toBe(true);
    expect(outcome.result.receipt.redacted).toBe(true);
    expect(outcome.result.receipt.stayedLocalChars).toBeGreaterThan(0);
    expect(outcome.result.receipt.model).toBe("gemini-3.5-flash-lite");
  });

  it("sends an identifier-free public document to the cloud as it is", async () => {
    const outcome = await runBrief({
      ...base,
      text: `${"The council reviewed the transport plan in detail. ".repeat(90)}`,
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.plan.redactBeforeSending).toBe(false);
    expect(outcome.result.receipt.redacted).toBe(false);
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
    expect(outcome.result.receipt.notes.join(" ")).toMatch(/masked copy/i);
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

  it("refuses an empty document", async () => {
    const outcome = await runBrief({
      ...base,
      text: "   ",
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
    });
    expect(outcome.status).toBe("blocked");
  });
});

describe("runBrief cancellation", () => {
  it("stops before the first pass when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runBrief({
      ...base,
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      signal: controller.signal,
    });
    expect(outcome.status).toBe("cancelled");
  });

  it("stops between passes and reports how far it got", async () => {
    const controller = new AbortController();
    let passes = 0;
    const client = {
      generate: async () => {
        passes += 1;
        if (passes === 2) controller.abort();
        return {
          text: JSON.stringify({ title: "Part", tldr: "A part.", points: ["one"], flags: [] }),
          source: "on_device" as const,
        };
      },
    } as unknown as HybridClient;

    const outcome = await runBrief({
      ...base,
      client,
      text: sample("nda"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      signal: controller.signal,
    });
    expect(outcome.status).toBe("cancelled");
    if (outcome.status !== "cancelled") return;
    expect(outcome.reason).toMatch(/Stopped after 2 of \d+ passes/);
  });
});

describe("runBrief with a live client", () => {
  it("passes the Remote Config model name to every call and reports the fallback", async () => {
    const seen: { cloudModel?: string; mode: string }[] = [];
    const client = {
      generate: async (args: { cloudModel?: string; mode: string }) => {
        seen.push({ cloudModel: args.cloudModel, mode: args.mode });
        return {
          text: JSON.stringify({ title: "Cloud brief", tldr: "Ran in the cloud.", points: ["a"], flags: [] }),
          source: "in_cloud" as const,
        };
      },
    } as unknown as HybridClient;

    const outcome = await runBrief({
      ...base,
      client,
      text: "The committee approved the new park on Tuesday after a short debate.",
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      cloudModel: "gemini-from-remote-config",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].cloudModel).toBe("gemini-from-remote-config");
    expect(seen[0].mode).toBe("prefer_on_device");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.receipt.source).toBe("in_cloud");
    expect(outcome.result.receipt.model).toBe("gemini-from-remote-config");
    expect(outcome.result.receipt.notes.join(" ")).toMatch(/fell back/);
  });

  it("turns an AbortError from the SDK into a stopped run, not a failure", async () => {
    const client = {
      generate: async () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        (error as Error & { code?: string }).code = "request/aborted";
        throw error;
      },
    } as unknown as HybridClient;

    const outcome = await runBrief({
      ...base,
      client,
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
    });
    // The engine maps an abort, from the SDK or from a Stop press, to a stopped run.
    expect(outcome.status).toBe("cancelled");
  });
});
