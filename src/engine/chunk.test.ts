import { describe, expect, it } from "vitest";
import { estimateTokens, splitSentences, splitText } from "./chunk";

const paragraph = (n: number) => `Paragraph ${n} talks about transformers, substations and queues in the grid. `;

describe("splitText", () => {
  it("returns one chunk when the text fits", () => {
    expect(splitText("short text", { budget: 100 })).toEqual(["short text"]);
  });

  it("keeps chunks under budget for paragraph text", () => {
    const text = Array.from({ length: 40 }, (_, i) => paragraph(i)).join("\n\n");
    const chunks = splitText(text, { budget: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(520);
    expect(chunks.join(" ")).toContain("Paragraph 39");
  });

  it("splits a single oversized paragraph by sentence", () => {
    const text = "One very long sentence. ".repeat(300);
    const chunks = splitText(text, { budget: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(420);
  });

  it("hard-splits text with no sentence breaks", () => {
    const text = "x".repeat(5000);
    const chunks = splitText(text, { budget: 1000 });
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });

  it("returns nothing for whitespace only input", () => {
    expect(splitText("   \n\n  ", { budget: 100 })).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("handles English and Korean terminators", () => {
    expect(splitSentences("First one. Second one! Third?")).toHaveLength(3);
    expect(splitSentences("첫 번째다. 두 번째다.")).toHaveLength(2);
  });
});

describe("estimateTokens", () => {
  it("is roughly four characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(1);
  });
});
