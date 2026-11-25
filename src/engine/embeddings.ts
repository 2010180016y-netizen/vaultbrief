import type { Category } from "./types";

/**
 * Local embeddings with 🤗 transformers.js.
 *
 * The model runs in the tab (onnxruntime-web, WASM or WebGPU) and no text
 * leaves the device — which is the only kind of NLP VaultBrief may use before
 * it has decided whether the document is private.
 *
 * Three jobs, all of them things a keyword list cannot do:
 *   1. `semanticSensitivity` — a paraphrase of a medical or financial statement
 *      scores against prototypical anchors, so "elevated white cell count" is
 *      recognised even though "diagnosis" never appears.
 *   2. `dedupeChunks` — boilerplate that repeats in a long document collapses
 *      before it becomes another on-device pass.
 *   3. `dedupePoints` — brief points produced by different chunks that say the
 *      same thing merge, instead of filling the brief with near-duplicates.
 */

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DTYPE = "q8";
export const EMBEDDING_DIMENSIONS = 384;

export interface Embedder {
  readonly id: string;
  readonly ready: boolean;
  prepare(onProgress?: (progress: number, message: string) => void): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): void;
}

type PipelineOutput = { data: Float32Array; dims: number[] };
type FeaturePipeline = (texts: string | string[], options?: Record<string, unknown>) => Promise<PipelineOutput>;
type PipelineFactory = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<FeaturePipeline & { dispose?: () => Promise<void> }>;

