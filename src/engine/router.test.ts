import { describe, expect, it } from "vitest";
import { decideRoute } from "./router";
import { scan } from "./sensitivity";
import { SAMPLES } from "./samples";

function route(text: string, options: Partial<Parameters<typeof decideRoute>[0]> = {}) {
  return decideRoute({
    text,
    scan: scan(text),
    policy: "auto",
    deviceReady: false,
    maskingAllowed: true,
    ...options,
  });
}

const privateDoc = "Patient diagnosis: hypertension. Call +1 415 555 0134. Email d.okafor@mailbox.example";
const publicShort = "The committee approved the new park on Tuesday after a short debate about benches.";
const publicLong = `${"The council reviewed the transport plan in detail. ".repeat(90)}`;

describe("router", () => {
  it("keeps a sensitive document on the device when a model is present", () => {
    const outcome = route(privateDoc, { deviceReady: true });
    expect(outcome.blocked).toBe(false);
    expect(outcome.mode).toBe("only_on_device");
    expect(outcome.expectedSource).toBe("on_device");
    expect(outcome.redactBeforeSending).toBe(false);
    expect(outcome.sensitive).toBe(true);
  });

  it("masks a sensitive document only when it has to reach the cloud", () => {
    const outcome = route(privateDoc, { deviceReady: false });
    expect(outcome.mode).toBe("only_in_cloud");
    expect(outcome.redactBeforeSending).toBe(true);
    expect(outcome.reason).toMatch(/masked/);
  });

  it("blocks instead of leaking when masking is switched off", () => {
    const outcome = route(privateDoc, { deviceReady: false, maskingAllowed: false });
    expect(outcome.blocked).toBe(true);
    expect(outcome.notes.join(" ")).toMatch(/Nothing was uploaded/);
  });

  it("prefers the device for a short public document", () => {
    const outcome = route(publicShort, { deviceReady: true });
    expect(outcome.mode).toBe("prefer_on_device");
    expect(outcome.expectedSource).toBe("on_device");
    expect(outcome.sensitive).toBe(false);
  });

  it("uses the cloud for a long public document", () => {
    const outcome = route(publicLong, { deviceReady: true });
    expect(outcome.mode).toBe("prefer_in_cloud");
    expect(outcome.expectedSource).toBe("in_cloud");
  });

  it("honours a device-only policy and refuses to fall back", () => {
    const outcome = route(publicShort, { deviceReady: false, policy: "device_only" });
    expect(outcome.blocked).toBe(true);
    expect(outcome.notes.join(" ")).toMatch(/will not send/);
  });

  it("never sends sensitive text on the cloud policy without masking", () => {
    const outcome = route(privateDoc, { deviceReady: true, policy: "cloud_quality", maskingAllowed: false });
    expect(outcome.blocked).toBe(true);
  });

  it("marks long on-device work as chunked", () => {
    const long = SAMPLES.find((s) => s.id === "nda")!.text;
    const outcome = route(long, { deviceReady: true });
    expect(outcome.mode).toBe("only_on_device");
    expect(outcome.chunked).toBe(true);
    expect(outcome.estimatedChunks).toBeGreaterThan(1);
  });
});
