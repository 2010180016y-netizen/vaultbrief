import { base64Decode, base64Encode, canonicalJson, sha256Hex, shortDigest, utf8Bytes } from "./hash";
import type { ReceiptIntegrity, RunReceipt } from "./types";

/**
 * The privacy receipt, made checkable.
 *
 * A receipt that only the issuing tab can vouch for is a screenshot. This module
 * turns it into a claim someone else can test, without the document ever being
 * stored:
 *
 *   - `digest` is SHA-256 over a canonical body: the receipt fields, its chain
 *     position, the previous digest and the document fingerprint. Any edit to a
 *     field changes the digest.
 *   - `documentSha256` binds the receipt to one document. A verifier who holds
 *     the document can recompute it; nobody else learns anything, because a
 *     hash cannot be reversed and the text is never sent or saved.
 *   - `prev` + `seq` chain receipts inside one browser ledger, so a deleted or
 *     reordered run leaves a gap.
 *   - The body is signed with a per-browser ECDSA P-256 key (WebCrypto). The
 *     public key travels inside the receipt, so verification needs nothing but
 *     the file. The honest limit: a signature proves the receipt was produced by
 *     that key and not edited since; it is not a third-party attestation, and a
 *     forger would have to mint a new key (a different `keyId`).
 *
 * Everything here works in Node too (Node 22 exposes the same WebCrypto API),
 * which is what lets `scripts/verify-receipt.mjs` check a receipt in CI.
 */

export const RECEIPT_INTEGRITY_VERSION = 2;
const KEY_STORAGE = "vaultbrief.receipt-key.v1";

