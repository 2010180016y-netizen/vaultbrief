import type { RunReceipt } from "./types";

/**
 * Receipt persistence.
 *
 * The ledger is kept in localStorage so the app works with no backend at all,
 * and mirrored to Firestore when the project has it enabled. The Firestore
 * write is deliberately fire-and-forget: a missing database must never break a
 * brief.
 */

const KEY = "vaultbrief.ledger.v1";
const LIMIT = 60;

/** Rejects anything that is not a receipt-shaped object, so a corrupted entry cannot break the ledger maths. */
function isReceipt(value: unknown): value is RunReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.startedAt === "string" &&
    (r.source === "on_device" || r.source === "in_cloud") &&
    typeof r.inputChars === "number" &&
    typeof r.cloudChars === "number" &&
    typeof r.stayedLocalChars === "number" &&
    typeof r.tokensIn === "number" &&
    typeof r.tokensOut === "number" &&
    typeof r.latencyMs === "number" &&
    typeof r.chunks === "number" &&
    Array.isArray(r.notes)
  );
}

export function loadLedger(): RunReceipt[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReceipt).slice(0, LIMIT).map((r) => ({
      ...r,
      model: typeof r.model === "string" ? r.model : r.source === "in_cloud" ? "cloud" : "gemini-nano",
    }));
  } catch {
    return [];
  }
}

export function saveLedger(runs: RunReceipt[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(runs.slice(0, LIMIT)));
  } catch {
    /* storage full or blocked: the in-memory ledger still works */
  }
}

export function clearLedger(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export interface RemoteSyncResult {
  ok: boolean;
  detail: string;
}

/**
 * Mirrors a signed-receipt-shaped document to Firestore when available.
 * Anonymous auth is used so receipts stay scoped per browser; if Auth is not
 * enabled the write is skipped and reported, never thrown.
 */
/** Set after the first failure so a project without Auth/Firestore is not retried on every run. */
let unavailable: string | null = null;

export function resetReceiptSync(): void {
  unavailable = null;
}

export function receiptSyncStatus(): string | null {
  return unavailable;
}

export async function syncReceipt(receipt: RunReceipt): Promise<RemoteSyncResult> {
  if (receipt.simulated) return { ok: false, detail: "A simulated run is not mirrored." };
  if (unavailable) return { ok: false, detail: unavailable };
  try {
    const [{ getApps }, { getFirestore, collection, addDoc, serverTimestamp }, auth] = await Promise.all([
      import("firebase/app"),
      import("firebase/firestore"),
      import("firebase/auth"),
    ]);
    if (getApps().length === 0) return { ok: false, detail: "Firebase is not initialised." };
    const app = getApps()[0];
    const credential = await auth.signInAnonymously(auth.getAuth(app));
    const db = getFirestore(app);
    await addDoc(collection(db, "receipts"), {
      ...receipt,
      uid: credential.user.uid,
      createdAt: serverTimestamp(),
    });
    return { ok: true, detail: "Receipt mirrored to Firestore." };
  } catch (error) {
    unavailable = `Firestore sync skipped: ${(error as Error).message}`;
    return { ok: false, detail: unavailable };
  }
}
