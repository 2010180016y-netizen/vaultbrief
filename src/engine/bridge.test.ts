import { describe, expect, it } from "vitest";
import {
  APP_VERSION,
  BRIDGE_PROTOCOL,
  MAX_DOCUMENT_CHARS,
  formatReady,
  formatReceiptSummary,
  isTrustedBridgeOrigin,
  parseDocumentMessage,
  parseIncoming,
  readyMessage,
  receiptMessage,
} from "./bridge";

describe("bridge contract", () => {
  it("accepts only extension or same-origin parents", () => {
    expect(isTrustedBridgeOrigin("chrome-extension://abcdefghijklmnop", "https://vaultbrief.test")).toBe(true);
    expect(isTrustedBridgeOrigin("https://vaultbrief.test", "https://vaultbrief.test")).toBe(true);
    expect(isTrustedBridgeOrigin("https://evil.example", "https://vaultbrief.test")).toBe(false);
    expect(isTrustedBridgeOrigin("null", "https://vaultbrief.test")).toBe(false);
  });

  it("accepts a document and clips it to the app's limit", () => {
    const long = "a".repeat(MAX_DOCUMENT_CHARS + 500);
    const accepted = parseDocumentMessage({ type: "vaultbrief:document", text: long, title: "  A page  " });
    expect(accepted?.text).toHaveLength(MAX_DOCUMENT_CHARS);
    expect(accepted?.title).toBe("A page");
  });

  it("rejects empty, malformed and unrelated messages", () => {
    expect(parseDocumentMessage({ type: "vaultbrief:document", text: "   " })).toBeNull();
    expect(parseDocumentMessage({ type: "vaultbrief:document", text: 42 })).toBeNull();
    expect(parseDocumentMessage({ type: "vaultbrief:receipt" })).toBeNull();
    expect(parseDocumentMessage(null)).toBeNull();
    expect(parseIncoming("hello")).toBeNull();
    expect(parseIncoming({ type: "vaultbrief:hello" })?.type).toBe("vaultbrief:hello");
  });

  it("announces the protocol and version the panel checks", () => {
    const ready = readyMessage();
    expect(ready.type).toBe("vaultbrief:ready");
    expect(ready.protocol).toBe(BRIDGE_PROTOCOL);
    expect(ready.version).toBe(APP_VERSION);
    expect(ready.features).toContain("receipt");
    expect(formatReady(ready)).toContain(`protocol ${BRIDGE_PROTOCOL}`);
  });

  it("summarises a receipt for the panel without document text", () => {
    const message = receiptMessage({
      id: "run_1",
      source: "on_device",
      model: "gemini-nano",
      inputChars: 1482,
      cloudChars: 0,
      simulated: false,
      redacted: false,
      integrity: { digest: "a".repeat(64), keyId: "1234567890abcdef", seq: 3, signed: true },
    });
    expect(message.receipt.inputChars).toBe(1482);
    expect(formatReceiptSummary(message)).toBe("on-device · 0 characters sent · sealed signed aaaaaaaaaaaa…");
    expect(JSON.stringify(message)).not.toMatch(/patient|diagnosis/i);
  });

  it("marks a simulated, masked cloud run", () => {
    const summary = formatReceiptSummary(
      receiptMessage({
        id: "run_2",
        source: "in_cloud",
        model: "gemini-3.5-flash-lite",
        inputChars: 900,
        cloudChars: 880,
        simulated: true,
        redacted: true,
      }),
    );
    expect(summary).toContain("cloud · 880 characters sent · masked · simulated · unsealed");
  });
});
