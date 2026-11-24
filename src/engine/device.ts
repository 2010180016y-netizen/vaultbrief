import type { DeviceStatus } from "./types";

/**
 * Direct probe of Chrome's built-in AI, used only to *display* capability and
 * to decide whether a device route is possible. Inference itself always goes
 * through Firebase AI Logic — this never runs a prompt.
 *
 * Two shapes are probed: the current `LanguageModel` API (Chrome 139+) and the
 * older `ai.languageModel` shape, so a reviewer on a slightly older build still
 * sees an accurate status instead of "no Prompt API".
 */

type RawAvailability = string;

interface LanguageModelGlobal {
  availability: (options?: Record<string, unknown>) => Promise<RawAvailability>;
}

interface LegacyLanguageModelGlobal {
  capabilities: () => Promise<{ available?: RawAvailability }>;
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

function getLegacyLanguageModel(): LegacyLanguageModelGlobal | undefined {
  const scope = globalThis as unknown as {
    ai?: { languageModel?: LegacyLanguageModelGlobal };
  };
  const legacy = scope.ai?.languageModel;
  if (legacy && typeof legacy.capabilities === "function") return legacy;
  return undefined;
}

function normalise(raw: RawAvailability): DeviceStatus["availability"] {
  // Older builds used "readily" / "after-download" / "no".
  if (raw === "available" || raw === "readily") return "available";
  if (raw === "downloadable" || raw === "after-download") return "downloadable";
  if (raw === "downloading") return "downloading";
  if (raw === "unavailable" || raw === "no") return "unavailable";
  return "unknown";
}

function noteFor(availability: DeviceStatus["availability"]): string {
  switch (availability) {
    case "available":
      return "Gemini Nano is ready. Sensitive documents can be processed entirely on this device.";
    case "downloadable":
      return "Gemini Nano can be installed on this device (a few hundred MB, one time). Until it is, sensitive documents are masked or held back.";
    case "downloading":
      return "Gemini Nano is downloading. Progress is shown here and in each run.";
    case "unavailable":
      return "Gemini Nano is not available on this device or profile, so the private route cannot run here.";
    default:
      return "Could not read the on-device model status; VaultBrief treats it as unavailable rather than risking a cloud call.";
  }
}

export async function probeDevice(): Promise<DeviceStatus> {
  const api = getLanguageModel();
  if (api) {
    try {
      const availability = normalise(await api.availability(CREATE_OPTIONS));
      return { supported: true, availability, note: noteFor(availability) };
    } catch (error) {
      return {
        supported: true,
        availability: "unknown",
        note: `Could not read on-device model status: ${(error as Error).message}`,
      };
    }
  }

  const legacy = getLegacyLanguageModel();
  if (legacy) {
    try {
      const { available } = await legacy.capabilities();
      const availability = normalise(available ?? "unknown");
      return { supported: true, availability, note: noteFor(availability) };
    } catch {
      return { supported: true, availability: "unknown", note: noteFor("unknown") };
    }
  }

  return {
    supported: false,
    availability: "unavailable",
    note: "This browser has no built-in AI API. On-device inference needs Chrome 139+ on desktop (or the Prompt API flag).",
  };
}

export function isDeviceReady(status: DeviceStatus): boolean {
  return status.availability === "available";
}