/** The document is fingerprinted exactly as it is handed to the engine. */
export function normalizeDocument(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function documentFingerprint(text: string): string {
  return sha256Hex(normalizeDocument(text));
}

interface SigningKey {
  privateKey: CryptoKey;
  publicKeyB64: string;
  keyId: string;
}

interface StoredKey {
  privateJwk: JsonWebKey;
  publicKey: string;
  keyId: string;
}

let cachedKey: SigningKey | null | undefined;
let pendingKey: Promise<SigningKey | null> | null = null;

function subtleCrypto(): SubtleCrypto | null {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  return cryptoObj?.subtle ?? null;
}

/** Copies a typed array into a plain ArrayBuffer (WebCrypto rejects shared buffers). */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function readStoredKey(): StoredKey | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredKey;
    if (!parsed?.privateJwk || !parsed.publicKey || !parsed.keyId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function storeKey(key: StoredKey): void {
  try {
    globalThis.localStorage?.setItem(KEY_STORAGE, JSON.stringify(key));
  } catch {
    /* storage blocked: the key lives for this session only */
  }
}

async function createKey(): Promise<SigningKey | null> {
  const subtle = subtleCrypto();
  if (!subtle) return null;
  try {
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const privateJwk = await subtle.exportKey("jwk", pair.privateKey);
    const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
    const publicKeyB64 = base64Encode(spki);
    const keyId = shortDigest(sha256Hex(spki));
    storeKey({ privateJwk, publicKey: publicKeyB64, keyId });
    return { privateKey: pair.privateKey, publicKeyB64, keyId };
  } catch {
    return null;
  }
}

async function importStoredKey(stored: StoredKey): Promise<SigningKey | null> {
  const subtle = subtleCrypto();
  if (!subtle) return null;
  try {
    const privateKey = await subtle.importKey(
      "jwk",
      stored.privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return { privateKey, publicKeyB64: stored.publicKey, keyId: stored.keyId };
  } catch {
    return null;
  }
}

/** The per-browser signing key, created once and reused across sessions. */
export async function signingIdentity(): Promise<SigningKey | null> {
  if (cachedKey !== undefined) return cachedKey;
  if (pendingKey) return pendingKey;
  pendingKey = (async () => {
    const stored = readStoredKey();
    const imported = stored ? await importStoredKey(stored) : null;
    const key = imported ?? (await createKey());
    cachedKey = key;
    return key;
  })();
  try {
    return await pendingKey;
  } finally {
    pendingKey = null;
  }
}

/** Test seam. */
export function __resetReceiptKey(): void {
  cachedKey = undefined;
  pendingKey = null;
}

export interface SealOptions {
  /** The document this receipt is about. Only its SHA-256 is kept. */
  documentText: string;
  /** Digest of the previous receipt in this browser's ledger. */
  prev?: string;
  /** 1-based position in the ledger. */
  seq?: number;
  /** Fixed timestamp for deterministic tests. */
  now?: string;
}

/** Fields that make up the signed body, in one place so issue and verify agree. */
function signedBody(receipt: RunReceipt, fields: { seq: number; prev?: string; documentSha256: string }) {
  const payload: Record<string, unknown> = { ...(receipt as unknown as Record<string, unknown>) };
  delete payload.integrity;
  return canonicalJson({
    receipt: payload,
    seq: fields.seq,
    prev: fields.prev ?? null,
    documentSha256: fields.documentSha256,
  });
}

export async function sealReceipt(receipt: RunReceipt, options: SealOptions): Promise<RunReceipt> {
  const documentSha256 = documentFingerprint(options.documentText);
  const seq = Math.max(1, Math.trunc(options.seq ?? 1));
  const prev = options.prev?.trim() || undefined;
  const body = signedBody(receipt, { seq, prev, documentSha256 });
  const digest = sha256Hex(body);

  const integrity: ReceiptIntegrity = {
    version: RECEIPT_INTEGRITY_VERSION,
    alg: "SHA-256",
    signed: false,
    digest,
    documentSha256,
    issuedAt: options.now ?? new Date().toISOString(),
    seq,
    ...(prev ? { prev } : {}),
  };

  const key = await signingIdentity();
  const subtle = subtleCrypto();
  if (key && subtle) {
    try {
      const signature = await subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        bufferOf(utf8Bytes(body)),
      );
      integrity.alg = "ECDSA-P256-SHA256";
      integrity.signed = true;
      integrity.keyId = key.keyId;
      integrity.publicKey = key.publicKeyB64;
      integrity.signature = base64Encode(new Uint8Array(signature));
    } catch {
      // Digest-only is still tamper-evident; a signing failure must not fail a run.
    }
  }

  return { ...receipt, integrity };
}

export interface ReceiptCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReceiptVerification {
  ok: boolean;
  checks: ReceiptCheck[];
  receipt: RunReceipt | null;
  /** True/false when a document was supplied, null when it was not tested. */
  documentMatch: boolean | null;
  integrity: ReceiptIntegrity | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Shape check shared by the importer, the verifier and the drawer. */
export function isReceiptLike(value: unknown): value is RunReceipt {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.startedAt === "string" &&
    (value.source === "on_device" || value.source === "in_cloud") &&
    typeof value.inputChars === "number" &&
    typeof value.cloudChars === "number" &&
    typeof value.stayedLocalChars === "number" &&
    typeof value.chunks === "number" &&
    Array.isArray(value.notes)
  );
}

export function parseReceiptJson(text: string): { receipt: RunReceipt | null; error: string | null } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isReceiptLike(parsed)) {
      return { receipt: null, error: "This JSON is not a VaultBrief receipt (id, startedAt, source, counts are required)." };
    }
    return { receipt: parsed, error: null };
  } catch (error) {
    return { receipt: null, error: `Could not parse the JSON: ${(error as Error).message}` };
  }
}

