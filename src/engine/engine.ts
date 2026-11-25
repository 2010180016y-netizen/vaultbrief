import { estimateTokens, splitText } from "./chunk";
import { extractiveBrief } from "./demo";
import { dedupeChunks, dedupePoints, semanticSensitivity, type Embedder, type SemanticSignal } from "./embeddings";
import { HybridClient, HybridError } from "./hybrid";
import { mergeScans, maskDocument } from "./pii";
import { sealReceipt } from "./receipt";
import { cloudPrompt, mergePrompt, onDevicePrompt, parseBrief } from "./prompt";
import {
  CLOUD_CHUNK_BUDGET,
  DEVICE_CHUNK_BUDGET,
  DEVICE_CHUNK_OVERLAP,
  decideRoute,
  type RouteOutcome,
} from "./router";
import { scan } from "./sensitivity";
import type { OnDeviceEngine } from "./webllm";
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
  /** null when no Firebase project is configured: cloud calls are simulated. */
  client: HybridClient | null;
  /** WebLLM (or another WebGPU engine). When ready it serves the on-device route. */
  deviceEngine?: OnDeviceEngine | null;
  /** transformers.js embedder: local semantic signal and near-duplicate removal. */
  embedder?: Embedder | null;
  cloudModel: string;
  /** Overrides the sensitivity threshold, e.g. from Remote Config. */
  threshold?: number;
  /** Stops the run between passes and cancels the request in flight. */
  signal?: AbortSignal;
  /** Per-request timeout, milliseconds. */
  timeoutMs?: number;
  onProgress?: (progress: Progress) => void;
  titleFallback?: string;
  /** Digest of the previous receipt in this browser's ledger (chain link). */
  previousDigest?: string;
  /** 1-based position of this receipt in the ledger. */
  sequence?: number;
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
  const deviceEngine = input.deviceEngine ?? null;
  const embedder = input.embedder ?? null;

  progress({ phase: "scan", message: "Scanning for identifiers on this device…" });

  // Two local detectors run before anything else: the regex scan and the
  // Presidio layer. The router sees their union, so an identifier that only
  // the entity layer knows about still changes the route.
  let scanResult = scan(trimmed);
  const masked = maskDocument(trimmed);
  scanResult = mergeScans(scanResult, masked.analysis);
  // The plan's "N identifiers are replaced" must match the masked copy that is
  // actually produced (the two layers can rewrite more spans than either counted).
  scanResult = { ...scanResult, redactable: Math.max(scanResult.redactable, masked.replaced) };

  let semantic: SemanticSignal | null = null;
  if (embedder?.ready && trimmed.length > 0) {
    progress({ phase: "scan", message: "Scoring the document locally with transformers.js…" });
    try {
      semantic = await semanticSensitivity(trimmed, embedder);
    } catch (error) {
      // A local classifier that fails must never block the privacy decision.
      semantic = null;
      progress({ phase: "scan", message: `Local semantic score skipped: ${(error as Error).message}` });
    }
    if (semantic?.confident) {
      scanResult = { ...scanResult, score: Math.max(scanResult.score, semantic.score) };
    }
  }

  const plan = planFor(input, scanResult);

  if (plan.blocked) {
    return { status: "blocked", plan, scan: scanResult, reason: plan.reason };
  }

  const cloudModel = input.cloudModel.trim() || "gemini-3.5-flash-lite";
  const onDevice = plan.expectedSource === "on_device";
  const engineServesDevice = onDevice && (deviceEngine?.ready ?? false);
  // "Simulated" is per call now: a ready WebLLM engine is a real model even
  // when no Firebase project is connected.
  const cloudSimulated = input.client === null;
  let usedSimulator = false;

  const budget = onDevice ? DEVICE_CHUNK_BUDGET : CLOUD_CHUNK_BUDGET;
  const promptFor = onDevice ? onDevicePrompt : cloudPrompt;

  progress({ phase: "prepare", message: "Preparing the text for the chosen route…" });
  let working = plan.redactBeforeSending ? masked.text : trimmed;
  let chunks = splitText(working, { budget, overlap: onDevice ? DEVICE_CHUNK_OVERLAP : 0 });

  let dedupedChunks = 0;
  if (embedder?.ready && chunks.length > 1) {
    progress({ phase: "prepare", message: "Collapsing repeated passages with local embeddings…" });
    try {
      const vectors = await embedder.embed(chunks);
      const deduped = dedupeChunks(vectors);
      if (deduped.dropped.length > 0) {
        dedupedChunks = deduped.dropped.length;
        chunks = deduped.kept.map((index) => chunks[index]);
      }
    } catch {
      // Deduplication is an optimisation; the run continues without it.
    }
  }

  const notes: string[] = [];
  let cloudChars = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  // Every pass (document or merge) records where it actually ran: a mixed run
  // must never be summarised as if only its last pass existed.
  const seenSources = new Set<InferenceSourceName>();
  const noteSource = (source: InferenceSourceName) => seenSources.add(source);
  let cloudPasses = 0;
  let devicePasses = 0;
  let deviceModel = "gemini-nano";
  const partials: string[] = [];
  let finalRaw = "";

  const call = async (prompt: string, documentText: string): Promise<{ text: string; source: InferenceSourceName }> => {
    if (signal?.aborted) throw new CancelledError();
    if (engineServesDevice && deviceEngine) {
      const outcome = await deviceEngine.generate({
        prompt,
        signal,
        timeoutMs: input.timeoutMs,
      });
      deviceModel = outcome.model;
      tokensIn += outcome.usage?.promptTokens || estimateTokens(prompt);
      tokensOut += outcome.usage?.completionTokens || estimateTokens(outcome.text);
      return { text: outcome.text, source: "on_device" };
    }
    const simulated = cloudSimulated;
    const outcome = simulated
      ? await simulateCall(prompt, documentText, plan.expectedSource, signal)
      : await input.client!.generate({
          prompt,
          mode: plan.mode,
          cloudModel,
          signal,
          timeoutMs: input.timeoutMs,
        });
    if (simulated) usedSimulator = true;
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
    if (engineServesDevice && deviceEngine) {
      const outcome = await deviceEngine.generate({ prompt, signal, timeoutMs: input.timeoutMs });
      tokensOut += outcome.usage?.completionTokens || estimateTokens(outcome.text);
      return { text: outcome.text, source: "on_device" };
    }
    if (cloudSimulated) {
      await sleep(140 + Math.min(320, group.length * 60), signal);
      const text = mergeSimulated(group);
      tokensOut += estimateTokens(text);
      usedSimulator = true;
      return { text, source: plan.expectedSource };
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
              ? deviceEngine?.ready
                ? `${deviceEngine.label} is reading on this device…`
                : "Gemini Nano is reading on this device…"
              : "A cloud model is reading the document…"
            : `Briefing part ${i + 1} of ${chunks.length}…`,
        completed: i,
        total: chunks.length,
      });

      const outcome = await call(promptFor(chunk), chunk);
      noteSource(outcome.source);
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
          noteSource(outcome.source);
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
      (error as { code?: string })?.code === "request/aborted" ||
      (error as { name?: string })?.name === "AbortError" ||
      signal?.aborted === true;
    if (aborted) return cancelOutcome();
    const hybridError = error instanceof HybridError ? error : null;
    const hintLike = error as { hint?: string };
    return {
      status: "error",
      plan,
      scan: scanResult,
      error: hybridError ? hybridError.message : (error as Error).message,
      hint:
        hybridError?.hint ??
        hintLike?.hint ??
        "The request failed before a brief was produced. Nothing is retried automatically.",
    };
  }

  // Where the run actually happened: the cloud wins if any pass reached it,
  // because that is the fact a reader of the receipt needs.
  const actualSource: InferenceSourceName = seenSources.has("in_cloud") ? "in_cloud" : "on_device";

  let brief = parseBrief(finalRaw, input.titleFallback ?? "Brief");
  if (embedder?.ready && brief.points.length > 1) {
    try {
      const pointVectors = await embedder.embed(brief.points);
      const deduped = dedupePoints(brief.points, pointVectors);
      if (deduped.length !== brief.points.length) {
        brief = { ...brief, points: deduped };
        notes.push(
          `${brief.points.length} brief points kept: ${deduped.length} near-duplicate${deduped.length === 1 ? "" : "s"} removed by local embeddings.`,
        );
      }
    } catch {
      // keep the merged points as produced
    }
  }

  if (actualSource !== plan.expectedSource) {
    notes.push(
      `The SDK fell back: this run was expected to use ${plan.expectedSource === "on_device" ? "the device" : "the cloud"} but ran ${actualSource === "on_device" ? "on-device" : "in the cloud"}.`,
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
      `Masked copy: ${cloudChars.toLocaleString()} characters transmitted; ${masked.replaced} span${masked.replaced === 1 ? "" : "s"} were replaced (Presidio entities + rules) and ${scanResult.redactedChars.toLocaleString()} characters of the original never left. Placeholders can be longer than the value they replace.`,
    );
    if (scanResult.residual.length > 0) {
      notes.push(
        `The masked copy still shows ${scanResult.residual.join(", ")} — keywords cannot be replaced without destroying the document.`,
      );
    }
  }
  if (deviceEngine?.ready && devicePasses > 0) {
    notes.push(`On-device inference ran on ${deviceEngine.label} (${deviceModel}); the model weights were downloaded once and cached by the browser.`);
  }
  if (dedupedChunks > 0) {
    notes.push(
      `${dedupedChunks} repeated passage${dedupedChunks === 1 ? "" : "s"} removed locally before inference (transformers.js embeddings, cosine ≥ 0.96).`,
    );
  }
  if (semantic?.confident) {
    notes.push(
      `Local semantic scan: ${semantic.category} phrasing at cosine ${semantic.similarity} (transformers.js), which the keyword rules alone would not have weighted.`,
    );
  }
  if (usedSimulator) {
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
    simulated: usedSimulator,
    latencyMs: Math.round(performance.now() - started),
    inputChars: trimmed.length,
    cloudChars,
    stayedLocalChars: plan.redactBeforeSending
      ? Math.min(trimmed.length, scanResult.redactedChars)
      : Math.max(0, trimmed.length - cloudChars),
    tokensIn,
    tokensOut,
    chunks: chunks.length,
    redacted: plan.redactBeforeSending,
    model: actualSource === "in_cloud" ? cloudModel : deviceModel,
    notes,
    pii: {
      engine: "presidio-ts (v2.2 recognizer semantics)",
      entities: masked.analysis.entities.length,
      validated: masked.analysis.stats.validated,
      contextBoosted: masked.analysis.stats.contextBoosted,
      score: masked.analysis.score,
      masked: masked.analysis.maskable,
    },
    semantic: semantic
      ? {
          score: semantic.score,
          similarity: semantic.similarity,
          category: semantic.category,
          confident: semantic.confident,
        }
      : undefined,
    local: {
      embedder: embedder?.ready ? embedder.id : null,
      dedupedChunks,
    },
    split: { onDevicePasses: devicePasses, cloudPasses },
  };

  // Seal after everything else is final: the digest covers the receipt exactly
  // as it is shown, so a field edited later no longer verifies.
  let sealed = receipt;
  try {
    sealed = await sealReceipt(receipt, {
      documentText: trimmed,
      prev: input.previousDigest,
      seq: input.sequence,
    });
  } catch (error) {
    sealed = {
      ...receipt,
      notes: [...receipt.notes, `Receipt sealing failed: ${(error as Error).message}`],
    };
  }

  progress({ phase: "done", message: "Brief ready." });
  return {
    status: "ok",
    result: { brief, receipt: sealed, raw: finalRaw, plan },
    scan: scanResult,
    plan,
    simulated: usedSimulator,
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
