import { describe, expect, it } from "vitest";
import { runBrief } from "./engine";
import { mergeScans, maskDocument, analyzeDocument } from "./pii";
import { scan } from "./sensitivity";
import { SAMPLES } from "./samples";
import type { Embedder } from "./embeddings";
import type { HybridClient } from "./hybrid";
import type { DeviceStatus } from "./types";
import { WebLlmError, type OnDeviceEngine } from "./webllm";

/**
 * End-to-end checks for the three open-source integrations working together:
 * Presidio entities decide what is masked, transformers.js removes duplicates
 * and adds a semantic signal, and WebLLM serves the on-device route instead of
 * Gemini Nano. Everything below is deterministic — no GPU, no network, no
 * Firebase project.
 */

const deviceReady: DeviceStatus = { supported: true, availability: "available", note: "ready", engine: "webllm" };
const noDevice: DeviceStatus = { supported: false, availability: "unavailable", note: "none", engine: "none" };
const sample = (id: string) => SAMPLES.find((s) => s.id === id)!.text;

const BRIEF = JSON.stringify({
  title: "Discharge summary",
  tldr: "The patient was admitted for observation and released the next day.",
  points: ["Admitted Tuesday", "Discharged Wednesday", "Follow-up in two weeks"],
  flags: ["Follow-up required"],
});

class FakeDeviceEngine implements OnDeviceEngine {
  readonly id = "webllm";
  readonly label = "Fake WebLLM";
  readonly ready = true;
  prompts: string[] = [];
  aborted = 0;
  async prepare(): Promise<void> {}
  async generate({ prompt }: { prompt: string }) {
    this.prompts.push(prompt);
    return {
      text: BRIEF,
      source: "on_device" as const,
      model: "fake-qwen-0.5b",
      usage: { promptTokens: 210, completionTokens: 60 },
    };
  }
  abort(): void {
    this.aborted += 1;
  }
  async dispose(): Promise<void> {}
}

class FailingDeviceEngine extends FakeDeviceEngine {
  async generate(): Promise<never> {
    throw new WebLlmError("WebGPU lost the device.", "Reload the tab and use the compact model.", "device/webgpu");
  }
}

class RecordingClient {
  prompts: string[] = [];
  async generate({ prompt }: { prompt: string }) {
    this.prompts.push(prompt);
    return { text: BRIEF, source: "in_cloud" as const };
  }
}

/** Splits sentences into disjoint vectors so identical text dedupes and distinct text does not. */
class HashEmbedder implements Embedder {
  readonly id = "hash-embedder";
  readonly ready = true;
  async prepare(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = new Float32Array(64);
      for (const word of text.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean)) {
        let index = 0;
        for (const char of word) index = (index * 31 + char.charCodeAt(0)) % 64;
        vector[index] += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm) as unknown as Float32Array;
    });
  }
  dispose(): void {}
}

