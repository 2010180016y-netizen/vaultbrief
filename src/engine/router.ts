import { SENSITIVE_THRESHOLD } from "./sensitivity";
import type { InferenceModeName, InferenceSourceName, Policy, RoutePlan, ScanResult } from "./types";

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

export interface RouteInput {
  text: string;
  scan: ScanResult;
  policy: Policy;
  /** True when Chrome reports a usable on-device model right now. */
  deviceReady: boolean;
  /** User setting: "mask identifiers before anything is sent to the cloud". */
  maskingAllowed: boolean;
  threshold?: number;
}

export interface RouteOutcome extends RoutePlan {
  /** Set when the request must not be sent anywhere. */
  blocked: boolean;
  sensitive: boolean;
}

export function decideRoute(input: RouteInput): RouteOutcome {
  const { text, scan, policy, deviceReady, maskingAllowed } = input;
  const threshold = input.threshold ?? SENSITIVE_THRESHOLD;
  const sensitive = scan.score >= threshold;
  const length = text.length;
  const notes: string[] = [];

  if (!deviceReady) {
    notes.push("Gemini Nano is not available in this browser, so on-device inference cannot run here.");
  }

  const cloudRoute = (
    mode: InferenceModeName,
    reason: string,
    redactBeforeSending: boolean,
  ): RouteOutcome => {
    const chunked = length > CLOUD_CHUNK_BUDGET;
    if (redactBeforeSending) {
      notes.push(`${scan.redactable} identifier${scan.redactable === 1 ? "" : "s"} are replaced with typed placeholders before the request leaves the device.`);
    }
    if (chunked) {
      notes.push("Long documents are sent in chunks and merged by the cloud model.");
    }
    return {
      policy,
      mode,
      expectedSource: "in_cloud",
      redactBeforeSending,
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
    const estimatedChunks = chunked ? Math.ceil(length / DEVICE_CHUNK_BUDGET) : 1;
    if (chunked) {
      notes.push(`The on-device window holds roughly ${DEVICE_CHUNK_BUDGET.toLocaleString()} characters, so this document is briefed map-reduce style in ${estimatedChunks} passes that never leave the device.`);
    }
    if (!singlePass && !deviceReady) {
      notes.push("Nothing was sent: device-only policy with no local model.");
    }
    return {
      policy,
      mode,
      expectedSource,
      redactBeforeSending: false,
      chunked,
      estimatedChunks,
      reason,
      notes,
      blocked: false,
      sensitive,
    };
  };

  const blocked = (reason: string, notes: string[]): RouteOutcome => ({
    policy,
    mode: "only_on_device",
    expectedSource: "on_device",
    redactBeforeSending: false,
    chunked: false,
    estimatedChunks: 0,
    reason,
    notes,
    blocked: true,
    sensitive,
  });

  if (policy === "device_only") {
    if (!deviceReady) {
      return blocked(
        "Device-only policy is on, but this browser has no on-device model.",
        [
          "Enable Chrome's Prompt API (Chrome 139+ desktop) or switch the policy to Auto.",
          "VaultBrief will not send this document to the cloud under a device-only policy.",
        ],
      );
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
