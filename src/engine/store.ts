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

export function loadLedger(): RunReceipt[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RunReceipt[];
    return Array.isArray(parsed) ? parsed : [];
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
  ok: boolean
  detail: string;
}

/**
 * Mirrors a signed-receipt-shaped document to Firestore when available.
 * Anonymous auth is used so receipts stay scoped per browser; if Auth is not
 * enabled the write is skipped and reported, never thrown.
 */
/** Set after the first failure so a project without Auth/Firestore is not retried on every run. */
let unavailable: string | null = null;

export async function syncReceipt(receipt: RunReceipt): Promise<RemoteSyncResult> {
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
