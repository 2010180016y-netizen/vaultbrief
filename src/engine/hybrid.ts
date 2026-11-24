import { BRIEF_SCHEMA } from "./prompt";
import type { AppConfig } from "./config";
import type { InferenceModeName, InferenceSourceName } from "./types";

/**
 * The only file that talks to Firebase AI Logic.
 *
 * Everything else in the app is route-agnostic, which is the point of the
 * hybrid SDK: one call site, and the SDK decides whether Gemini Nano on the
 * device or a cloud-hosted Gemini answers. `inferenceSource` on the response
 * tells us which one actually ran, and that value is what the privacy receipt
 * in the UI is built from — not from what we asked for.
 */

export interface GenerateArgs {
  prompt: string;
  mode: InferenceModeName;
}

export interface GenerateOutcome {
  text: string;
  source: InferenceSourceName;
}

export class HybridError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HybridError";
  }
}

/* Firebase modules are imported lazily: the demo fallback and the unit tests
 * never load the SDK, so the app still boots when a config is missing. */
type FirebaseModules = {
  initializeApp: (config: Record<string, unknown>) => unknown;
  getApps: () => unknown[];
  getApp: () => unknown;
  initializeAppCheck: (app: unknown, options: Record<string, unknown>) => unknown;
  ReCaptchaEnterpriseProvider: new (key: string) => unknown;
  getAI: (app: unknown, options: Record<string, unknown>) => unknown;
  getGenerativeModel: (ai: unknown, params: Record<string, unknown>) => GenerativeModelLike;
  GoogleAIBackend: new () => unknown;
};

interface GenerativeModelLike {
  initializeDeviceModel: (onProgress?: (value: number) => void) => Promise<void>;
  generateContent: (prompt: string) => Promise<{
    response: { text: () => string; inferenceSource?: InferenceSourceName };
  }>;
}

interface HybridModules extends FirebaseModules {
  InferenceMode: Record<InferenceModeName, InferenceModeName>;
}

let cached: HybridClient | null = null;
let connecting: Promise<HybridClient> | null = null;

async function loadSdk(): Promise<HybridModules> {
  const [app, appCheck, ai] = await Promise.all([
    import("firebase/app"),
    import("firebase/app-check"),
    import("firebase/ai"),
  ]);
  return {
    initializeApp: app.initializeApp as unknown as FirebaseModules["initializeApp"],
    getApps: app.getApps,
    getApp: app.getApp,
    initializeAppCheck: appCheck.initializeAppCheck as unknown as FirebaseModules["initializeAppCheck"],
    ReCaptchaEnterpriseProvider: appCheck.ReCaptchaEnterpriseProvider as unknown as FirebaseModules["ReCaptchaEnterpriseProvider"],
    getAI: ai.getAI as unknown as FirebaseModules["getAI"],
    getGenerativeModel: ai.getGenerativeModel as unknown as FirebaseModules["getGenerativeModel"],
    GoogleAIBackend: ai.GoogleAIBackend as unknown as FirebaseModules["GoogleAIBackend"],
    InferenceMode: ai.InferenceMode as unknown as HybridModules["InferenceMode"],
  };
}

export class HybridClient {
  private models = new Map<InferenceModeName, GenerativeModelLike>();
  private deviceReady = false;

  private constructor(
    private readonly sdk: HybridModules,
    private readonly ai: unknown,
    private readonly cloudModel: string,
  ) {}

