import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBrief } from "./engine";
import {
  documentFingerprint,
  isReceiptLike,
  parseReceiptJson,
  receiptToJson,
  sealReceipt,
  verifyReceipt,
  __resetReceiptKey,
} from "./receipt";
import { RECEIPT_MIRROR_FIELDS, mirrorPayload } from "./store";
import { SAMPLES } from "./samples";
import type { RunReceipt } from "./types";

/**
 * The receipt is the product's proof, so it is tested like one: every check the
 * UI shows is exercised here, including the failure modes a hand edit produces.
 */

const DOCUMENT = "Patient: Daniel Okafor. Phone +1 415 555 0134. Diagnosis: stable angina.";

function receiptFor(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    id: "run_test_0001",
    startedAt: "2026-11-25T05:00:00.000Z",
    policy: "auto",
    requestedMode: "only_on_device",
    source: "on_device",
    simulated: false,
    latencyMs: 812,
    inputChars: 200,
    cloudChars: 0,
    stayedLocalChars: 200,
    tokensIn: 51,
    tokensOut: 20,
    chunks: 1,
    redacted: false,
    model: "gemini-nano",
    notes: ["Nothing left the device."],
    ...overrides,
  };
}

describe("receipt sealing and verification", () => {
  it("seals a receipt with a digest, a document fingerprint and a signature", async () => {
    const sealed = await sealReceipt(receiptFor(), { documentText: DOCUMENT, seq: 1 });
    expect(sealed.integrity).toBeDefined();
    expect(sealed.integrity!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.integrity!.documentSha256).toBe(documentFingerprint(DOCUMENT));
    expect(sealed.integrity!.signed).toBe(true);
    expect(sealed.integrity!.alg).toBe("ECDSA-P256-SHA256");
    expect(sealed.integrity!.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(sealed.integrity!.signature).toBeTruthy();

    const result = await verifyReceipt(sealed, { documentText: DOCUMENT });
    expect(result.ok).toBe(true);
    expect(result.documentMatch).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["digest", "signature", "document fingerprint"]),
    );
  });

  it("rejects a receipt whose counters were edited", async () => {
    const sealed = await sealReceipt(receiptFor(), { documentText: DOCUMENT });
    const tampered = { ...sealed, cloudChars: 0, stayedLocalChars: 200, latencyMs: 12 };
    const result = await verifyReceipt(tampered, { documentText: DOCUMENT });
    expect(result.ok).toBe(false);
    const digest = result.checks.find((check) => check.name === "digest");
    expect(digest?.ok).toBe(false);
  });

  it("binds the receipt to one document and rejects a different one", async () => {
    const sealed = await sealReceipt(receiptFor(), { documentText: DOCUMENT });
    const same = await verifyReceipt(sealed, { documentText: `\n${DOCUMENT}\r\n` });
    expect(same.documentMatch).toBe(true);
    const other = await verifyReceipt(sealed, { documentText: `${DOCUMENT} And a second page.` });
    expect(other.ok).toBe(false);
    expect(other.documentMatch).toBe(false);
  });

  it("chains receipts so a deleted run leaves a gap", async () => {
    const first = await sealReceipt(receiptFor(), { documentText: DOCUMENT, seq: 1 });
    const second = await sealReceipt(receiptFor({ id: "run_test_0002" }), {
      documentText: DOCUMENT,
      seq: 2,
      prev: first.integrity!.digest,
    });
    expect(second.integrity!.seq).toBe(2);
    expect(second.integrity!.prev).toBe(first.integrity!.digest);

    const linked = await verifyReceipt(second, { previousDigest: first.integrity!.digest });
    expect(linked.ok).toBe(true);
    const broken = await verifyReceipt(second, { previousDigest: "f".repeat(64) });
    expect(broken.ok).toBe(false);
  });

  it("refuses a signature that was moved between receipts", async () => {
    const a = await sealReceipt(receiptFor(), { documentText: DOCUMENT, seq: 1 });
    const b = await sealReceipt(receiptFor({ id: "run_b", latencyMs: 5 }), { documentText: DOCUMENT, seq: 2 });
    const spliced = { ...b, integrity: { ...b.integrity!, signature: a.integrity!.signature } };
    const result = await verifyReceipt(spliced);
    expect(result.ok).toBe(false);
  });

  it("catches an internally inconsistent receipt even when it is signed", async () => {
    // A device-only run that claims to have sent characters: the digest and the
    // signature are both valid because we sealed it that way, so only the
    // semantic check can catch it — which is why that check exists.
    const inconsistent = receiptFor({ source: "on_device", cloudChars: 42, stayedLocalChars: 158 });
    const sealed = await sealReceipt(inconsistent, { documentText: DOCUMENT });
    const result = await verifyReceipt(sealed);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "no cloud characters on a device run");
    expect(check?.ok).toBe(false);
  });

  it("accepts a digest-only receipt when no signature is present", async () => {
    const sealed = await sealReceipt(receiptFor(), { documentText: DOCUMENT });
    const unsigned = {
      ...sealed,
      integrity: { ...sealed.integrity!, signed: false, alg: "SHA-256" as const, signature: undefined, publicKey: undefined },
    };
    const result = await verifyReceipt(unsigned);
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "signature")?.detail).toMatch(/Digest only/);
  });

  it("reports a receipt from before sealed receipts existed instead of pretending", async () => {
    const legacy = receiptFor();
    const result = await verifyReceipt(legacy);
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)?.name).toBe("integrity block");
    expect(result.checks.at(-1)?.detail).toMatch(/predates/);
  });

  it("rejects JSON that is not a receipt", () => {
    expect(parseReceiptJson("{").receipt).toBeNull();
    expect(parseReceiptJson('{"hello":true}').receipt).toBeNull();
    expect(parseReceiptJson(JSON.stringify(receiptFor())).receipt?.id).toBe("run_test_0001");
    expect(isReceiptLike(receiptFor())).toBe(true);
    expect(isReceiptLike({ ...receiptFor(), source: "somewhere" })).toBe(false);
  });

  it("keeps the same signing key across calls", async () => {
    const a = await sealReceipt(receiptFor(), { documentText: DOCUMENT });
    const b = await sealReceipt(receiptFor({ id: "run_2" }), { documentText: DOCUMENT });
    expect(a.integrity!.keyId).toBe(b.integrity!.keyId);
    __resetReceiptKey();
  });
});