/** Loads the real library; a seam so tests never touch the network. */
export async function loadTransformers(): Promise<{ pipeline: PipelineFactory }> {
  const lib = await import("@huggingface/transformers");
  // onnxruntime-web ships a 26 MB WASM build. transformers.js already points
  // wasmPaths at jsDelivr; making it explicit means the app never depends on
  // Vite copying that binary into the deploy (Cloudflare Pages rejects files
  // over 25 MiB) and the browser gets exactly the version this code was built
  // against. The document still never leaves the tab: this fetches the runtime,
  // not the text.
  try {
    const onnx = (lib.env as unknown as {
      backends?: { onnx?: { versions?: { web?: string }; wasm?: { wasmPaths?: unknown } } };
    })?.backends?.onnx;
    if (onnx?.wasm && !onnx.wasm.wasmPaths && onnx.versions?.web) {
      onnx.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${onnx.versions.web}/dist/`;
    }
  } catch {
    // If the internal shape changed, the library's own default applies.
  }
  return { pipeline: lib.pipeline as unknown as PipelineFactory };
}

export class TransformersEmbedder implements Embedder {
  readonly id = EMBEDDING_MODEL;
  private pipeline: FeaturePipeline | null = null;
  private loading: Promise<void> | null = null;
  private onProgress?: (progress: number, message: string) => void;

  constructor(
    private readonly loader: () => Promise<{ pipeline: PipelineFactory }> = loadTransformers,
    /** WASM in the browser (works everywhere), CPU under Node for the live check. */
    readonly device: "wasm" | "cpu" = typeof window === "undefined" ? "cpu" : "wasm",
  ) {}

  get ready(): boolean {
    return this.pipeline !== null;
  }

  async prepare(onProgress?: (progress: number, message: string) => void): Promise<void> {
    if (this.pipeline) return;
    if (this.loading) return this.loading;
    this.onProgress = onProgress;
    this.loading = (async () => {
      const { pipeline } = await this.loader();
      const pipe = await pipeline("feature-extraction", EMBEDDING_MODEL, {
        dtype: EMBEDDING_DTYPE,
        device: this.device,
        progress_callback: (report: { status?: string; progress?: number; file?: string }) => {
          if (typeof report?.progress !== "number") return;
          this.onProgress?.(report.progress, report.file ? `${report.status ?? "loading"} ${report.file}` : (report.status ?? "loading"));
        },
      });
      this.pipeline = pipe;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = this.pipeline;
    if (!pipe) throw new Error("The embedding model is not loaded yet. Call prepare() first.");
    const output = await pipe(texts, { pooling: "mean", normalize: true });
    const [rows, dims] = output.dims;
    const vectors: Float32Array[] = [];
    for (let row = 0; row < rows; row++) {
      vectors.push(output.data.slice(row * dims, (row + 1) * dims));
    }
    return vectors;
  }

  dispose(): void {
    const pipe = this.pipeline as (FeaturePipeline & { dispose?: () => Promise<void> }) | null;
    void pipe?.dispose?.();
    this.pipeline = null;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export interface DedupeResult {
  kept: number[];
  dropped: number[];
  /** Cosine of each dropped chunk with the kept chunk that replaced it. */
  similarities: number[];
}

/** Drops chunks that repeat an earlier one (headers, footers, disclaimers). */
export function dedupeChunks(vectors: Float32Array[], threshold = 0.96): DedupeResult {
  const kept: number[] = [];
  const dropped: number[] = [];
  const similarities: number[] = [];
  for (let i = 0; i < vectors.length; i++) {
    let duplicateOf: number | null = null;
    let best = 0;
    for (const keep of kept) {
      const similarity = cosine(vectors[i], vectors[keep]);
      if (similarity > best) {
        best = similarity;
        if (similarity >= threshold) duplicateOf = keep;
      }
    }
    if (duplicateOf === null) {
      kept.push(i);
    } else {
      dropped.push(i);
      similarities.push(best);
    }
  }
  return { kept, dropped, similarities };
}

/** Keeps the first of each group of near-identical strings. */
export function dedupePoints(points: string[], vectors: Float32Array[] | null, threshold = 0.93): string[] {
  if (!vectors || vectors.length !== points.length) return points;
  const result = dedupeChunks(vectors, threshold);
  return result.kept.map((index) => points[index]);
}

export const SEMANTIC_ANCHORS: Record<Category, string[]> = {
  health: [
    "The patient's test results show an abnormal blood count and the doctor prescribed a course of antibiotics.",
    "Admission notes describe symptoms, a diagnosis and a treatment plan for the patient.",
  ],
  financial: [
    "Her monthly salary was deposited into the bank account and the outstanding loan balance was paid.",
    "The invoice lists the amount due, the tax and the bank account for the transfer.",
  ],
  legal: [
    "This agreement includes a confidentiality clause, an indemnity obligation and an arbitration clause.",
    "The parties agree not to disclose the terms and accept liability for any breach of contract.",
  ],
  identity: [
    "My full name, date of birth and passport number are listed on this form.",
    "The applicant's name and identity document number appear in the record.",
  ],
  contact: [
    "You can reach me by phone or email at the address below.",
    "The delivery address and contact telephone number are written here.",
  ],
  payment: [
    "The card number, expiry date and security code were used to pay the invoice.",
    "Payment was taken from the credit card ending in the digits shown.",
  ],
  government_id: [
    "The resident registration number and passport number identify this person.",
    "The national identity number is printed on the official document.",
  ],
  credential: [
    "The API key, access token and password are stored in this configuration file.",
    "The private key and the login password must never be shared.",
  ],
};

/*
 * Calibration, measured with Xenova/all-MiniLM-L6-v2 on this corpus:
 *   a real paraphrase of a sensitive statement   0.46 – 0.47
 *   an ordinary public paragraph                 0.04 – 0.17
 *   a business paragraph ("revenue grew 18%")    0.27 (correctly ignored)
 * The model is English-only, so Korean text gets no semantic signal — the
 * Korean keyword rules in sensitivity.ts carry that case on their own.
 */
/** Below this cosine the anchors are not about the same thing at all. */
export const SEMANTIC_FLOOR = 0.3;
/** Cosine that maps to 100 on the 0–100 scale. */
export const SEMANTIC_CEILING = 0.6;
/** A category must clear this cosine before it may change routing. */
export const SEMANTIC_CONFIDENCE = 0.42;

export interface SemanticSignal {
  score: number;
  similarity: number;
  category: Category | null;
  /** Which anchor matched, for the console. */
  anchor: string | null;
  /** True when the signal is strong enough to raise the routing score. */
  confident: boolean;
  sentences: number;
}

export function sentences(text: string, limit = 40): string[] {
  const parts = text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?。！？])\s+|\n{2,}/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 24);
  return parts.slice(0, limit);
}

function calibration(similarity: number): number {
  if (similarity <= SEMANTIC_FLOOR) return 0;
  const ratio = (similarity - SEMANTIC_FLOOR) / (SEMANTIC_CEILING - SEMANTIC_FLOOR);
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/**
 * Scores the document against one anchor set per category and returns the
 * strongest match. This is a *signal*: it can raise the routing score, never
 * lower it, and it never rewrites text.
 */
export async function semanticSensitivity(text: string, embedder: Embedder): Promise<SemanticSignal> {
  const chosen = sentences(text);
  if (chosen.length === 0) {
    return { score: 0, similarity: 0, category: null, anchor: null, confident: false, sentences: 0 };
  }
  const categories = Object.keys(SEMANTIC_ANCHORS) as Category[];
  const anchorList = categories.flatMap((category) =>
    SEMANTIC_ANCHORS[category].map((anchor) => ({ category, anchor })),
  );
  const vectors = await embedder.embed([...chosen, ...anchorList.map((item) => item.anchor)]);
  const sentenceVectors = vectors.slice(0, chosen.length);
  const anchorVectors = vectors.slice(chosen.length);

  let best = { similarity: 0, category: null as Category | null, anchor: null as string | null };
  for (let a = 0; a < anchorList.length; a++) {
    for (const sentenceVector of sentenceVectors) {
      const similarity = cosine(sentenceVector, anchorVectors[a]);
      if (similarity > best.similarity) {
        best = { similarity, category: anchorList[a].category, anchor: anchorList[a].anchor };
      }
    }
  }

  return {
    score: calibration(best.similarity),
    similarity: Math.round(best.similarity * 1000) / 1000,
    category: best.category,
    anchor: best.anchor,
    confident: best.similarity >= SEMANTIC_CONFIDENCE,
    sentences: chosen.length,
  };
}