export function receiptToJson(receipt: RunReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/**
 * Verifies a receipt from its own contents. `documentText` adds the binding
 * check; `previousDigest` adds the ledger-chain check.
 */
export async function verifyReceipt(
  value: unknown,
  options: { documentText?: string; previousDigest?: string } = {},
): Promise<ReceiptVerification> {
  const checks: ReceiptCheck[] = [];
  const fail = (name: string, detail: string): ReceiptVerification => ({
    ok: false,
    checks: [...checks, { name, ok: false, detail }],
    receipt: isReceiptLike(value) ? (value as RunReceipt) : null,
    documentMatch: null,
    integrity: isRecord(value) && isRecord(value.integrity) ? (value.integrity as unknown as ReceiptIntegrity) : null,
  });

  if (!isReceiptLike(value)) {
    return fail("shape", "Not a VaultBrief receipt: id, startedAt, source and the character counts are required.");
  }
  const receipt = value as RunReceipt;
  checks.push({ name: "shape", ok: true, detail: `${receipt.id.slice(0, 18)} · ${receipt.source} · ${receipt.startedAt}` });

  const integrity = isRecord(receipt.integrity) ? (receipt.integrity as unknown as ReceiptIntegrity) : null;
  if (!integrity || typeof integrity.digest !== "string" || typeof integrity.documentSha256 !== "string") {
    return fail("integrity block", "This receipt has no integrity block — it predates signed receipts, or it was written by hand.");
  }
  checks.push({
    name: "integrity block",
    ok: true,
    detail: `v${integrity.version} · ${integrity.alg} · seq ${integrity.seq}${integrity.prev ? " · chained" : ""}`,
  });

  const body = signedBody(receipt, {
    seq: integrity.seq,
    prev: integrity.prev,
    documentSha256: integrity.documentSha256,
  });
  const digest = sha256Hex(body);
  const digestOk = digest === integrity.digest;
  checks.push({
    name: "digest",
    ok: digestOk,
    detail: digestOk
      ? `sha256 ${shortDigest(digest, 32)}…`
      : `recomputed ${shortDigest(digest)}… but the receipt says ${shortDigest(integrity.digest)}…`,
  });
  if (!digestOk) return { ok: false, checks, receipt, documentMatch: null, integrity };

  const documentMatch =
    typeof options.documentText === "string" && options.documentText.trim().length > 0
      ? documentFingerprint(options.documentText) === integrity.documentSha256
      : null;
  if (documentMatch !== null) {
    checks.push({
      name: "document fingerprint",
      ok: documentMatch,
      detail: documentMatch
        ? `sha256 ${shortDigest(integrity.documentSha256, 32)}… matches the supplied document`
        : "The supplied document does not hash to this receipt's fingerprint — it is a different document.",
    });
    if (!documentMatch) return { ok: false, checks, receipt, documentMatch, integrity };
  }

  if (integrity.signed) {
    const subtle = subtleCrypto();
    if (!subtle || !integrity.publicKey || !integrity.signature) {
      checks.push({
        name: "signature",
        ok: false,
        detail: "The receipt is marked signed but carries no public key/signature (or this environment has no WebCrypto).",
      });
      return { ok: false, checks, receipt, documentMatch, integrity };
    }
    try {
      const key = await subtle.importKey(
        "spki",
        bufferOf(base64Decode(integrity.publicKey)),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const valid = await subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        bufferOf(base64Decode(integrity.signature)),
        bufferOf(utf8Bytes(body)),
      );
      checks.push({
        name: "signature",
        ok: valid,
        detail: valid
          ? `ECDSA P-256 valid · key ${integrity.keyId ?? "?"}`
          : "The signature does not verify against the public key inside the receipt.",
      });
      if (!valid) return { ok: false, checks, receipt, documentMatch, integrity };
    } catch (error) {
      checks.push({ name: "signature", ok: false, detail: `Signature could not be checked: ${(error as Error).message}` });
      return { ok: false, checks, receipt, documentMatch, integrity };
    }
  } else {
    checks.push({
      name: "signature",
      ok: true,
      detail: "Digest only (no WebCrypto in this environment): edits are still detectable, but not who issued it.",
    });
  }

  if (options.previousDigest) {
    const linked = integrity.prev === options.previousDigest;
    checks.push({
      name: "ledger chain",
      ok: linked,
      detail: linked
        ? `follows ${shortDigest(options.previousDigest)}…`
        : `expected to follow ${shortDigest(options.previousDigest)}… but says ${integrity.prev ? shortDigest(integrity.prev) : "nothing"}`,
    });
    if (!linked) return { ok: false, checks, receipt, documentMatch, integrity };
  }

  const consistency: Array<[string, boolean, string]> = [];
  if (receipt.source === "on_device" && !receipt.redacted) {
    consistency.push([
      "no cloud characters on a device run",
      receipt.cloudChars === 0,
      `cloudChars = ${receipt.cloudChars}`,
    ]);
  }
  if (!receipt.redacted) {
    consistency.push([
      "characters add up",
      receipt.stayedLocalChars + receipt.cloudChars === receipt.inputChars,
      `${receipt.stayedLocalChars} local + ${receipt.cloudChars} sent = ${receipt.stayedLocalChars + receipt.cloudChars} of ${receipt.inputChars}`,
    ]);
  } else {
    consistency.push([
      "masked run reports what stayed local",
      receipt.stayedLocalChars <= receipt.inputChars,
      `${receipt.stayedLocalChars} of ${receipt.inputChars} characters replaced before sending`,
    ]);
  }
  consistency.push([
    "pass count is plausible",
    receipt.chunks >= 1 && receipt.chunks <= 200,
    `${receipt.chunks} pass${receipt.chunks === 1 ? "" : "es"}`,
  ]);
  for (const [name, ok, detail] of consistency) {
    checks.push({ name, ok, detail });
  }

  return { ok: checks.every((check) => check.ok), checks, receipt, documentMatch, integrity };
}
