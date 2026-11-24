import { estimateTokens, splitText } from "./chunk";
import { extractiveBrief } from "./demo";
import { HybridClient, HybridError } from "./hybrid";
import { cloudPrompt, mergePrompt, onDevicePrompt, parseBrief } from "./prompt";
import { CLOUD_CHUNK_BUDGET, DEVICE_CHUNK_BUDGET, decideRoute, type RouteOutcome } from "./router";
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
  onProgress?: (progress: Progress) => void;
  titleFallback?: string;
}

export type RunOutcome =
  | { status: "ok"; result: RunResult; scan: ScanResult; plan: RouteOutcome; simulated: boolean }
  | { status: "blocked"; plan: RouteOutcome; scan: ScanResult; reason: string }
  | { status: "error"; plan: RouteOutcome; scan: ScanResult; error: string; hint: string };

function uid(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    maskingAllowed: input.maskingAllowed,
    threshold: input.threshold,
  });
}

export async function runBrief(input: RunInput): Promise<RunOutcome> {
  const started = performance.now();
  const progress = input.onProgress ?? (() => {});
  const trimmed = input.text.trim();

  progress({ phase: "scan", message: "Scanning for identifiers on this device…" });
  const scanResult = scan(trimmed);
  const plan = planFor(input, scanResult);

  if (plan.blocked) {
    return { status: "blocked", plan, scan: scanResult, reason: plan.reason };
  }

  const simulated = input.client === null;
  const source: InferenceSourceName = plan.expectedSource;

  progress({ phase: "prepare", message: "Preparing the text for the chosen route…" });
  const working = plan.redactBeforeSending ? redact(trimmed).text : trimmed;
  const budget =
    source === "on_device" && (plan.mode === "only_on_device" || plan.mode === "prefer_on_device")
      ? DEVICE_CHUNK_BUDGET
      : CLOUD_CHUNK_BUDGET;
  const chunks = splitText(working, { budget, overlap: source === "on_device" ? 120 : 0 });

  const cloudPromptFor = source === "in_cloud" ? cloudPrompt : onDevicePrompt;

  let cloudChars = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let actualSource: InferenceSourceName = source;
  const notes: string[] = [];
  const partials: string[] = [];
  let finalRaw = "";

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      progress({
        phase: "chunk",
        message:
          chunks.length === 1
            ? source === "on_device"
              ? "Gemini Nano is reading on this device…"
              : "A cloud model is reading the document…"
            : `Briefing part ${i + 1} of ${chunks.length}…`,
        completed: i,
        total: chunks.length,
      });

      const prompt = cloudPromptFor(chunk);
      const outcome = simulated
        ? await simulateCall(prompt, chunk, source)
        : await input.client!.generate({ prompt, mode: plan.mode });

      actualSource = outcome.source;
      tokensIn += estimateTokens(prompt);
      tokensOut += estimateTokens(outcome.text);
      if (outcome.source === "in_cloud") cloudChars += chunk.length;
      partials.push(outcome.text);
      finalRaw = outcome.text;
    }

    if (chunks.length > 1) {
      progress({ phase: "merge", message: "Merging the parts into one brief…" });
      const mergeText = mergePrompt(partials);
      const outcome = simulated
        ? await simulateCall(mergeText, working.slice(0, 400), source)
        : await input.client!.generate({ prompt: mergeText, mode: plan.mode });
      actualSource = outcome.source;
      tokensIn += estimateTokens(mergeText);
      tokensOut += estimateTokens(outcome.text);
      finalRaw = outcome.text;
    }
  } catch (error) {
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
  if (actualSource !== source) {
    notes.push(`The SDK fell back: this run was expected to use ${source === "on_device" ? "the device" : "the cloud"} but ran ${actualSource === "on_device" ? "on-device" : "in the cloud"}.`);
  }
  if (plan.redactBeforeSending) {
    notes.push("Only the masked copy left the device; the original text stayed in this tab.");
  }
  if (simulated) {
    notes.push("Simulated: no Firebase project is configured, so a local extractive summariser produced this brief instead of Gemini.");
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
    stayedLocalChars: Math.max(0, trimmed.length - cloudChars),
    tokensIn,
    tokensOut,
    chunks: chunks.length,
    redacted: plan.redactBeforeSending,
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
): Promise<{ text: string; source: InferenceSourceName }> {
  await sleep(240 + Math.min(1200, documentText.length / 6));
  const brief = extractiveBrief(documentText, "Brief");
  return { text: JSON.stringify(brief), source: plannedSource };
}