describe("device route through WebLLM", () => {
  it("serves a private brief from the WebGPU engine and counts no cloud characters", async () => {
    const engine = new FakeDeviceEngine();
    const outcome = await runBrief({
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      client: null,
      deviceEngine: engine,
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.plan.mode).toBe("only_on_device");
    expect(outcome.result.receipt.source).toBe("on_device");
    expect(outcome.result.receipt.model).toBe("fake-qwen-0.5b");
    expect(outcome.result.receipt.simulated).toBe(false);
    expect(outcome.result.receipt.cloudChars).toBe(0);
    expect(outcome.result.receipt.tokensIn).toBeGreaterThan(0);
    expect(engine.prompts.length).toBeGreaterThan(0);
    // The device engine gets the unmasked document: that is the whole point of
    // the private route.
    expect(engine.prompts.some((prompt) => prompt.includes("Patient:"))).toBe(true);
    expect(outcome.result.receipt.notes.join(" ")).toMatch(/Fake WebLLM/);
  });

  it("never falls back to the cloud when the on-device engine fails", async () => {
    const client = new RecordingClient();
    const outcome = await runBrief({
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      client: client as unknown as HybridClient,
      deviceEngine: new FailingDeviceEngine(),
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.hint).toMatch(/compact model/);
    expect(client.prompts).toEqual([]);
  });

  it("refuses the device route when no engine is ready", async () => {
    const outcome = await runBrief({
      text: "진단명: 급성 위염. 처방 내역: 판토프라졸 40mg.",
      policy: "device_only",
      maskingAllowed: true,
      device: noDevice,
      client: null,
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toMatch(/Device-only/);
  });
});

describe("Presidio masking in the pipeline", () => {
  it("masks an IBAN the keyword rules cannot see before anything is sent", async () => {
    const client = new RecordingClient();
    const text = "Please transfer the retainer to IBAN GB82WEST12345698765432 and confirm by email.";
    const outcome = await runBrief({
      text,
      policy: "cloud_quality",
      maskingAllowed: true,
      device: noDevice,
      client: client as unknown as HybridClient,
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.plan.redactBeforeSending).toBe(true);
    expect(outcome.result.receipt.pii?.entities).toBeGreaterThan(0);
    expect(outcome.result.receipt.pii?.validated).toBeGreaterThan(0);
    const transmitted = client.prompts.join("\n");
    expect(transmitted).not.toContain("GB82WEST12345698765432");
    expect(transmitted).toContain("[REDACTED:FINANCIAL]");
  });

  it("raises the score for an entity only the Presidio layer knows", () => {
    const text = "운전면허 11-22-123456-01 을 제출했습니다.";
    const base = scan(text);
    const analysis = analyzeDocument(text);
    const merged = mergeScans(base, analysis);
    expect(analysis.entities.map((entity) => entity.entityType)).toContain("KR_DRIVER_LICENSE");
    expect(merged.score).toBeGreaterThan(base.score);
    expect(merged.detections.length).toBeGreaterThan(base.detections.length);
  });

  it("keeps the label readable while removing a Korean name and resident number", () => {
    const { text: masked, replaced } = maskDocument(
      "환자 성명: 김민수\n주민등록번호: 900101-1234568\n연락처: 010-2841-7734",
    );
    expect(replaced).toBeGreaterThanOrEqual(3);
    expect(masked).toContain("환자 성명:");
    expect(masked).not.toContain("김민수");
    expect(masked).not.toContain("900101");
    expect(masked).not.toContain("010-2841");
  });
});

describe("transformers.js in the pipeline", () => {
  it("drops a repeated passage before it becomes another device pass", async () => {
    // Four identical sections: without deduplication this is four on-device
    // passes over the same text.
    const paragraph =
      "CONFIDENTIALITY NOTICE: " +
      "This transmission is intended only for the addressee and may contain privileged information. ".repeat(14);
    const text = Array.from({ length: 4 }, () => paragraph).join("\n\n");
    const engine = new FakeDeviceEngine();
    const outcome = await runBrief({
      text,
      policy: "device_only",
      maskingAllowed: true,
      device: deviceReady,
      client: null,
      deviceEngine: engine,
      embedder: new HashEmbedder(),
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const receipt = outcome.result.receipt;
    expect(receipt.chunks).toBe(1);
    expect(receipt.local?.dedupedChunks ?? 0).toBeGreaterThan(0);
    expect(receipt.local?.embedder).toBe("hash-embedder");
    expect(receipt.notes.join(" ")).toMatch(/repeated passage/);
  });

  it("adds a semantic signal for a paraphrase with no keywords", async () => {
    const text = "Her white cell count came back high, so the clinic started her on a two week course of tablets.";
    const plain = await runBrief({
      text,
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      client: null,
      cloudModel: "gemini-3.5-flash-lite",
    });
    const semantic = await runBrief({
      text,
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      client: null,
      embedder: new HashEmbedder(),
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(plain.status).toBe("ok");
    expect(semantic.status).toBe("ok");
    if (plain.status !== "ok" || semantic.status !== "ok") return;
    expect(plain.result.receipt.semantic).toBeUndefined();
    expect(semantic.result.receipt.semantic?.category).toBeTruthy();
  });

  it("survives an embedder that throws", async () => {
    const broken: Embedder = {
      id: "broken",
      ready: true,
      prepare: async () => {},
      embed: async () => {
        throw new Error("onnxruntime exploded");
      },
      dispose: () => {},
    };
    const outcome = await runBrief({
      text: sample("discharge"),
      policy: "auto",
      maskingAllowed: true,
      device: deviceReady,
      client: null,
      deviceEngine: new FakeDeviceEngine(),
      embedder: broken,
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.receipt.semantic).toBeUndefined();
    expect(outcome.result.receipt.chunks).toBeGreaterThan(0);
  });
});
