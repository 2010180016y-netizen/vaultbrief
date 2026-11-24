import { estimateTokens, splitText } from "./chunk";
import { extractiveBrief } from "./demo";
import { HybridClient, HybridError } from "./hybrid";
import { cloudPrompt, mergePrompt, onDevicePrompt, parseBrief } from "./prompt";
import {
  CLOUD_CHUNK_BUDGET,
  DEVICE_CHUNK_BUDGET,
  DEVICE_CHUNK_OVERLAP,
  decideRoute,
  type RouteOutcome,
} from "./router";
import { redact, scan } from "./sensitivity";
import type {
  DeviceStatus,
  InferenceSourceName,
  Policy,
  Progress,
  RunReceipt,
  RunResult,
  ScanResult,
} from "./types";

export interface RunInput {
  text: string;
  policy: Policy;
  /** "Mask identifiers before anything is sent to the cloud". */
  maskingAllowed: boolean;
  device: DeviceStatus;
  /** null when no Firebase project is configured: the run is simulated. */
  client: HybridClient | null;
  cloudModel: string;
  /** Overrides the sensitivity threshold, e.g. from Remote Config. */
  threshold?: number;
  /** Stops the run between passes and cancels the request in flight. */
  signal?: AbortSignal;
  /** Per-request timeout, milliseconds. */
  timeoutMs?: number;
  onProgress?: (progress: Progress) => void;
  titleFallback?: string;
}

export type RunOutcome =
  | { status: "ok"; result: RunResult; scan: ScanResult; plan: RouteOutcome; simulated: boolean }
  | { status: "blocked"; plan: RouteOutcome; scan: ScanResult; reason: string }
  | { status: "cancelled"; plan: RouteOutcome; scan: ScanResult; reason: string }
  | { status: "error"; plan: RouteOutcome; scan: ScanResult; error: string; hint: string };

/** Internal signal for "the user pressed Stop"; never shown to the user as an error. */
class CancelledError extends Error {
  constructor() {
    super("The run was stopped.");
    this.name = "CancelledError";
  }
}

