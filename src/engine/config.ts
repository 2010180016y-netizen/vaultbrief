/**
 * Runtime configuration.
 *
 * A Firebase web config is public by design (it identifies the project, it does
 * not authorise anything), but it is still injected at build or run time rather
 * than committed. Precedence: values pasted in the app (localStorage) win over
 * build-time env vars, so a reviewer can point a hosted build at their own
 * Firebase project without a rebuild.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  appId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface AppCheckConfig {
  siteKey?: string;
  /** "true" generates a new token per browser; a UUID string keeps it stable. */
  debugToken?: string;
}

export interface AppConfig {
  firebase: FirebaseWebConfig | null;
  appCheck: AppCheckConfig;
  cloudModel: string;
  /** Human readable reasons the live path is unavailable. */
  missing: string[];
}

const STORAGE_KEY = "vaultbrief.firebase.v1";
const APP_CHECK_KEY = "vaultbrief.appcheck.v1";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const DEFAULT_CLOUD_MODEL = env.VITE_CLOUD_MODEL || "gemini-3.5-flash-lite";

function fromEnv(): FirebaseWebConfig | null {
  const apiKey = env.VITE_FIREBASE_API_KEY;
  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    projectId,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    appId: env.VITE_FIREBASE_APP_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  };
}

/** Accepts either a JSON paste or a `const firebaseConfig = {...};` paste. */
export function parseFirebaseConfigPaste(paste: string): FirebaseWebConfig | null {
  const text = paste.trim();
  if (!text) return null;
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) return null;
  const body = text.slice(jsonStart, jsonEnd + 1).replace(/,\s*}/g, "}");
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const apiKey = String(parsed.apiKey ?? "").trim();
    const projectId = String(parsed.projectId ?? "").trim();
    if (!apiKey || !projectId) return null;
    return {
      apiKey,
      projectId,
      authDomain: parsed.authDomain ? String(parsed.authDomain) : undefined,
      appId: parsed.appId ? String(parsed.appId) : undefined,
      storageBucket: parsed.storageBucket ? String(parsed.storageBucket) : undefined,
      messagingSenderId: parsed.messagingSenderId ? String(parsed.messagingSenderId) : undefined,
    };
  } catch {
    return null;
  }
}

function fromStorage(): FirebaseWebConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parseFirebaseConfigPaste(raw);
  } catch {
    return null;
  }
}

export function saveFirebaseConfigPaste(paste: string): boolean {
  const parsed = parseFirebaseConfigPaste(paste);
  if (!parsed) return false;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

export function clearFirebaseConfig(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** App Check settings saved from the Settings drawer (debug token for local/hosted review). */
export function saveAppCheck(patch: AppCheckConfig): AppCheckConfig {
  const next: AppCheckConfig = { ...fromStorageAppCheck(), ...patch };
  try {
    globalThis.localStorage?.setItem(APP_CHECK_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

function fromStorageAppCheck(): AppCheckConfig {
  try {
    const raw = globalThis.localStorage?.getItem(APP_CHECK_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AppCheckConfig;
    return { siteKey: parsed.siteKey || undefined, debugToken: parsed.debugToken || undefined };
  } catch {
    return {};
  }
}

export function loadConfig(): AppConfig {
  const firebase = fromStorage() ?? fromEnv();
  const stored = fromStorageAppCheck();
  const appCheck: AppCheckConfig = {
    siteKey: stored.siteKey ?? env.VITE_APPCHECK_SITE_KEY,
    debugToken: stored.debugToken ?? env.VITE_APPCHECK_DEBUG_TOKEN,
  };
  const missing: string[] = [];
  if (!firebase) {
    missing.push("No Firebase config: paste one in Settings or set VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID.");
  }
  if (firebase && !appCheck.siteKey && !appCheck.debugToken) {
    missing.push("App Check is required by Firebase AI Logic: set VITE_APPCHECK_SITE_KEY (reCAPTCHA Enterprise) or a debug token.");
  }
  return {
    firebase,
    appCheck,
    cloudModel: DEFAULT_CLOUD_MODEL,
    missing,
  };
}
