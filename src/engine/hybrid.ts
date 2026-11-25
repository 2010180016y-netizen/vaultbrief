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
  /** Cloud model name for this call (Remote Config can change it at runtime). */
  cloudModel?: string;
  /** Cancels the HTTP request; the model call rejects with an abort error. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface GenerateOutcome {
  text: string;
  source: InferenceSourceName;
}

/** Default per-request ceiling. The SDK default is 180 s; that is too long for a UI with a Stop button. */
export const REQUEST_TIMEOUT_MS = 90_000;

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

interface SingleRequestOptionsLike {
  signal?: AbortSignal;
  timeout?: number;
}

interface GenerativeModelLike {
  initializeDeviceModel: (onProgress?: (value: number) => void) => Promise<void>;
  generateContent: (
    prompt: string,
    options?: SingleRequestOptionsLike,
  ) => Promise<{
    response: { text: () => string; inferenceSource?: InferenceSourceName };
  }>;
}

interface HybridModules extends FirebaseModules {
  InferenceMode: Record<InferenceModeName, InferenceModeName>;
}

export type { FirebaseModules, HybridModules, GenerativeModelLike };

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

export interface HybridModelParams {
  mode: InferenceModeName;
  inCloudParams: {
    model: string;
    generationConfig: {
      temperature: number;
      maxOutputTokens: number;
      responseMimeType: string;
      responseJsonSchema: typeof BRIEF_SCHEMA;
    };
  };
  onDeviceParams: {
    createOptions: {
      expectedInputs: { type: string; languages: string[] }[];
      expectedOutputs: { type: string; languages: string[] }[];
      initialPrompts: { role: string; content: { type: string; value: string }[] }[];
    };
  };
}

/**
 * The exact parameters handed to `getGenerativeModel`, as a pure function so the
 * tests and the contract check can inspect them without a Firebase project.
 * `mode` is filled with the SDK's own value by the client before the call.
 */
export function hybridParams(mode: InferenceModeName, cloudModel: string): HybridModelParams {
  return {
    mode,
    inCloudParams: {
      model: cloudModel,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 900,
        responseMimeType: "application/json",
        responseJsonSchema: BRIEF_SCHEMA,
      },
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
  };
}

export class HybridClient {
  /** Model objects are cached per (mode, cloud model): the cloud model name is runtime configurable. */
  private models = new Map<string, GenerativeModelLike>();
  /** Device modes whose on-device model has been initialised in this session. */
  private preparedModes = new Set<InferenceModeName>();

  private constructor(
    private readonly sdk: HybridModules,
    private readonly ai: unknown,
    private readonly defaultCloudModel: string,
  ) {}

