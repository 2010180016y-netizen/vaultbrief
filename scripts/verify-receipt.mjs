#!/usr/bin/env node
/**
 * Verifies a VaultBrief privacy receipt outside the app.
 *
 *   node scripts/verify-receipt.mjs --receipt receipt.json \
 *        [--document document.txt] [--previous <digest>] [--json]
 *
 * Why this file exists: a receipt that only the app can check is a screenshot.
 * This script recomputes the canonical body and its SHA-256, verifies the
 * ECDSA P-256 signature with the public key carried inside the receipt, checks
 * the document fingerprint against a document you hold, and can check the
 * ledger-chain link. Node 18+ and no dependency of this repository.
 *
 * The canonicalisation must stay byte-identical to `src/engine/hash.ts`
 * (`canonicalJson`) and `src/engine/receipt.ts` (`signedBody`). The unit test
 * `receipt.test.ts` runs this script against a freshly sealed receipt, so drift
 * between the two implementations fails CI.
 */
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
};
const asJson = args.includes("--json");

const receiptPath = option("--receipt");
if (!receiptPath) {
  console.error(
    "usage: node scripts/verify-receipt.mjs --receipt <file.json> [--document <file>] [--previous <digest>] [--json]",
  );
  process.exit(2);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const normalizeDocument = (text) => text.replace(/\r\n/g, "\n").trim();

let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
} catch (error) {
  console.error(`cannot read the receipt: ${error.message}`);
  process.exit(2);
}

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const integrity =
  receipt && typeof receipt === "object" && receipt.integrity && typeof receipt.integrity === "object"
    ? receipt.integrity
    : null;

let body = null;

if (!integrity || typeof integrity.digest !== "string") {
  add("integrity block", false, "no integrity block: this receipt cannot be verified");
} else {
  add("integrity block", true, `v${integrity.version} · ${integrity.alg} · seq ${integrity.seq}`);
  const payload = { ...receipt };
  delete payload.integrity;
  body = canonicalJson({
    receipt: payload,
    seq: integrity.seq,
    prev: integrity.prev ?? null,
    documentSha256: integrity.documentSha256,
  });
  const digest = sha256(body);
  const digestOk = digest === integrity.digest;
  add(
    "digest",
    digestOk,
    digestOk
      ? `sha256 ${digest.slice(0, 32)}…`
      : `recomputed ${digest.slice(0, 16)}… but the receipt says ${String(integrity.digest).slice(0, 16)}…`,
  );

  if (digestOk && integrity.signed) {
    try {
      const key = await webcrypto.subtle.importKey(
        "spki",
        Buffer.from(String(integrity.publicKey ?? ""), "base64"),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const valid = await webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        Buffer.from(String(integrity.signature ?? ""), "base64"),
        Buffer.from(body, "utf8"),
      );
      add(
        "signature",
        valid,
        valid
          ? `ECDSA P-256 valid · key ${integrity.keyId ?? "?"}`
          : "signature does not verify against the embedded public key",
      );
    } catch (error) {
      add("signature", false, `could not verify: ${error.message}`);
    }
  } else if (digestOk) {
    add("signature", true, "digest only (sealed where WebCrypto was unavailable)");
  }

  const documentPath = option("--document");
  if (documentPath) {
    const documentSha256 = sha256(normalizeDocument(readFileSync(documentPath, "utf8")));
    const match = documentSha256 === integrity.documentSha256;
    add(
      "document fingerprint",
      match,
      match
        ? `sha256 ${documentSha256.slice(0, 32)}… matches ${documentPath}`
        : `${documentPath} hashes to ${documentSha256.slice(0, 16)}…, the receipt says ${String(integrity.documentSha256).slice(0, 16)}…`,
    );
  }

  const previous = option("--previous");
  if (previous) {
    const linked = integrity.prev === previous;
    add(
      "ledger chain",
      linked,
      linked ? `follows ${previous.slice(0, 16)}…` : `expected to follow ${previous.slice(0, 16)}…`,
    );
  }
}

const ok = checks.length > 0 && checks.every((check) => check.ok);
const payload = { ok, receipt: receiptPath, checks };

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const width = Math.max(...checks.map((check) => check.name.length));
  console.log(`receipt: ${receiptPath}`);
  for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
  console.log(`\n${ok ? "VERIFIED" : "NOT VERIFIED"} — ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
}
process.exit(ok ? 0 : 1);
