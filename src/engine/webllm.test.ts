import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WEBLLM_MODEL,
  WEBLLM_MODELS,
  WebLlmEngine,
  WebLlmError,
  type WebLlmLoader,
} from "./webllm";

/**
 * The WebGPU path cannot run in Node, so the engine is exercised against a fake
 * `MLCEngineInterface` that records what the adapter asked for. The model ids
 * themselves are checked against the installed package's own catalogue in the
 * last block — that part runs for real.
 */

interface Recorded {
  request?: Record<string, unknown>;
  interrupted: number;
  unloaded: boolean;
  progress: unknown[];
}

function fakeLoader(behaviour: { text?: string; error?: Error } = {}) {
  const recorded: Recorded = { interrupted: 0, unloaded: false, progress: [] };
  const loader: WebLlmLoader = async () => ({
    CreateMLCEngine: async (_modelId: string, config?: Record<string, unknown>) => {
      const callback = config?.initProgressCallback as ((report: unknown) => void) | undefined;
      recorded.progress.push(config?.initProgressCallback ? "registered" : "missing");
      callback?.({ progress: 0.4, text: "Fetching model", timeElapsed: 1 });
      callback?.({ progress: 1, text: "Ready", timeElapsed: 2 });
      if (behaviour.error) throw behaviour.error;
      return {
        chat: {
          completions: {
            create: async (request: Record<string, unknown>) => {
              recorded.request = request;
              return {
                choices: [{ message: { role: "assistant", content: behaviour.text ?? '{"title":"T","tldr":"x","points":[],"flags":[]}' } }],
                usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
              };
            },
          },
        },
        interruptGenerate: () => {
          recorded.interrupted += 1;
        },
        unload: async () => {
          recorded.unloaded = true;
        },
      } as never;
    },
  });
  return { loader, recorded };
}

describe("WebLlmEngine", () => {
  it("loads the model with a progress callback and reports readiness", async () => {
    const { loader, recorded } = fakeLoader();
    const engine = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, loader);
    const progress: number[] = [];
    expect(engine.ready).toBe(false);
    await engine.prepare((value) => progress.push(value));
    expect(engine.ready).toBe(true);
    expect(progress).toEqual([0.4, 1]);
    expect(recorded.progress).toEqual(["registered"]);
  });

  it("asks for a non-streaming completion with a bounded output", async () => {
    const { loader, recorded } = fakeLoader({ text: "hello" });
    const engine = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, loader);
    await engine.prepare();
    const outcome = await engine.generate({ prompt: "BRIEF THIS" });
    expect(outcome.text).toBe("hello");
    expect(outcome.source).toBe("on_device");
    expect(outcome.model).toBe(DEFAULT_WEBLLM_MODEL);
    expect(outcome.usage).toEqual({ promptTokens: 120, completionTokens: 45 });
    const request = recorded.request!;
    expect(request.stream).toBe(false);
    expect(request.temperature).toBeCloseTo(0.2);
    expect(request.max_tokens).toBe(900);
    const messages = request.messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "BRIEF THIS" });
  });

  it("interrupts generation when the run is cancelled", async () => {
    const { loader, recorded } = fakeLoader();
    const engine = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, loader);
    await engine.prepare();

    const controller = new AbortController();
    // A completion that only settles when interrupted.
    const slow = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, async () => ({
      CreateMLCEngine: async () =>
        ({
          chat: {
            completions: {
              create: () =>
                new Promise((_resolve, reject) => {
                  setTimeout(() => reject(new Error("interrupted")), 30);
                }),
            },
          },
          interruptGenerate: () => {
            recorded.interrupted += 1;
          },
          unload: async () => {},
        }) as never,
    }));
    await slow.prepare();
    const pending = slow.generate({ prompt: "x", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "request/aborted" });
    expect(recorded.interrupted).toBe(1);
    expect(engine.ready).toBe(true);
  });

  it("refuses to generate before the model is downloaded", async () => {
    const { loader } = fakeLoader();
    const engine = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, loader);
    await expect(engine.generate({ prompt: "x" })).rejects.toBeInstanceOf(WebLlmError);
    await expect(engine.generate({ prompt: "x" })).rejects.toMatchObject({ code: "device/not-ready" });
  });

  it("maps GPU and download failures to actionable hints", async () => {
    const webgpu = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, fakeLoader({ error: new Error("WebGPU adapter not found") }).loader);
    await expect(webgpu.prepare()).rejects.toMatchObject({ code: "device/webgpu" });

    const oom = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, fakeLoader({ error: new Error("out of memory") }).loader);
    await expect(oom.prepare()).rejects.toMatchObject({ code: "device/oom" });

    const network = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, fakeLoader({ error: new Error("fetch failed 404") }).loader);
    await expect(network.prepare()).rejects.toMatchObject({ code: "device/download" });
  });

  it("unloads the model and frees the reference", async () => {
    const { loader, recorded } = fakeLoader();
    const engine = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, loader);
    await engine.prepare();
    await engine.dispose();
    expect(recorded.unloaded).toBe(true);
    expect(engine.ready).toBe(false);
  });

  it("reports no WebGPU in a Node test process instead of throwing", async () => {
    const { probeWebGpu } = await import("./webllm");
    const status = await probeWebGpu();
    expect(status.supported).toBe(false);
    expect(status.note).toMatch(/WebGPU/);
  });

  it("every offered model id exists in the installed web-llm catalogue", async () => {
    const lib = (await import("@mlc-ai/web-llm")) as unknown as {
      prebuiltAppConfig: { model_list: { model_id: string; vram_required_MB?: number }[] };
    };
    const ids = new Set(lib.prebuiltAppConfig.model_list.map((model) => model.model_id));
    for (const model of WEBLLM_MODELS) {
      expect(ids.has(model.id), model.id).toBe(true);
      const record = lib.prebuiltAppConfig.model_list.find((m) => m.model_id === model.id)!;
      expect(model.sizeMb).toBe(Math.round(record.vram_required_MB ?? 0));
    }
    expect(DEFAULT_WEBLLM_MODEL).toBe(WEBLLM_MODELS[0].id);
  });
});

describe("abort bookkeeping", () => {
  it("marks the engine idle again after an interrupted run", async () => {
    const { loader } = fakeLoader();
    const engine = new WebLlmEngine(DEFAULT_WEBLLM_MODEL, loader);
    await engine.prepare();
    engine.abort();
    // A later run must not be mistaken for the cancelled one.
    const outcome = await engine.generate({ prompt: "again" });
    expect(outcome.source).toBe("on_device");
    vi.restoreAllMocks();
  });
});
