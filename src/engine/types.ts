/**
 * Shared vocabulary for the briefing engine.
 *
 * Everything in this file is platform neutral so that it can be unit tested in
 * Node and reused by the Chrome extension shell.
 */

/** How the app is allowed to route a request. */
export type Policy = "auto" | "device_only" | "cloud_quality";

/** Mirrors `InferenceMode` from `firebase/ai` without importing the SDK. */
export type InferenceModeName =
  | "prefer_on_device"
  | "only_on_device"
  | "prefer_in_cloud"
  | "only_in_cloud";

/** Mirrors `InferenceSource` reported by `GenerateContentResponse.inferenceSource`. */
export type InferenceSourceName = "on_device" | "in_cloud";

export type Category =
  | "contact"
  | "government_id"
  | "payment"
  | "credential"
  | "identity"
  | "financial"
  | "health"
  | "legal";

export interface Detection {
  category: Category;
  /** Human readable name of the signal, e.g. "Resident registration number". */
  label: string;
  count: number;
  /** How much this signal on its own raises the sensitivity score. */
  weight: number;
  /** Up to three masked examples, never the raw secret. */
  examples: string[];
}

export interface ScanResult {
  /** 0-100. Used by the router to decide whether text may leave the device. */
  score: number;
  detections: Detection[];
  /** Total number of matched spans. */
  hits: number;
  /** Number of spans that `redact()` can mask automatically. */
  redactable: number;
  /** Characters that would be masked by `redact()`. */
  redactedChars: number;
  /** Matched spans that redaction cannot remove (topic keywords). */
  unmaskable: number;
  /** Labels of the signals a masked copy would still reveal, e.g. "Health information". */
  residual: string[];
}

export interface DeviceStatus {
  /** True when `LanguageModel` (Prompt API) exists in this browser at all. */
  supported: boolean;
  availability: "available" | "downloadable" | "downloading" | "unavailable" | "unknown";
  /** Set when the app can see a model download in progress. */
  downloadProgress?: number;
  note: string;
  /** Which on-device engine will serve the private route. */
  engine?: "nano" | "webllm" | "none";
}

export interface RoutePlan {
  policy: Policy;
  mode: InferenceModeName;
  /** Where the router expects the work to land. Cloud fallback can still change it. */
  expectedSource: InferenceSourceName;
  /** True when text must be masked before it may be sent to the cloud. */
  redactBeforeSending: boolean;
  /** True when an on-device model can run right now. */
  deviceReady: boolean;
  chunked: boolean;
  estimatedChunks: number;
  /** One sentence shown in the UI. */
  reason: string;
  /** Extra caveats worth surfacing to the user. */
  notes: string[];
}

export interface Brief {
  title: string;
  tldr: string;
  points: string[];
  flags: string[];
}

export interface RunReceipt {
  id: string;
  startedAt: string;
  policy: Policy;
  requestedMode: InferenceModeName;
  /** Where inference actually happened, as reported by the SDK (or the simulator). */
  source: InferenceSourceName;
  /** True when no model was called and the brief is a local simulation. */
  simulated: boolean;
  latencyMs: number;
  /** Characters in the document. */
  inputChars: number;
  /** Characters of the document transmitted to a cloud model (masked copy counts here). */
  cloudChars: number;
  /** Characters that never reached a cloud model. */
  stayedLocalChars: number;
  tokensIn: number;
  tokensOut: number;
  chunks: number;
  redacted: boolean;
  /** Model that produced the brief: the cloud model name, gemini-nano, or a WebLLM model id. */
  model: string;
  notes: string[];
  /** Summary of the Presidio entity layer for this run. */
  pii?: {
    engine: string;
    entities: number;
    validated: number;
    contextBoosted: number;
    score: number;
    masked: number;
  };
  /** transformers.js semantic signal, when the local embedder was loaded. */
  semantic?: {
    score: number;
    similarity: number;
    category: Category | null;
    confident: boolean;
  };
  /** What the local model stack did besides inference. */
  local?: {
    embedder: string | null;
    dedupedChunks: number;
  };
}

export interface RunResult {
  brief: Brief;
  receipt: RunReceipt;
  /** Raw model text, kept for the "source" drawer. */
  raw: string;
  plan: RoutePlan;
}

export interface Progress {
  phase: "scan" | "prepare" | "chunk" | "merge" | "done";
  message: string;
  completed?: number;
  total?: number;
}
