import { beforeEach, describe, expect, it } from "vitest";
import { HybridClient, HybridError, hybridParams, __resetHybridClient, type HybridModules } from "./hybrid";
import type { AppConfig } from "./config";
import { BRIEF_SCHEMA } from "./prompt";

/**
 * Behaviour of the only file that talks to Firebase AI Logic, tested against a
 * fake SDK with the real surface. The unit tests cannot reach Google, so what is
 * locked here is exactly the part that would silently break a live run:
 * App Check ordering, one model object per (mode, cloud model), the user-gesture
 * rule for the device model, and the error translation a judge sees.
 */

const config: AppConfig = {
  firebase: {
    apiKey: "AIzaSyFAKE",
    projectId: "vaultbrief-review",
    appId: "1:0:web:0",
  },
  appCheck: { debugToken: "11111111-2222-3333-4444-555555555555" },
  cloudModel: "gemini-3.5-flash-lite",
  missing: [],
};

interface FakeModel {
  mode: string;
  params: Record<string, unknown>;
  initializeCalls: number;
  generateError?: unknown;
  onGenerate?: (prompt: string) => { text: string; inferenceSource?: "on_device" | "in_cloud" };
}

function fakeSdk() {
  const log: string[] = [];
  const models: FakeModel[] = [];
  const generateCalls: Array<{ prompt: string; options?: unknown }> = [];
  let initializedApp: unknown = null;

  const sdk: HybridModules = {
    initializeApp: (appConfig) => {
      log.push("initializeApp");
      if ((appConfig as { projectId?: string }).projectId !== "vaultbrief-review") {
        throw new Error("unexpected project");
      }
      initializedApp = { name: "app" };
      return initializedApp;
    },
    getApps: () => (initializedApp ? [initializedApp] : []),
    getApp: () => initializedApp,
    initializeAppCheck: (app, options) => {
      log.push("initializeAppCheck");
      if (app !== initializedApp) throw new Error("App Check started before the app");
      if (!(options as { provider?: unknown }).provider) throw new Error("no App Check provider");
      return { appCheck: true };
    },
    ReCaptchaEnterpriseProvider: class {
      constructor(readonly key: string) {}
    },
    getAI: (app, options) => {
      log.push("getAI");
      if (app !== initializedApp) throw new Error("AI started before the app");
      expect((options as { useLimitedUseAppCheckTokens?: boolean }).useLimitedUseAppCheckTokens).toBe(true);
      return { ai: true };
    },
    getGenerativeModel: (_ai, params) => {
      const mode = String((params as { mode: string }).mode);
      log.push(`getGenerativeModel:${mode}`);
      const model: FakeModel = { mode, params, initializeCalls: 0 };
      models.push(model);
      return {
        initializeDeviceModel: async () => {
          model.initializeCalls += 1;
        },
        generateContent: async (prompt: string, options?: unknown) => {
          generateCalls.push({ prompt, options });
          if (model.generateError) throw model.generateError;
          const answer = model.onGenerate?.(prompt) ?? {
            text: JSON.stringify({ title: "T", tldr: "x", points: [], flags: [] }),
            inferenceSource: model.mode.includes("cloud") ? ("in_cloud" as const) : ("on_device" as const),
          };
          return {
            response: {
              text: () => answer.text,
              ...(answer.inferenceSource ? { inferenceSource: answer.inferenceSource } : {}),
            },
          };
        },
      };
    },
    GoogleAIBackend: class {},
    InferenceMode: {
      prefer_on_device: "prefer_on_device",
      only_on_device: "only_on_device",
      prefer_in_cloud: "prefer_in_cloud",
      only_in_cloud: "only_in_cloud",
    },
  };

  return { sdk, log, models, generateCalls };
}

