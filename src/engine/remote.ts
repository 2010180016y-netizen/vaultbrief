/**
 * Remote Config overrides.
 *
 * Two values can be changed without redeploying the app:
 *   sensitivity_threshold (number as string, default 40)
 *   cloud_model           (model name, default gemini-3.5-flash-lite)
 *
 * Every failure path returns `{}` plus a readable `error`: an unreachable Remote
 * Config must never stop a brief from running. This follows the Firebase
 * guidance to keep model names out of hard-coded client code.
 */
export interface RemoteOverrides {
  threshold?: number;
  cloudModel?: string;
  error?: string;
  /** When the values were fetched; absent means the defaults are in use. */
  fetchedAt?: string;
}

const DEFAULT_POLL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export async function loadRemoteOverrides(): Promise<RemoteOverrides> {
  try {
    const [{ getApps }, remoteConfig] = await Promise.all([
      import("firebase/app"),
      import("firebase/remote-config"),
    ]);
    if (getApps().length === 0) return { error: "Firebase is not initialised." };
    const rc = remoteConfig.getRemoteConfig(getApps()[0]);
    rc.settings.minimumFetchIntervalMillis = DEFAULT_POLL_MS;

    // A blocked or offline network can leave fetchAndActivate pending for a long
    // time; the brief must not wait for it.
    await Promise.race([
      remoteConfig.fetchAndActivate(rc),
      new Promise((resolve) => setTimeout(resolve, FETCH_TIMEOUT_MS)),
    ]);

    const rawThreshold = remoteConfig.getValue(rc, "sensitivity_threshold").asString();
    const parsedThreshold = Number(rawThreshold);
    const rawModel = remoteConfig.getValue(rc, "cloud_model").asString().trim();

    return {
      threshold:
        rawThreshold && Number.isFinite(parsedThreshold) && parsedThreshold > 0
          ? Math.min(100, Math.max(1, Math.round(parsedThreshold)))
          : undefined,
      cloudModel: rawModel || undefined,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { error: `Remote Config unavailable: ${(error as Error).message}` };
  }
}
