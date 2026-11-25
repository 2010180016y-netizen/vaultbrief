/**
 * The contract between VaultBrief and its Chrome side panel.
 *
 * The extension runs no model and holds no key: it reads the page and hands the
 * text to the app inside an iframe. That used to be one-way, so the panel could
 * only say "handed over" — it never learned whether the app accepted the
 * document, nor what the run cost. This module defines the three messages both
 * sides implement, and the parsing rules the app applies to anything that
 * arrives from a parent frame:
 *
 *   hello   panel → app   "I am the VaultBrief panel, protocol N"
 *   ready   app → panel   "I am the VaultBrief app, protocol N, these features"
 *   receipt app → panel   a compact summary of the run, after a brief
 *
 * Only an extension origin (or the app's own origin) may send a document, and
 * replies go to the exact source and origin that spoke — never to "*" — so a
 * page that merely frames VaultBrief cannot harvest receipt data.
 */

export const APP_VERSION = "1.2.0";
/** Bumped whenever a message shape changes. Checked on both sides. */
export const BRIDGE_PROTOCOL = 2;
export const MAX_DOCUMENT_CHARS = 60_000;

export interface ReadyMessage {
  type: "vaultbrief:ready";
  protocol: number;
  version: string;
  features: string[];
}

export interface HelloMessage {
  type: "vaultbrief:hello";
  protocol: number;
}

export interface BridgeReceiptSummary {
  id: string;
  source: "on_device" | "in_cloud";
  model: string;
  inputChars: number;
  cloudChars: number;
  simulated: boolean;
  redacted: boolean;
  digest: string | null;
  keyId: string | null;
  seq: number | null;
  signed: boolean;
}

export interface ReceiptMessage {
  type: "vaultbrief:receipt";
  protocol: number;
  receipt: BridgeReceiptSummary;
}

export interface DocumentMessage {
  type: "vaultbrief:document";
  text: string;
  title?: string;
  url?: string;
}

export type IncomingMessage = HelloMessage | DocumentMessage | { type: string };

/** True for the origins the app accepts a document from. */
export function isTrustedBridgeOrigin(origin: string, selfOrigin: string): boolean {
  return origin === selfOrigin || origin.startsWith("chrome-extension://");
}

export function readyMessage(): ReadyMessage {
  return {
    type: "vaultbrief:ready",
    protocol: BRIDGE_PROTOCOL,
    version: APP_VERSION,
    features: ["document", "receipt", "verify"],
  };
}

export function helloMessage(): HelloMessage {
  return { type: "vaultbrief:hello", protocol: BRIDGE_PROTOCOL };
}

export function parseIncoming(data: unknown): IncomingMessage | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as { type?: unknown };
  if (typeof candidate.type !== "string") return null;
  return candidate as IncomingMessage;
}

export interface AcceptedDocument {
  text: string;
  title: string | null;
}

/** Accepts only a well-formed document message; everything else is ignored. */
export function parseDocumentMessage(data: unknown): AcceptedDocument | null {
  const message = parseIncoming(data);
  if (!message || message.type !== "vaultbrief:document") return null;
  const { text, title } = message as DocumentMessage;
  if (typeof text !== "string") return null;
  const trimmed = text.slice(0, MAX_DOCUMENT_CHARS);
  if (trimmed.trim().length === 0) return null;
  return {
    text: trimmed,
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : null,
  };
}

export function receiptMessage(receipt: {
  id: string;
  source: "on_device" | "in_cloud";
  model: string;
  inputChars: number;
  cloudChars: number;
  simulated: boolean;
  redacted: boolean;
  integrity?: { digest: string; keyId?: string; seq: number; signed: boolean };
}): ReceiptMessage {
  return {
    type: "vaultbrief:receipt",
    protocol: BRIDGE_PROTOCOL,
    receipt: {
      id: receipt.id,
      source: receipt.source,
      model: receipt.model,
      inputChars: receipt.inputChars,
      cloudChars: receipt.cloudChars,
      simulated: receipt.simulated,
      redacted: receipt.redacted,
      digest: receipt.integrity?.digest ?? null,
      keyId: receipt.integrity?.keyId ?? null,
      seq: receipt.integrity?.seq ?? null,
      signed: receipt.integrity?.signed ?? false,
    },
  };
}

/** One line the side panel can show under the button. */
export function formatReceiptSummary(message: ReceiptMessage): string {
  const receipt = message.receipt;
  const route = receipt.source === "on_device" ? "on-device" : "cloud";
  const sent = receipt.cloudChars === 0 ? "0 characters sent" : `${receipt.cloudChars.toLocaleString()} characters sent`;
  const flags = [receipt.redacted ? "masked" : null, receipt.simulated ? "simulated" : null].filter(Boolean);
  const seal = receipt.digest
    ? `sealed ${receipt.signed ? "signed" : "digest"} ${receipt.digest.slice(0, 12)}…`
    : "unsealed";
  return `${route} · ${sent}${flags.length ? ` · ${flags.join(" · ")}` : ""} · ${seal}`;
}

export function formatReady(message: ReadyMessage): string {
  return `app ready · v${message.version} · protocol ${message.protocol}`;
}
