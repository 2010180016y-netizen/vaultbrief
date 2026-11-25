import { probeDevice } from "./device";
import { DEFAULT_WEBLLM_MODEL, probeWebGpu, type WebLlmModelId } from "./webllm";
import type { EnginePreference } from "./config";
import type { DeviceStatus } from "./types";

/**
 * One place that decides which on-device engine the private route will use.
 *
 * Preference order in `auto`: Chrome's Gemini Nano (already installed, fastest)
 * → WebLLM on WebGPU (a downloaded open model) → none. `off` is not offered:
 * the private route simply reports that it is unavailable, and the router's
 * existing rules still prevent an unmasked cloud call.
 */

export interface WebGpuProbe {
  supported: boolean;
  adapter: boolean;
  note: string;
}

export interface DeviceRuntime {
  /** The status the router sees. */
  status: DeviceStatus;
  promptApi: DeviceStatus;
  webgpu: WebGpuProbe;
  /** Engine that will serve the private route right now. */
  engine: "nano" | "webllm" | "none";
  modelId: WebLlmModelId | string;
  webllmReady: boolean;
  note: string;
}

export interface RuntimeOptions {
  preference: EnginePreference;
  modelId?: string;
  webllmReady?: boolean;
}

function nanoStatus(promptApi: DeviceStatus): DeviceStatus {
  return { ...promptApi, engine: promptApi.availability === "available" ? "nano" : "none" };
}

export async function probeRuntime(options: RuntimeOptions): Promise<DeviceRuntime> {
  const [promptApi, webgpu] = await Promise.all([probeDevice(), probeWebGpu()]);
  const modelId = options.modelId || DEFAULT_WEBLLM_MODEL;
  const webllmReady = options.webllmReady ?? false;
  const webllmStatus: DeviceStatus = {
    supported: webgpu.adapter,
    availability: webllmReady ? "available" : webgpu.adapter ? "downloadable" : "unavailable",
    note: webgpu.adapter
      ? webllmReady
        ? `WebLLM is loaded (${modelId}) and runs entirely on this GPU.`
        : `WebLLM can run here: the model (${modelId}) is downloaded once, then works offline.`
      : webgpu.note,
    engine: webllmReady ? "webllm" : "none",
  };

  const prefer = options.preference;
  let chosen: DeviceRuntime["engine"] = "none";
  let status: DeviceStatus;

  if (prefer === "nano") {
    status = nanoStatus(promptApi);
    chosen = status.availability === "available" ? "nano" : "none";
  } else if (prefer === "webllm") {
    status = webllmStatus;
    chosen = webllmReady ? "webllm" : "none";
  } else if (promptApi.availability === "available") {
    status = nanoStatus(promptApi);
    chosen = "nano";
  } else if (webgpu.adapter) {
    status = webllmStatus;
    chosen = webllmReady ? "webllm" : "none";
  } else {
    status = {
      supported: false,
      availability: "unavailable",
      note: `${promptApi.note} ${webgpu.note}`.trim(),
      engine: "none",
    };
  }

  const note =
    chosen === "nano"
      ? "Private route: Gemini Nano (Chrome built-in)."
      : chosen === "webllm"
        ? `Private route: WebLLM ${modelId}.`
        : status.availability === "downloadable"
          ? "The private route is one download away — press “Download device model”."
          : "No on-device model on this browser; sensitive documents are masked or held back.";

  return { status, promptApi, webgpu, engine: chosen, modelId, webllmReady, note };
}
