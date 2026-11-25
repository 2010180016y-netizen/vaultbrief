import type { InitProgressReport, MLCEngineInterface } from "@mlc-ai/web-llm";

/**
 * MLC's WebLLM as the on-device engine.
 *
 * Gemini Nano (Chrome's Prompt API) is the fastest device route, but it only
 * exists in Chrome 139+ desktop with the model installed. WebLLM runs a
 * quantised open model on WebGPU, which means the private route also works in
 * browsers without Nano — and the weights are fetched once and cached by the
 * browser, after which generation needs no network at all.
 *
 * The document is never part of a network request here: the only traffic is
 * the one-time model download, which the UI asks for explicitly.
 */

export const WEBLLM_MODELS = [
  {
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 0.5B (compact)",
    /** web-llm's own vram_required_MB for this prebuilt record. */
    sizeMb: 945,
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 1B (balanced)",
    sizeMb: 879,
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 1.5B (best quality)",
    sizeMb: 1630,
  },
] as const;

export type WebLlmModelId = (typeof WEBLLM_MODELS)[number]["id"];
export const DEFAULT_WEBLLM_MODEL: WebLlmModelId = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

const SYSTEM_PROMPT =
  "You write very short, factual briefs as strict JSON. Never invent facts that are not in the text.";

export interface OnDeviceRequest {
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OnDeviceOutcome {
  text: string;
  source: "on_device";
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface OnDeviceEngine {
  readonly id: string;
  readonly label: string;
  readonly ready: boolean;
  prepare(onProgress?: (progress: number, message: string) => void): Promise<void>;
  generate(request: OnDeviceRequest): Promise<OnDeviceOutcome>;
  abort(): void;
  dispose(): Promise<void>;
}

export class WebLlmError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WebLlmError";
  }
}

type CreateEngine = (modelId: string, config?: Record<string, unknown>) => Promise<MLCEngineInterface>;
export type WebLlmLoader = () => Promise<{ CreateMLCEngine: CreateEngine }>;

export async function loadWebLlm(): Promise<{ CreateMLCEngine: CreateEngine }> {
  const lib = await import("@mlc-ai/web-llm");
  return { CreateMLCEngine: lib.CreateMLCEngine as unknown as CreateEngine };
}

/** True when this browser exposes WebGPU at all (the adapter check is separate). */
export function webgpuSupported(): boolean {
  const nav = globalThis.navigator as (Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }) | undefined;
  return typeof nav?.gpu?.requestAdapter === "function";
}

export async function probeWebGpu(): Promise<{ supported: boolean; adapter: boolean; note: string }> {
  if (!webgpuSupported()) {
    return {
      supported: false,
      adapter: false,
      note: "This browser has no WebGPU, so WebLLM cannot run here. Chrome 121+ desktop or Edge with WebGPU enabled is required.",
    };
  }
  try {
    const adapter = await (globalThis.navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter();
    return adapter
      ? { supported: true, adapter: true, note: "WebGPU is available: WebLLM can run a model on this device." }
      : {
          supported: true,
          adapter: false,
          note: "WebGPU is exposed but no adapter is available (common in headless browsers and on blocklisted GPUs).",
        };
  } catch (error) {
    return { supported: true, adapter: false, note: `WebGPU adapter request failed: ${(error as Error).message}` };
  }
}

export class WebLlmEngine implements OnDeviceEngine {
  readonly id = "webllm";
  readonly label = "WebLLM (WebGPU)";
  private engine: MLCEngineInterface | null = null;
  private loading: Promise<void> | null = null;
  private aborted = false;

  constructor(
    readonly modelId: string = DEFAULT_WEBLLM_MODEL,
    private readonly loader: WebLlmLoader = loadWebLlm,
    private readonly createEngine?: CreateEngine,
  ) {}

  get ready(): boolean {
    return this.engine !== null;
  }

  async prepare(onProgress?: (progress: number, message: string) => void): Promise<void> {
    if (this.engine) return;
    if (this.loading) return this.loading;
    const create = this.createEngine ?? (await this.loader()).CreateMLCEngine;
    this.loading = (async () => {
      try {
        this.engine = await create(this.modelId, {
          initProgressCallback: (report: InitProgressReport) => {
            onProgress?.(report.progress ?? 0, report.text ?? "loading model");
          },
        });
      } catch (error) {
        throw this.toError(error);
      }
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async generate({ prompt, signal, timeoutMs = 120_000 }: OnDeviceRequest): Promise<OnDeviceOutcome> {
    const engine = this.engine;
    if (!engine) {
      throw new WebLlmError(
        "The on-device model is not loaded yet.",
        "Press “Download device model” first: the weights are a one-time download and stay in the browser cache.",
        "device/not-ready",
      );
    }
    if (signal?.aborted) {
      throw new WebLlmError("The request was stopped before it started.", "Nothing was generated.", "request/aborted");
    }

    this.aborted = false;
    const onAbort = () => {
      this.aborted = true;
      engine.interruptGenerate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          engine.interruptGenerate();
          reject(
            new WebLlmError(
              "The on-device model did not answer in time.",
              "Try again with a shorter document or the compact model.",
              "request/timeout",
            ),
          );
        }, timeoutMs);
      });

      const request = engine.chat.completions.create({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 900,
        stream: false,
      });

      const reply = await Promise.race([request, timeout]);
      if ("choices" in reply) {
        const text = reply.choices?.[0]?.message?.content ?? "";
        const usage = reply.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        return {
          text,
          source: "on_device",
          model: this.modelId,
          usage: {
            promptTokens: usage?.prompt_tokens ?? 0,
            completionTokens: usage?.completion_tokens ?? 0,
          },
        };
      }
      throw new WebLlmError("Streaming was requested by mistake.", "VaultBrief uses non-streaming generation.", "sdk/contract");
    } catch (error) {
      if (this.aborted || signal?.aborted) {
        throw new WebLlmError("The request was stopped.", "Generation was interrupted; nothing further was sent.", "request/aborted");
      }
      throw error instanceof WebLlmError ? error : this.toError(error);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  abort(): void {
    this.aborted = true;
    this.engine?.interruptGenerate();
  }

  async dispose(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    await engine?.unload?.();
  }

  private toError(error: unknown): WebLlmError {
    const message = (error as Error)?.message ?? String(error);
    if (/webgpu|adapter|gpu/i.test(message)) {
      return new WebLlmError(
        "WebGPU could not start the model.",
        "Use a desktop Chrome or Edge build with WebGPU enabled, and check that hardware acceleration is on.",
        "device/webgpu",
      );
    }
    if (/memory|oom|out of|device lost/i.test(message)) {
      return new WebLlmError(
        "The GPU ran out of memory loading the model.",
        "Close other GPU-heavy tabs or pick the compact 0.5B model.",
        "device/oom",
      );
    }
    if (/fetch|network|404|cors/i.test(message)) {
      return new WebLlmError(
        "The model weights could not be downloaded.",
        "The first load fetches the model from Hugging Face; check the network and try again.",
        "device/download",
      );
    }
    return new WebLlmError(message || "The on-device engine failed.", "Try the compact model, or use Gemini Nano.", "device/unknown");
  }
}