  static async connect(config: AppConfig): Promise<HybridClient> {
    if (cached) return cached;
    if (connecting) return connecting;
    if (!config.firebase) {
      throw new HybridError(
        "No Firebase project is configured.",
        "Paste your Firebase web app config in Settings, or set VITE_FIREBASE_* env vars.",
        "config/missing",
      );
    }
    if (!config.appCheck.siteKey && !config.appCheck.debugToken) {
      throw new HybridError(
        "Firebase AI Logic requires App Check.",
        "Set VITE_APPCHECK_SITE_KEY (reCAPTCHA Enterprise) or VITE_APPCHECK_DEBUG_TOKEN and register the token in the Firebase console.",
        "config/app-check",
      );
    }

    connecting = (async () => {
      const sdk = await loadSdk();
      const appConfig = config.firebase!;

      // The debug provider must be configured before App Check initialises.
      // A UUID string keeps the token stable across reloads (docs: App Check
      // debug provider); "true" mints a new one every session.
      if (config.appCheck.debugToken) {
        (globalThis as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
          config.appCheck.debugToken === "true" ? true : config.appCheck.debugToken;
      }

      const app =
        sdk.getApps().length > 0
          ? sdk.getApp()
          : sdk.initializeApp({
              apiKey: appConfig.apiKey,
              authDomain: appConfig.authDomain,
              projectId: appConfig.projectId,
              appId: appConfig.appId,
              storageBucket: appConfig.storageBucket,
              messagingSenderId: appConfig.messagingSenderId,
            });

      sdk.initializeAppCheck(app, {
        provider: new sdk.ReCaptchaEnterpriseProvider(config.appCheck.siteKey ?? "debug-provider"),
        isTokenAutoRefreshEnabled: true,
      });

      const ai = sdk.getAI(app, {
        backend: new sdk.GoogleAIBackend(),
        // Generative models enforce replay protection: the SDK must request
        // short lived, single use App Check tokens for each call.
        useLimitedUseAppCheckTokens: true,
      });

      cached = new HybridClient(sdk, ai, config.cloudModel);
      return cached;
    })();

    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  private model(mode: InferenceModeName): GenerativeModelLike {
    const existing = this.models.get(mode);
    if (existing) return existing;

    const modeValue = this.sdk.InferenceMode[mode];
    const generationConfig = {
      temperature: 0.2,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseJsonSchema: BRIEF_SCHEMA,
    };

    const model = this.sdk.getGenerativeModel(this.ai, {
      mode: modeValue,
      inCloudParams: {
        model: this.cloudModel,
        generationConfig,
      },
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: "text", languages: ["en"] }],
          expectedOutputs: [{ type: "text", languages: ["en"] }],
          initialPrompts: [
            {
              role: "system",
              content: [
                {
                  type: "text",
                  value:
                    "You write very short, factual briefs as strict JSON. Never invent facts that are not in the text.",
                },
              ],
            },
          ],
        },
      },
    });

    this.models.set(mode, model);
    return model;
  }

  /**
   * Must be called from a user gesture. Reports download progress for the
   * on-device model; the promise resolves when the model is usable.
   */
  async prepareDevice(onProgress?: (value: number) => void): Promise<void> {
    // PREFER_ON_DEVICE is enough to obtain a model object that owns the device
    // session, regardless of the mode used for the actual request.
    const model = this.model("prefer_on_device");
    await model.initializeDeviceModel((value) => onProgress?.(value));
    this.deviceReady = true;
  }

  get isDevicePrepared(): boolean {
    return this.deviceReady;
  }

  async generate({ prompt, mode }: GenerateArgs): Promise<GenerateOutcome> {
    const model = this.model(mode);
    try {
      const result = await model.generateContent(prompt);
      const source: InferenceSourceName =
        result.response.inferenceSource ?? (mode.includes("cloud") ? "in_cloud" : "on_device");
      return { text: result.response.text(), source };
    } catch (error) {
      throw this.toHybridError(error, mode);
    }
  }

  private toHybridError(error: unknown, mode: InferenceModeName): HybridError {
    const raw = error as { code?: string; message?: string };
    const code = raw?.code ?? "";
    const message = raw?.message ?? String(error);

    if (code.includes("app-check") || /app.?check/i.test(message)) {
      return new HybridError(
        "App Check rejected this request.",
        "Register this origin (and the debug token, if you use one) under Security → App Check in the Firebase console, then reload.",
        code,
      );
    }
    if (/api.?key|permission|403|401/i.test(`${code} ${message}`)) {
      return new HybridError(
        "Firebase refused the request.",
        "Check that the web app config belongs to a project with AI Logic enabled (firebase init ailogic) and that App Check is enforced.",
        code,
      );
    }
    if (code.includes("quota")) {
      return new HybridError("The Gemini API quota for this project is exhausted.", "Wait for the daily reset or switch policy to device-only.", code);
    }
    if (mode === "only_on_device" && /download|not ready|available/i.test(message)) {
      return new HybridError(
        "The on-device model is not ready yet.",
        "Open the device panel and press “Prepare on-device model”, then run the brief again.",
        code,
      );
    }
    return new HybridError(message || "The model call failed.", "Try again, or switch the routing policy and retry.", code);
  }
}

/** Test seam: lets the unit tests reset the singleton between cases. */
export function __resetHybridClient(): void {
  cached = null;
  connecting = null;
}
