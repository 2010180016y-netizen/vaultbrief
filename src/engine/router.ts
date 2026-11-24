import { SENSITIVE_THRESHOLD } from "./sensitivity";
import type {
  DeviceStatus,
  InferenceModeName,
  InferenceSourceName,
  Policy,
  RoutePlan,
  ScanResult,
} from "./types";

/**
 * The routing brain.
 *
 * Two things decide where a document goes: how private it is, and how much
 * context it needs.
 *
 *   private            -> on-device only (never leaves the machine)
 *   public and short   -> prefer on-device (free, instant, works offline)
 *   public and long    -> cloud (bigger context, better long-form synthesis)
 *
 * One invariant is enforced here and nowhere else: text that contains
 * identifiers is never sent to the cloud unmasked. If masking is switched off,
 * the request is blocked instead of quietly leaking.
 */

/** Characters the on-device model handles comfortably in one pass. */
export const DEVICE_CHUNK_BUDGET = 1800;
/** Characters sent in one cloud request. */
export const CLOUD_CHUNK_BUDGET = 12000;
/** Above this, on-device needs map-reduce instead of a single pass. */
export const DEVICE_SINGLE_PASS_LIMIT = 2600;
/** Overlap repeated between consecutive on-device chunks. */
export const DEVICE_CHUNK_OVERLAP = 120;

export interface RouteInput {
  text: string;
  scan: ScanResult;
  policy: Policy;
  /** True when Chrome reports a usable on-device model right now. */
  deviceReady: boolean;
  /** The raw availability value, used only to word the guidance. */
  deviceAvailability?: DeviceStatus["availability"];
  /** User setting: "mask identifiers before anything is sent to the cloud". */
  maskingAllowed: boolean;
  threshold?: number;
}

export interface RouteOutcome extends RoutePlan {
  /** Set when the request must not be sent anywhere. */
  blocked: boolean;
  sensitive: boolean;
}

export function clampThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SENSITIVE_THRESHOLD;
  return Math.min(100, Math.max(1, Math.round(value)));
}

function deviceAdvice(availability: DeviceStatus["availability"] | undefined): string {
  switch (availability) {
    case "downloadable":
      return "Gemini Nano can be installed on this device: press “Download Gemini Nano” in the device panel (a few hundred MB, one time) to bring the device-only route online.";
    case "downloading":
      return "Gemini Nano is still downloading; the private route opens as soon as it finishes.";
    case "unavailable":
      return "This browser has no on-device model (Chrome 139+ desktop with the Prompt API), so the private route is not available here.";
    case "unknown":
      return "The on-device model status could not be read; VaultBrief assumes it is unavailable rather than risking a cloud call.";
    default:
      return "Gemini Nano is not available in this browser, so on-device inference cannot run here.";
  }
}

