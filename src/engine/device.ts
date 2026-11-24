import type { DeviceStatus } from "./types";

/**
 * Direct probe of Chrome's Prompt API, used only to *display* capability and to
 * decide whether a device route is possible. Inference itself always goes
 * through Firebase AI Logic — this never runs a prompt.
 */

interface LanguageModelGlobal {
  availability: (options?: Record<string, unknown>) => Promise<string>;
}

const CREATE_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

function getLanguageModel(): LanguageModelGlobal | undefined {
  const scope = globalThis as unknown as { LanguageModel?: LanguageModelGlobal };
  if (scope.LanguageModel && typeof scope.LanguageModel.availability === "function") {
    return scope.LanguageModel;
  }
  return undefined;
}

export async function probeDevice(): Promise<DeviceStatus> {
  const api = getLanguageModel();
  if (!api) {
    return {
      supported: false,
      availability: "unavailable",
      note: "This browser has no Prompt API. On-device inference needs Chrome 139+ on desktop.",
    };
  }
  try {
    const raw = await api.availability(CREATE_OPTIONS);
    const availability =
      raw === "available" || raw === "downloadable" || raw === "downloading" || raw === "unavailable"
        ? raw
        : "unknown";
    const note =
      availability === "available"
        ? "Gemini Nano is ready. Sensitive documents can be processed entirely on this device."
        : availability === "downloadable"
          ? "Gemini Nano can be downloaded (a few hundred MB, one time). Until then, sensitive documents are held back."
          : availability === "downloading"
            ? "Gemini Nano is downloading. Progress is shown when a brief starts."
            : "Gemini Nano is not available on this device or profile.";
    return { supported: true, availability, note };
  } catch (error) {
    return {
      supported: true,
      availability: "unknown",
      note: `Could not read on-device model status: ${(error as Error).message}`,
    };
  }
}

export function isDeviceReady(status: DeviceStatus): boolean {
  return status.availability === "available";
}