beforeEach(() => {
  __resetHybridClient();
  delete (globalThis as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN;
});

describe("hybridParams", () => {
  it("builds one parameter set for the SDK's four modes", () => {
    for (const mode of ["prefer_on_device", "only_on_device", "prefer_in_cloud", "only_in_cloud"] as const) {
      const params = hybridParams(mode, "gemini-3.5-flash-lite");
      expect(params.mode).toBe(mode);
      expect(params.inCloudParams.model).toBe("gemini-3.5-flash-lite");
      expect(params.onDeviceParams.createOptions.expectedInputs[0].type).toBe("text");
    }
  });

  it("uses the same JSON schema as the prompt layer", () => {
    const params = hybridParams("prefer_in_cloud", "gemini-3.5-flash-lite");
    expect(params.inCloudParams.generationConfig.responseJsonSchema).toBe(BRIEF_SCHEMA);
    expect(Object.keys(BRIEF_SCHEMA.properties)).toEqual(["title", "tldr", "points", "flags"]);
  });

  it("keeps the cloud model name configurable per call", () => {
    expect(hybridParams("prefer_in_cloud", "another-model").inCloudParams.model).toBe("another-model");
  });
});

describe("HybridClient.connect", () => {
  it("initialises App Check before AI Logic and asks for limited-use tokens", async () => {
    const { sdk, log } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    expect(client).toBeInstanceOf(HybridClient);
    expect(log.indexOf("initializeAppCheck")).toBeLessThan(log.indexOf("getAI"));
    expect((globalThis as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("refuses to connect without a project or without App Check", async () => {
    const { sdk } = fakeSdk();
    await expect(
      HybridClient.connect({ ...config, firebase: null }, async () => sdk),
    ).rejects.toMatchObject({ code: "config/missing" });
    __resetHybridClient();
    await expect(
      HybridClient.connect({ ...config, appCheck: {} }, async () => sdk),
    ).rejects.toMatchObject({ code: "config/app-check" });
  });

  it("returns the same client for repeated connects", async () => {
    const { sdk, log } = fakeSdk();
    const first = await HybridClient.connect(config, async () => sdk);
    const second = await HybridClient.connect(config, async () => sdk);
    expect(second).toBe(first);
    expect(log.filter((entry) => entry === "getAI")).toHaveLength(1);
  });
});

describe("HybridClient device model", () => {
  it("prepares both on-device modes inside the user gesture", async () => {
    const { sdk, models } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    await client.prepareDevice();
    const prepared = models.filter((model) => model.initializeCalls > 0).map((model) => model.mode).sort();
    expect(prepared).toEqual(["only_on_device", "prefer_on_device"]);
    expect(client.isDevicePrepared).toBe(true);
  });

  it("throws a translated error when the model cannot be prepared", async () => {
    const { sdk } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    const internals = client as unknown as {
      models: Map<string, { initializeDeviceModel: () => Promise<void> }>;
    };
    await client.generate({ prompt: "warm", mode: "prefer_on_device" });
    for (const model of internals.models.values()) {
      model.initializeDeviceModel = async () => {
        throw new Error("requires user activation");
      };
    }
    __resetHybridClient();
    const fresh = await HybridClient.connect(config, async () => sdk);
    const freshInternals = fresh as unknown as {
      models: Map<string, { initializeDeviceModel: () => Promise<void> }>;
    };
    for (const key of ["prefer_on_device", "only_on_device"]) {
      // A model object is created on demand; replace the method it will call.
      const anyModel = (
        fresh as unknown as { model: (mode: string) => { initializeDeviceModel: () => Promise<void> } }
      ).model(key);
      freshInternals.models.set(key, anyModel);
      anyModel.initializeDeviceModel = async () => {
        throw new Error("requires user activation");
      };
    }
    await expect(fresh.prepareDevice()).rejects.toMatchObject({ code: "device/prepare" });
    expect(fresh.isDevicePrepared).toBe(false);
  });

  it("prepares a device mode lazily on the first generation", async () => {
    const { sdk, models } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    const outcome = await client.generate({ prompt: "hi", mode: "only_on_device" });
    expect(outcome.source).toBe("on_device");
    expect(models.find((model) => model.mode === "only_on_device")?.initializeCalls).toBe(1);
  });
});

describe("HybridClient.generate", () => {
  it("caches one model per (mode, cloud model)", async () => {
    const { sdk, log, generateCalls } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    await client.generate({ prompt: "a", mode: "prefer_in_cloud", cloudModel: "gemini-3.5-flash-lite" });
    await client.generate({ prompt: "b", mode: "prefer_in_cloud", cloudModel: "gemini-3.5-flash-lite" });
    await client.generate({ prompt: "c", mode: "prefer_in_cloud", cloudModel: "gemini-3.5-pro" });
    expect(log.filter((entry) => entry === "getGenerativeModel:prefer_in_cloud")).toHaveLength(2);
    expect(generateCalls).toHaveLength(3);
  });

  it("reports the source the SDK returned, not the mode that was asked for", async () => {
    const { sdk, models } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    await client.generate({ prompt: "a", mode: "prefer_on_device" });
    const model = models.find((entry) => entry.mode === "prefer_on_device")!;
    model.onGenerate = () => ({
      text: JSON.stringify({ title: "Cloud answer", tldr: "", points: [], flags: [] }),
      inferenceSource: "in_cloud",
    });
    const outcome = await client.generate({ prompt: "b", mode: "prefer_on_device" });
    expect(outcome.source).toBe("in_cloud");
  });

  it("passes the abort signal and the per-request timeout", async () => {
    const { sdk, generateCalls } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    const controller = new AbortController();
    await client.generate({ prompt: "a", mode: "prefer_in_cloud", signal: controller.signal, timeoutMs: 1234 });
    const options = generateCalls[0].options as { signal?: AbortSignal; timeout?: number };
    expect(options.timeout).toBe(1234);
    expect(options.signal).toBe(controller.signal);
  });

  it("does not start a request that was already aborted", async () => {
    const { sdk, generateCalls } = fakeSdk();
    const client = await HybridClient.connect(config, async () => sdk);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.generate({ prompt: "a", mode: "prefer_in_cloud", signal: controller.signal }),
    ).rejects.toBeInstanceOf(HybridError);
    expect(generateCalls).toHaveLength(0);
  });

  it("translates SDK failures into something a reviewer can act on", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ code: "app-check/failed", message: "App Check token rejected" }, /App Check/],
      [{ code: "permission-denied", message: "PERMISSION_DENIED" }, /Firebase refused/],
      [{ code: "resource-exhausted", message: "429 quota exceeded" }, /quota/],
      [{ code: "not-found", message: "model gemini-x does not exist" }, /does not exist/],
      [{ code: "deadline-exceeded", message: "deadline exceeded" }, /did not answer in time/],
      [{ code: "aborted", message: "The operation was aborted", name: "AbortError" }, /stopped/i],
    ];
    for (const [error, expected] of cases) {
      __resetHybridClient();
      const { sdk, models } = fakeSdk();
      const client = await HybridClient.connect(config, async () => sdk);
      await client.generate({ prompt: "warm", mode: "prefer_in_cloud" });
      models[0].generateError = error;
      const thrown = await client
        .generate({ prompt: "x", mode: "prefer_in_cloud" })
        .then(() => null)
        .catch((value: unknown) => value);
      expect(thrown).toBeInstanceOf(HybridError);
      expect((thrown as HybridError).message).toMatch(expected);
      expect((thrown as HybridError).hint.length).toBeGreaterThan(10);
    }
  });
});