function uid(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function planFor(
  input: Pick<RunInput, "text" | "policy" | "maskingAllowed" | "device" | "threshold">,
  scanResult?: ScanResult,
) {
  const result = scanResult ?? scan(input.text);
  const deviceReady = input.device.availability === "available";
  return decideRoute({
    text: input.text,
    scan: result,
    policy: input.policy,
    deviceReady,
    deviceAvailability: input.device.availability,
    maskingAllowed: input.maskingAllowed,
    threshold: input.threshold,
  });
}

/**
 * Groups summary parts so that one merge prompt stays inside the budget. A part
 * that is larger than the whole budget on its own is truncated: merging it
 * unchanged would overflow the on-device window and fail the run.
 */
export function groupForMerge(parts: string[], maxChars: number): string[][] {
  const limit = Math.max(256, maxChars);
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;

  for (const part of parts) {
    const cost = part.length + 24;
    if (cost >= limit) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
        size = 0;
      }
      groups.push([part.slice(0, limit - 40)]);
      continue;
    }
    if (current.length > 0 && size + cost > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(part);
    size += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export async function runBrief(input: RunInput): Promise<RunOutcome> {
  const started = performance.now();
  const progress = input.onProgress ?? (() => {});
  const signal = input.signal;
  const trimmed = input.text.trim();

  progress({ phase: "scan", message: "Scanning for identifiers on this device…" });
  const scanResult = scan(trimmed);
  const plan = planFor(input, scanResult);

  if (plan.blocked) {
    return { status: "blocked", plan, scan: scanResult, reason: plan.reason };
  }

  const simulated = input.client === null;
  const plannedSource: InferenceSourceName = plan.expectedSource;
  const cloudModel = input.cloudModel.trim() || "gemini-3.5-flash-lite";
  const onDevice = plannedSource === "on_device";
  const budget = onDevice ? DEVICE_CHUNK_BUDGET : CLOUD_CHUNK_BUDGET;
  const promptFor = onDevice ? onDevicePrompt : cloudPrompt;

  progress({ phase: "prepare", message: "Preparing the text for the chosen route…" });
  const working = plan.redactBeforeSending ? redact(trimmed).text : trimmed;
  const chunks = splitText(working, { budget, overlap: onDevice ? DEVICE_CHUNK_OVERLAP : 0 });

  const notes: string[] = [];
  let cloudChars = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let actualSource: InferenceSourceName = plannedSource;
  let cloudPasses = 0;
  let devicePasses = 0;
  const partials: string[] = [];
  let finalRaw = "";

  const call = async (
    prompt: string,
    documentText: string,
  ): Promise<{ text: string; source: InferenceSourceName }> => {
    if (signal?.aborted) throw new CancelledError();
    const outcome = simulated
      ? await simulateCall(prompt, documentText, plannedSource, signal)
      : await input.client!.generate({
          prompt,
          mode: plan.mode,
          cloudModel,
          signal,
          timeoutMs: input.timeoutMs,
        });
    tokensIn += estimateTokens(prompt);
    tokensOut += estimateTokens(outcome.text);
    return outcome;
  };

  const cancelOutcome = (): RunOutcome => ({
    status: "cancelled",
    plan,
    scan: scanResult,
    reason:
      chunks.length > 1 && partials.length >= chunks.length
        ? "Stopped while merging the parts into one brief. Nothing further was sent."
        : `Stopped after ${partials.length} of ${chunks.length} pass${chunks.length === 1 ? "" : "es"}. Nothing further was sent.`,
  });

  /** One merge request: simulated runs merge the part briefs locally, real runs ask the model. */
  const callMerge = async (group: string[]): Promise<{ text: string; source: InferenceSourceName }> => {
    if (signal?.aborted) throw new CancelledError();
    const prompt = mergePrompt(group);
    tokensIn += estimateTokens(prompt);
    if (simulated) {
      await sleep(140 + Math.min(320, group.length * 60), signal);
      const text = mergeSimulated(group);
      tokensOut += estimateTokens(text);
      return { text, source: plannedSource };
    }
    const outcome = await input.client!.generate({
      prompt,
      mode: plan.mode,
      cloudModel,
      signal,
      timeoutMs: input.timeoutMs,
    });
    tokensOut += estimateTokens(outcome.text);
    return outcome;
  };

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      progress({
        phase: "chunk",
        message:
          chunks.length === 1
            ? onDevice
              ? "Gemini Nano is reading on this device…"
              : "A cloud model is reading the document…"
            : `Briefing part ${i + 1} of ${chunks.length}…`,
        completed: i,
        total: chunks.length,
      });

      const outcome = await call(promptFor(chunk), chunk);
      actualSource = outcome.source;
      if (outcome.source === "in_cloud") {
        cloudChars += chunk.length;
        cloudPasses += 1;
      } else {
        devicePasses += 1;
      }
      partials.push(outcome.text);
      finalRaw = outcome.text;
    }

    if (chunks.length > 1) {
      progress({ phase: "merge", message: "Merging the parts into one brief…" });
      // Merge hierarchically so that neither the on-device window nor the cloud
      // request budget overflows when a document produced many parts.
      let current = partials;
      const mergeBudget = Math.max(1600, budget - 400);
      for (let round = 0; round < 6 && current.length > 1; round++) {
        const groups = groupForMerge(current, mergeBudget);
        const next: string[] = [];
        for (const group of groups) {
          if (signal?.aborted) throw new CancelledError();
          const outcome = await callMerge(group);
          actualSource = outcome.source;
          next.push(outcome.text);
        }
        current = next;
        progress({
          phase: "merge",
          message: `Merging ${current.length} intermediate brief${current.length === 1 ? "" : "s"}…`,
        });
      }
      finalRaw = current[0] ?? partials[partials.length - 1] ?? "";
    }
  } catch (error) {
    const aborted =
      error instanceof CancelledError ||
      (error instanceof HybridError && error.code === "request/aborted") ||
      (error as { name?: string })?.name === "AbortError" ||
      signal?.aborted === true;
    if (aborted) return cancelOutcome();
    const hybridError = error instanceof HybridError ? error : null;
    return {
      status: "error",
      plan,
      scan: scanResult,
      error: hybridError ? hybridError.message : (error as Error).message,
      hint:
        hybridError?.hint ??
        "The request failed before a brief was produced. Nothing is retried automatically.",
    };
  }

  const brief = parseBrief(finalRaw, input.titleFallback ?? "Brief");
  if (actualSource !== plannedSource) {
    notes.push(
      `The SDK fell back: this run was expected to use ${plannedSource === "on_device" ? "the device" : "the cloud"} but ran ${actualSource === "on_device" ? "on-device" : "in the cloud"}.`,
    );
  }
  if (cloudPasses > 0 && devicePasses > 0) {
    notes.push(
      `Mixed route: ${devicePasses} pass${devicePasses === 1 ? "" : "es"} on the device and ${cloudPasses} in the cloud. Each pass is counted separately below.`,
    );
  }
  if (plan.redactBeforeSending) {
    notes.push("Only the masked copy left the device; the original text stayed in this tab.");
    notes.push(
      `Masked copy: ${cloudChars.toLocaleString()} characters transmitted; ${scanResult.redactedChars.toLocaleString()} characters (${scanResult.redactable} identifier${scanResult.redactable === 1 ? "" : "s"}) were replaced before sending. Placeholders can be longer than the value they replace.`,
    );
    if (scanResult.residual.length > 0) {
      notes.push(
        `The masked copy still shows ${scanResult.residual.join(", ")} — keywords cannot be replaced without destroying the document.`,
      );
    }
  }
  if (simulated) {
    notes.push(
      "Simulated: no Firebase project is configured, so a local extractive summariser produced this brief instead of Gemini.",
    );
  }
  notes.push(...plan.notes);

  const receipt: RunReceipt = {
    id: uid(),
    startedAt: new Date().toISOString(),
    policy: input.policy,
    requestedMode: plan.mode,
    source: actualSource,
    simulated,
    latencyMs: Math.round(performance.now() - started),
    inputChars: trimmed.length,
    cloudChars,
    // A masked run keeps its identifiers local; everything else was sent as a placeholder copy.
    stayedLocalChars: plan.redactBeforeSending
      ? Math.min(trimmed.length, scanResult.redactedChars)
      : Math.max(0, trimmed.length - cloudChars),
    tokensIn,
    tokensOut,
    chunks: chunks.length,
    redacted: plan.redactBeforeSending,
    model: actualSource === "in_cloud" ? cloudModel : "gemini-nano",
    notes,
  };

  progress({ phase: "done", message: "Brief ready." });
  return {
    status: "ok",
    result: { brief, receipt, raw: finalRaw, plan },
    scan: scanResult,
    plan,
    simulated,
  };
}

