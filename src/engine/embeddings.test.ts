import { describe, expect, it } from "vitest";
import {
  cosine,
  dedupeChunks,
  dedupePoints,
  EMBEDDING_MODEL,
  semanticSensitivity,
  TransformersEmbedder,
  type Embedder,
} from "./embeddings";

/** Normalised bag of words on eight axes: enough to exercise the maths without a download. */
class KeywordEmbedder implements Embedder {
  readonly id = "fake-embedder";
  readonly ready = true;
  calls = 0;
  async prepare(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    const axes: RegExp[] = [
      /blood count|antibiotic|patient|test results|white cell|clinic|tablets|symptoms|treatment plan/i,
      /salary|invoice|bank|mortgage|payroll|deposit|amount due/i,
      /confidential|indemnity|contract|liability|disclose the terms/i,
      /full name|date of birth|passport|identity|applicant/i,
      /phone|email|address|reach me|telephone/i,
      /card number|expiry|credit card|payment/i,
      /registration number|national identity|official document/i,
      /api key|access token|password|private key/i,
    ];
    return texts.map((text) => {
      const vector = new Float32Array(axes.length + 1);
      axes.forEach((axis, index) => {
        if (axis.test(text)) vector[index] = 1;
      });
      // A tiny background weight keeps the vector non-zero without making
      // unrelated sentences look similar.
      vector[axes.length] = 0.001;
      const norm = Math.hypot(...vector);
      return vector.map((value) => value / norm) as unknown as Float32Array;
    });
  }
  dispose(): void {}
}

const vec = (...values: number[]) => {
  const array = new Float32Array(values);
  const norm = Math.hypot(...values);
  return array.map((value) => value / norm) as unknown as Float32Array;
};

describe("cosine", () => {
  it("is 1 for identical, 0 for orthogonal, and never NaN for zero vectors", () => {
    expect(cosine(vec(1, 0), vec(1, 0))).toBeCloseTo(1);
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
    expect(cosine(new Float32Array(3), vec(1, 1, 1))).toBe(0);
  });
});

describe("dedupeChunks", () => {
  it("collapses repeated boilerplate and keeps the order of the rest", () => {
    const vectors = [vec(1, 0, 0), vec(0, 1, 0), vec(1, 0, 0.05), vec(0, 0, 1)];
    const result = dedupeChunks(vectors, 0.95);
    expect(result.kept).toEqual([0, 1, 3]);
    expect(result.dropped).toEqual([2]);
    expect(result.similarities[0]).toBeGreaterThan(0.95);
  });

  it("keeps everything when nothing is a duplicate", () => {
    const result = dedupeChunks([vec(1, 0), vec(0, 1)], 0.95);
    expect(result.dropped).toEqual([]);
  });

  it("dedupes brief points with the same rule", () => {
    const points = ["Shipping costs fell.", "Shipping costs dropped.", "Revenue grew."];
    const vectors = [vec(1, 0), vec(0.99, 0.01), vec(0, 1)];
    expect(dedupePoints(points, vectors, 0.95)).toEqual(["Shipping costs fell.", "Revenue grew."]);
    expect(dedupePoints(points, null)).toBe(points);
  });
});

describe("semanticSensitivity", () => {
  it("recognises a paraphrase that has none of the keywords", async () => {
    const embedder = new KeywordEmbedder();
    const signal = await semanticSensitivity(
      "Her white cell count came back high, so the clinic started her on a two week course of tablets.",
      embedder,
    );
    expect(signal.category).toBe("health");
    expect(signal.confident).toBe(true);
    expect(signal.score).toBeGreaterThan(60);
    expect(signal.anchor).toContain("patient");
  });

  it("leaves an ordinary paragraph alone", async () => {
    const signal = await semanticSensitivity(
      "The committee met again to discuss the parking policy for the building and the new signage.",
      new KeywordEmbedder(),
    );
    expect(signal.confident).toBe(false);
    expect(signal.score).toBe(0);
  });

  it("handles empty input without calling the model", async () => {
    const embedder = new KeywordEmbedder();
    const signal = await semanticSensitivity("   ", embedder);
    expect(signal.score).toBe(0);
    expect(embedder.calls).toBe(0);
  });
});

describe("TransformersEmbedder", () => {
  it("loads the pipeline with the documented options and slices pooled rows", async () => {
    const calls: unknown[] = [];
    const fakePipeline = async (texts: string | string[], options?: Record<string, unknown>) => {
      calls.push({ texts, options });
      const rows = Array.isArray(texts) ? texts.length : 1;
      const dims = 3;
      return { data: new Float32Array(rows * dims).fill(0.5), dims: [rows, dims] };
    };
    const embedder = new TransformersEmbedder(async () => ({
      pipeline: (async (...args: unknown[]) => {
        calls.push({ factory: args });
        return fakePipeline as never;
      }) as never,
    }));
    const progress: number[] = [];
    await embedder.prepare((value) => progress.push(value));
    expect(embedder.ready).toBe(true);
    const vectors = await embedder.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(3);
    const factory = calls[0] as { factory: unknown[] };
    expect(factory.factory[0]).toBe("feature-extraction");
    expect(factory.factory[1]).toBe(EMBEDDING_MODEL);
    expect((factory.factory[2] as Record<string, unknown>).dtype).toBe("q8");
    expect((calls[1] as { options: Record<string, unknown> }).options).toMatchObject({
      pooling: "mean",
      normalize: true,
    });
  });

  it("refuses to embed before the model is loaded", async () => {
    const embedder = new TransformersEmbedder(async () => ({ pipeline: (async () => null) as never }));
    await expect(embedder.embed(["x"])).rejects.toThrow(/not loaded/);
  });

  it("processes a batch in one call", async () => {
    const embedder = new KeywordEmbedder();
    const vectors = await embedder.embed(["alpha", "beta", "gamma"]);
    expect(vectors).toHaveLength(3);
    expect(embedder.calls).toBe(1);
  });
});

/**
 * Live check against the real model. Not part of the default suite because it
 * downloads ~23 MB from Hugging Face:
 *   VAULTBRIEF_LIVE_MODELS=1 npx vitest run src/engine/embeddings.test.ts
 */
describe.skipIf(!process.env.VAULTBRIEF_LIVE_MODELS)("live transformers.js", () => {
  it("embeds real sentences and separates sensitive from public text", async () => {
    const embedder = new TransformersEmbedder(undefined, "cpu");
    await embedder.prepare();
    const signal = await semanticSensitivity(
      "Her white cell count came back high, so the clinic started her on a two week course of tablets.",
      embedder,
    );
    expect(signal.similarity).toBeGreaterThan(0.4);
    expect(signal.category).toBe("health");
    const publicSignal = await semanticSensitivity(
      "Our quarterly newsletter covers three shipping experiments and a note about the roadmap.",
      embedder,
    );
    expect(publicSignal.confident).toBe(false);
    embedder.dispose();
  }, 180_000);
});
