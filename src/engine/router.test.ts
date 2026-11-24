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
    expect(outcome.deviceReady).toBe(true);
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

describe("router edge cases", () => {
  it("refuses an empty document instead of producing an empty brief", () => {
    const outcome = route("   \n\n ");
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toMatch(/no text/i);
  });

  it("holds back a keyword-only sensitive document when there is nothing to mask", () => {
    // Health + finance vocabulary, no identifier that redaction could remove.
    const text = "진단명: 급성 위염. 처방 내역: 판토프라졸. 급여 정산 요청.";
    const outcome = route(text, { deviceReady: false });
    expect(outcome.sensitive).toBe(true);
    expect(outcome.blocked).toBe(true);
    expect(outcome.notes.join(" ")).toMatch(/Cloud quality/);
  });

  it("still lets an explicit cloud-quality policy send that document, with a warning", () => {
    const text = "진단명: 급성 위염. 처방 내역: 판토프라졸. 급여 정산 요청.";
    const outcome = route(text, { deviceReady: false, policy: "cloud_quality" });
    expect(outcome.blocked).toBe(false);
    expect(outcome.redactBeforeSending).toBe(true);
    expect(outcome.notes.join(" ")).toMatch(/no maskable identifier/);
  });

  it("applies a Remote Config threshold override", () => {
    const text = "Write to jane@example.com"; // 14 points on its own
    expect(route(text).sensitive).toBe(false);
    expect(route(text, { threshold: 12 }).sensitive).toBe(true);
    // Values outside 1..100 are clamped rather than disabling the scan.
    expect(route(text, { threshold: 0 }).sensitive).toBe(true);
    expect(route(text, { threshold: 100 }).sensitive).toBe(false);
  });

  it("explains how to install the on-device model instead of a generic failure", () => {
    const outcome = route(privateDoc, { deviceReady: false, deviceAvailability: "downloadable" });
    expect(outcome.notes.join(" ")).toMatch(/Download Gemini Nano/);
  });

  it("says what a masked copy still reveals", () => {
    const outcome = route(privateDoc, { deviceReady: false });
    expect(outcome.notes.join(" ")).toMatch(/Health information/);
  });
});
