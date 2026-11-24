/**
 * Remote Config overrides.
 *
 * Two values can be changed without redeploying the app:
 *   sensitivity_threshold (number as string, default 40)
 *   cloud_model           (model name, default gemini-3.5-flash-lite)
 *
 * Every failure path returns `{}`: an unreachable Remote Config must never stop
 * a brief from running. This follows the Firebase guidance to keep model names
 * out of hard-coded client code.
 */
export interface RemoteOverrides {
  threshold?: number;
  cloudModel?: string;
  error?: string;
}

const DEFAULT_POLL_MS = 60 * 60 * 1000;

export async function loadRemoteOverrides(): Promise<RemoteOverrides> {
  try {
    const [{ getApps }, remoteConfig] = await Promise.all([import("firebase/app"), import("firebase/remote-config")]);
    if (getApps().length === 0) return { error: "Firebase is not initialised." };
    const rc = remoteConfig.getRemoteConfig(getApps()[0]);
    rc.settings.minimumFetchIntervalMillis = DEFAULT_POLL_MS;
    await remoteConfig.fetchAndActivate(rc);

    const rawThreshold = remoteConfig.getValue(rc, "sensitivity_threshold").asString();
    const parsedThreshold = Number(rawThreshold);
    const cloudModel = remoteConfig.getValue(rc, "cloud_model").asString();

    return {
      threshold: rawThreshold && Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : undefined,
      cloudModel: cloudModel || undefined,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