export function decideRoute(input: RouteInput): RouteOutcome {
  const { text, scan, policy, deviceReady, maskingAllowed } = input;
  const threshold = clampThreshold(input.threshold);
  const sensitive = scan.score >= threshold;
  const length = text.trim().length;
  const notes: string[] = [];

  const blocked = (reason: string, extra: string[]): RouteOutcome => ({
    policy,
    mode: "only_on_device",
    expectedSource: "on_device",
    redactBeforeSending: false,
    deviceReady,
    chunked: false,
    estimatedChunks: 0,
    reason,
    notes: extra,
    blocked: true,
    sensitive,
  });

  if (length === 0) {
    return blocked("There is no text to brief yet.", [
      "Paste a document, drop a .txt/.md file, or pick one of the samples.",
    ]);
  }

  if (!deviceReady) {
    notes.push(deviceAdvice(input.deviceAvailability));
  }

  const residualNote = () => {
    if (scan.residual.length === 0) return;
    notes.push(
      `A masked copy still reveals ${scan.residual.join(", ")} — those are topics, not identifiers, so they cannot be replaced without destroying the document.`,
    );
  };

  const cloudRoute = (
    mode: InferenceModeName,
    reason: string,
    redactBeforeSending: boolean,
  ): RouteOutcome => {
    const chunked = length > CLOUD_CHUNK_BUDGET;
    if (redactBeforeSending) {
      notes.push(
        scan.redactable > 0
          ? `${scan.redactable} identifier${scan.redactable === 1 ? "" : "s"} are replaced with typed placeholders before the request leaves the device.`
          : "Masking is on, but this document contains no maskable identifier — only topic words.",
      );
      residualNote();
    }
    if (chunked) {
      notes.push("Long documents are sent in chunks and merged by the cloud model.");
    }
    return {
      policy,
      mode,
      expectedSource: "in_cloud",
      redactBeforeSending,
      deviceReady,
      chunked,
      estimatedChunks: chunked ? Math.ceil(length / CLOUD_CHUNK_BUDGET) : 1,
      reason,
      notes,
      blocked: false,
      sensitive,
    };
  };

  const deviceRoute = (
    mode: InferenceModeName,
    reason: string,
    expectedSource: InferenceSourceName,
  ): RouteOutcome => {
    const singlePass = length <= DEVICE_SINGLE_PASS_LIMIT;
    const chunked = length > DEVICE_CHUNK_BUDGET;
    const estimatedChunks = chunked
      ? Math.ceil(length / Math.max(1, DEVICE_CHUNK_BUDGET - DEVICE_CHUNK_OVERLAP))
      : 1;
    if (chunked) {
      notes.push(
        `The on-device window holds roughly ${DEVICE_CHUNK_BUDGET.toLocaleString()} characters, so this document is briefed map-reduce style in ${estimatedChunks} passes that never leave the device. You can stop it between passes.`,
      );
    }
    if (!singlePass && !deviceReady) {
      notes.push("Nothing was sent: device-only policy with no local model.");
    }
    if (expectedSource === "in_cloud" && !deviceReady) {
      notes.push("No local model is ready, so the SDK will answer this one in the cloud.");
    }
    return {
      policy,
      mode,
      expectedSource,
      redactBeforeSending: false,
      deviceReady,
      chunked,
      estimatedChunks,
      reason,
      notes,
      blocked: false,
      sensitive,
    };
  };

  if (policy === "device_only") {
    if (!deviceReady) {
      return blocked("Device-only policy is on, but this browser has no on-device model.", [
        deviceAdvice(input.deviceAvailability),
        "VaultBrief will not send this document to the cloud under a device-only policy.",
      ]);
    }
    return deviceRoute("only_on_device", "Device-only policy: every character stays on this machine.", "on_device");
  }

  if (policy === "cloud_quality") {
    if (sensitive && !maskingAllowed) {
      return blocked(
        `This document scores ${scan.score}/100 on the sensitivity scan and masking is turned off.`,
        [
          "Turn masking on to send a placeholder-only copy to the cloud, or switch to Auto to keep it on-device.",
          "VaultBrief never sends identified text to the cloud.",
        ],
      );
    }
    return cloudRoute(
      "prefer_in_cloud",
      sensitive
        ? "Cloud quality policy with the privacy boundary on: only the masked copy leaves the device."
        : "Cloud quality policy: the most capable model is used for this public document.",
      sensitive,
    );
  }

  // ---- Auto ---------------------------------------------------------------
  if (sensitive) {
    if (deviceReady) {
      return deviceRoute(
        "only_on_device",
        `Sensitive document (${scan.score}/100) → device-only inference. Not one character is sent to Google.`,
        "on_device",
      );
    }
    if (!maskingAllowed) {
      return blocked(
        `Sensitive document (${scan.score}/100) and no on-device model is available, so it is held back.`,
        [
          "Turn masking on to send a placeholder-only copy to the cloud.",
          "Nothing was uploaded for this document.",
        ],
      );
    }
    if (scan.redactable === 0) {
      // Masking would replace nothing: the copy is the original document. Auto
      // does not send that to the cloud; the user can still choose Cloud quality.
      return blocked(
        `Sensitive document (${scan.score}/100), no local model, and no identifier that masking could remove.`,
        [
          `The scan reacted to ${scan.residual.join(", ") || "sensitive wording"}, which cannot be replaced without destroying the text.`,
          "Choose Cloud quality to send it anyway, or Enable the on-device model to keep it here.",
        ],
      );
    }
    return cloudRoute(
      "only_in_cloud",
      `Sensitive document (${scan.score}/100) with no local model → sent only after ${scan.redactable} identifier${scan.redactable === 1 ? "" : "s"} are masked.`,
      true,
    );
  }

  if (length > DEVICE_SINGLE_PASS_LIMIT) {
    return cloudRoute(
      "prefer_in_cloud",
      `Public document (${scan.score}/100) and ${length.toLocaleString()} characters long → cloud model for long-form synthesis.`,
      false,
    );
  }

  return deviceRoute(
    "prefer_on_device",
    `Public document (${scan.score}/100) and short → on-device first, cloud only if there is no local model.`,
    deviceReady ? "on_device" : "in_cloud",
  );
}
