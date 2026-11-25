import { useEffect, useState } from "react";
import {
  parseReceiptJson,
  receiptToJson,
  verifyReceipt,
  type ReceiptVerification,
} from "../engine/receipt";
import type { RunReceipt } from "../engine/types";

interface Props {
  open: boolean;
  /** The last receipt, if any: pre-filled so verifying is one click. */
  receipt: RunReceipt | null;
  /** The document it was issued for, so the binding check can run. */
  documentText: string;
  /** Digest of the receipt before this one, so the chain link is checked too. */
  previousDigest?: string;
  onClose: () => void;
}

/**
 * A third party's view of a receipt.
 *
 * Everything here is computed from the receipt file plus, optionally, the
 * document — no model, no network, no app state. That is the point: a judge or a
 * colleague can paste a receipt they were sent and see whether it is intact,
 * whether it was issued by the same key as its neighbours, and whether it is
 * about the document in front of them.
 */
export function ReceiptVerifier({ open, receipt, documentText, previousDigest, onClose }: Props) {
  const [json, setJson] = useState("");
  const [documentInput, setDocumentInput] = useState("");
  const [result, setResult] = useState<ReceiptVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setJson(receipt ? receiptToJson(receipt) : "");
    setDocumentInput(documentText);
    setResult(null);
    setError(null);
  }, [open, receipt, documentText]);

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    const parsed = parseReceiptJson(json);
    if (!parsed.receipt) {
      setError(parsed.error);
      setResult(null);
      setBusy(false);
      return;
    }
    try {
      const options: { documentText?: string; previousDigest?: string } = {};
      if (documentInput.trim()) options.documentText = documentInput;
      if (previousDigest) options.previousDigest = previousDigest;
      setResult(await verifyReceipt(parsed.receipt, options));
    } catch (failure) {
      setError((failure as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vaultbrief-receipt-${(result?.receipt?.id ?? "run").slice(0, 12)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="drawer verifier"
        role="dialog"
        aria-modal="true"
        aria-label="Verify a privacy receipt"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Verify a privacy receipt</h2>
        <p className="verifier-lede">
          A receipt is checked from its own contents: the digest is recomputed, the ECDSA signature is verified with
          the public key inside the file, the document fingerprint is compared with the document you paste, and the
          ledger link is checked when you supply it. Nothing is sent anywhere.
        </p>

        <div className="field-label">Receipt JSON</div>
        <textarea
          className="verifier-json"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          spellCheck={false}
          placeholder="{ … a receipt exported from the app … }"
          aria-label="Receipt JSON"
        />

        <div className="field-label" style={{ marginTop: 10 }}>
          Document (optional — proves the receipt is about this text)
        </div>
        <textarea
          className="verifier-doc"
          value={documentInput}
          onChange={(event) => setDocumentInput(event.target.value)}
          spellCheck={false}
          placeholder="Paste the document the receipt should be bound to"
          aria-label="Document to compare"
        />

        <div className="drawer-actions">
          <button className="primary" onClick={() => void run()} disabled={busy || json.trim().length === 0}>
            {busy ? "Verifying…" : "Verify"}
          </button>
          <button className="ghost" onClick={download} disabled={json.trim().length === 0}>
            Download receipt
          </button>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <p className="verifier-error" role="status">
            {error}
          </p>
        )}

        {result && (
          <div className={`verifier-result ${result.ok ? "ok" : "bad"}`} aria-live="polite">
            <div className="verifier-verdict">
              {result.ok ? "✓ Verified" : "✕ Not verified"}
              <span>
                {result.checks.filter((check) => check.ok).length}/{result.checks.length} checks passed
              </span>
            </div>
            <ul className="verifier-checks">
              {result.checks.map((check) => (
                <li key={check.name} className={check.ok ? "ok" : "bad"}>
                  <span aria-hidden>{check.ok ? "✓" : "✕"}</span>
                  <strong>{check.name}</strong>
                  <span className="detail">{check.detail}</span>
                </li>
              ))}
            </ul>
            {result.receipt?.integrity && (
              <p className="verifier-fingerprint mono">
                document sha256 {result.receipt.integrity.documentSha256}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