/**
 * Deterministic stand-in for the model call. Uses the same prompt pipeline but
 * answers with an extractive summary of the chunk, so the routing, masking,
 * receipt and ledger logic can all be exercised without a project.
 */
async function simulateCall(
  _prompt: string,
  documentText: string,
  plannedSource: InferenceSourceName,
  signal?: AbortSignal,
): Promise<{ text: string; source: InferenceSourceName }> {
  await sleep(180 + Math.min(420, documentText.length / 12), signal);
  const brief = extractiveBrief(documentText, "Brief");
  return { text: JSON.stringify(brief), source: plannedSource };
}

/**
 * Local stand-in for the merge call: combines the part briefs the simulator
 * produced. Parsing them as JSON (instead of re-summarising their JSON text)
 * keeps the simulated multi-part brief as coherent as a real one.
 */
function mergeSimulated(parts: string[]): string {
  const briefs = parts.map((part) => parseBrief(part, "Brief"));
  const points = [...new Set(briefs.flatMap((brief) => brief.points))].slice(0, 6);
  const flags = [...new Set(briefs.flatMap((brief) => brief.flags))].slice(0, 3);
  const tldr = briefs
    .map((brief) => brief.tldr)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  const title = briefs.find((brief) => brief.title && brief.title !== "Brief")?.title ?? "Brief";
  if (points.length === 0) {
    points.push(...briefs.flatMap((brief) => [brief.tldr]).filter(Boolean).slice(0, 3));
  }
  return JSON.stringify({ title, tldr, points, flags });
}