describe("receipt issued by the real pipeline", () => {  it("seals every brief and verifies it against the document", async () => {
    const text = SAMPLES.find((sample) => sample.id === "korean-record")!.text;
    const outcome = await runBrief({
      text,
      policy: "auto",
      maskingAllowed: true,
      device: { supported: false, availability: "unavailable", note: "none", engine: "none" },
      client: null,
      cloudModel: "gemini-3.5-flash-lite",
      sequence: 1,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const receipt = outcome.result.receipt;
    expect(receipt.integrity?.documentSha256).toBe(documentFingerprint(text));
    const verification = await verifyReceipt(receipt, { documentText: text });
    expect(verification.ok).toBe(true);
    expect(receipt.split?.cloudPasses).toBeGreaterThanOrEqual(0);
  });

  it("can be verified by the standalone CLI, byte for byte", async () => {    const text = "Vendor NDA: confidential terms with Northwind Logistics. Contact priya@northwind.example.";
    const outcome = await runBrief({
      text,
      policy: "auto",
      maskingAllowed: true,
      device: { supported: false, availability: "unavailable", note: "none", engine: "none" },
      client: null,
      cloudModel: "gemini-3.5-flash-lite",
      sequence: 4,
      previousDigest: "a".repeat(64),
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    const dir = mkdtempSync(join(tmpdir(), "vaultbrief-receipt-"));
    const receiptPath = join(dir, "receipt.json");
    const documentPath = join(dir, "document.txt");
    writeFileSync(receiptPath, receiptToJson(outcome.result.receipt));
    writeFileSync(documentPath, text);

    const cli = spawnSync(
      process.execPath,
      [
        "scripts/verify-receipt.mjs",
        "--receipt",
        receiptPath,
        "--document",
        documentPath,
        "--previous",
        "a".repeat(64),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(cli.status, cli.stderr || cli.stdout).toBe(0);
    expect(cli.stdout).toContain("VERIFIED");
    expect(cli.stdout).toContain("document fingerprint");

    // And the same file with one edited field must fail.
    const edited = { ...outcome.result.receipt, cloudChars: outcome.result.receipt.cloudChars + 1 };
    writeFileSync(receiptPath, receiptToJson(edited));
    const tampered = spawnSync(
      process.execPath,
      ["scripts/verify-receipt.mjs", "--receipt", receiptPath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(tampered.status).toBe(1);
    expect(tampered.stdout).toContain("NOT VERIFIED");
  });
});

describe("Firestore mirror contract", () => {
  it("writes only fields the security rules allow", () => {
    const rules = readFileSync("firestore.rules", "utf8");
    const start = rules.indexOf("hasOnly([");
    const end = rules.indexOf("])", start);
    expect(start).toBeGreaterThan(-1);
    const allowed = [...rules.slice(start, end).matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
    expect(allowed.length).toBeGreaterThan(15);
    for (const field of RECEIPT_MIRROR_FIELDS) {
      expect(allowed, `${field} is mirrored but not allowed by firestore.rules`).toContain(field);
    }
  });

  it("drops undefined values so the SDK does not reject the write", () => {
    const payload = mirrorPayload(receiptFor());
    expect(payload).not.toHaveProperty("pii");
    expect(payload).not.toHaveProperty("semantic");
    expect(JSON.stringify(payload)).not.toContain("undefined");
    for (const key of Object.keys(payload)) {
      expect(RECEIPT_MIRROR_FIELDS as readonly string[]).toContain(key);
    }
  });

  it("keeps the seal and the pass split when they exist", async () => {
    const sealed = await sealReceipt(receiptFor({ split: { onDevicePasses: 2, cloudPasses: 1 } }), {
      documentText: DOCUMENT,
      seq: 2,
    });
    const payload = mirrorPayload(sealed);
    expect(payload.integrity).toMatchObject({ seq: 2, signed: true });
    expect(payload.split).toEqual({ onDevicePasses: 2, cloudPasses: 1 });
  });
});

describe("committed sample receipt", () => {
  it("is regenerated on demand and always verifies", async () => {
    // The repo ships `evidence/receipt-sample.json` so a judge can run
    //   npm run verify:receipt
    // without a Firebase project. Regenerate it with:
    //   VAULTBRIEF_WRITE_EVIDENCE=1 npx vitest run src/engine/receipt.test.ts
    const text = SAMPLES.find((sample) => sample.id === "discharge")!.text;
    const outcome = await runBrief({
      text,
      policy: "auto",
      maskingAllowed: true,
      device: { supported: false, availability: "unavailable", note: "none", engine: "none" },
      client: null,
      cloudModel: "gemini-3.5-flash-lite",
      sequence: 7,
      previousDigest: "b".repeat(64),
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    if (process.env.VAULTBRIEF_WRITE_EVIDENCE === "1") {
      writeFileSync("evidence/receipt-sample.json", receiptToJson(outcome.result.receipt));
      writeFileSync("evidence/receipt-sample-document.txt", text);
    }

    const result = await verifyReceipt(outcome.result.receipt, {
      documentText: text,
      previousDigest: "b".repeat(64),
    });
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });
});