  static async connect(
    config: AppConfig,
    /** Test seam: a fake SDK with the same surface. */
    loader: () => Promise<HybridModules> = loadSdk,
  ): Promise<HybridClient> {
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
      const sdk = await loader();
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

      try {
        sdk.initializeAppCheck(app, {
          // With a debug token the SDK swaps this provider for the debug
          // provider; the site key is only used when one is configured.
          provider: new sdk.ReCaptchaEnterpriseProvider(config.appCheck.siteKey ?? "vaultbrief-debug"),
          isTokenAutoRefreshEnabled: true,
        });
      } catch (error) {
        throw new HybridError(
          `App Check could not start: ${(error as Error).message}`,
          "Check the reCAPTCHA Enterprise site key, or use a registered debug token while reviewing.",
          "config/app-check-init",
        );
      }

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

  private model(mode: InferenceModeName, cloudModel?: string): GenerativeModelLike {
    const modelName = (cloudModel ?? this.defaultCloudModel).trim() || this.defaultCloudModel;
    const key = `${mode}::${modelName}`;
    const existing = this.models.get(key);
    if (existing) return existing;

    const modeValue = this.sdk.InferenceMode[mode];
    if (!modeValue) {
      throw new HybridError(
        `This build of the SDK has no inference mode “${mode}”.`,
        "The app expects firebase 13.x. Reinstall dependencies and reload.",
        "sdk/contract",
      );
    }

    const model = this.sdk.getGenerativeModel(
      this.ai,
      hybridParams(modeValue, modelName) as unknown as Record<string, unknown>,
    );

    this.models.set(key, model);
    return model;
  }

  /** The cloud model name this client currently uses (default, before per-call overrides). */
  get cloudModel(): string {
    return this.defaultCloudModel;
  }

  /**
   * Must be called from a user gesture. Reports download progress for the
   * on-device model; the promise resolves when the model is usable.
   *
   * Both on-device modes are initialised: `PREFER_ON_DEVICE` and
   * `ONLY_ON_DEVICE` are separate model objects in the SDK, and preparing only
   * the one used to probe would leave the mode the router actually selects
   * unprepared — a 403/“model not ready” on the first private document.
   */
  async prepareDevice(onProgress?: (value: number) => void): Promise<void> {
    const modes: InferenceModeName[] = ["prefer_on_device", "only_on_device"];
    let lastError: unknown = null;
    for (const mode of modes) {
      const model = this.model(mode);
      try {
        await model.initializeDeviceModel((value) => onProgress?.(value));
        this.preparedModes.add(mode);
      } catch (error) {
        lastError = error;
      }
    }
    if (this.preparedModes.size === 0) {
      throw new HybridError(
        "The on-device model could not be prepared.",
        /user|gesture|activation/i.test((lastError as Error)?.message ?? "")
          ? "Press the download button itself: Chrome only starts a download from a real click."
          : "Check that Chrome 139+ is used with the Prompt API enabled, and that there is disk space for the model.",
        "device/prepare",
      );
    }
  }

  get isDevicePrepared(): boolean {
    return this.preparedModes.size > 0;
  }

  async generate({ prompt, mode, cloudModel, signal, timeoutMs }: GenerateArgs): Promise<GenerateOutcome> {
    if (signal?.aborted) {
      throw new HybridError("The request was stopped before it started.", "Nothing was sent.", "request/aborted");
    }
    const model = this.model(mode, cloudModel);
    // A device mode that was never prepared still gets one attempt: when the
    // model is already installed this resolves immediately. When it is not,
    // the SDK's own error is translated into "press Prepare first" rather than
    // a raw failure in the middle of a run.
    if (mode === "only_on_device" || mode === "prefer_on_device") {
      if (!this.preparedModes.has(mode)) {
        try {
          await model.initializeDeviceModel();
          this.preparedModes.add(mode);
        } catch {
          // Fall through: the generate call will surface a translated error.
        }
      }
    }
    const options: SingleRequestOptionsLike = {
      timeout: timeoutMs ?? REQUEST_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    };
    try {
      const result = await model.generateContent(prompt, options);
      const source: InferenceSourceName =
        result.response.inferenceSource ?? (mode.includes("cloud") ? "in_cloud" : "on_device");
      return { text: result.response.text(), source };
    } catch (error) {
      throw this.toHybridError(error, mode);
    }
  }

  private toHybridError(error: unknown, mode: InferenceModeName): HybridError {
    const raw = error as { code?: string; message?: string; name?: string };
    const code = raw?.code ?? "";
    const message = raw?.message ?? String(error);
    const combined = `${code} ${message}`;

    if (raw?.name === "AbortError" || /abort/i.test(combined)) {
      return new HybridError("The request was stopped.", "The run was cancelled; anything already sent is billed as usual.", code || "request/aborted");
    }
    if (code.includes("app-check") || /app.?check/i.test(message)) {
      return new HybridError(
        "App Check rejected this request.",
        "Register this origin (and the debug token, if you use one) under Security → App Check in the Firebase console, then reload.",
        code,
      );
    }
    if (/api.?key|permission|403|401/i.test(combined)) {
      return new HybridError(
        "Firebase refused the request.",
        "Check that the web app config belongs to a project with AI Logic enabled (firebase init ailogic) and that App Check is enforced.",
        code,
      );
    }
    if (/quota|resource.?exhausted|429/i.test(combined)) {
      return new HybridError(
        "The Gemini API quota for this project is exhausted.",
        "Wait for the daily reset or switch the policy to device-only.",
        code,
      );
    }
    if (/model.*(not found|does not exist)|invalid model/i.test(combined)) {
      return new HybridError(
        "The configured cloud model does not exist for this project.",
        "Remote Config may point at a model this project cannot use; clear `cloud_model` or use gemini-3.5-flash-lite.",
        code,
      );
    }
    if (mode === "only_on_device" && /download|not ready|available|device/i.test(message)) {
      return new HybridError(
        "The on-device model is not ready yet.",
        "Open the device panel and press “Download Gemini Nano”, then run the brief again.",
        code,
      );
    }
    if (/timeout|deadline|504/i.test(combined)) {
      return new HybridError(
        "The model did not answer in time.",
        "Try again, shorten the document, or switch the policy. Nothing is retried automatically.",
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
