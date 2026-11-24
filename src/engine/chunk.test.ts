import { describe, expect, it } from "vitest";
import { estimateTokens, splitSentences, splitText } from "./chunk";
import { groupForMerge } from "./engine";

const paragraph = (n: number) => `Paragraph ${n} talks about transformers, substations and queues in the grid. `;

describe("splitText", () => {
  it("returns one chunk when the text fits", () => {
    expect(splitText("short text", { budget: 200 })).toEqual(["short text"]);
  });

  it("keeps chunks under budget for paragraph text", () => {
    const text = Array.from({ length: 40 }, (_, i) => paragraph(i)).join("\n\n");
    const chunks = splitText(text, { budget: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join(" ")).toContain("Paragraph 39");
  });

  it("splits a single oversized paragraph by sentence", () => {
    const text = "One very long sentence. ".repeat(300);
    const chunks = splitText(text, { budget: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(400);
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

  it("never emits an overlap-only chunk and never exceeds the budget", () => {
    // Regression: with an overlap, a chunk made only of the repeated tail used
    // to be flushed and then summarised as if it were new content.
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i).repeat(4)).join("\n\n");
    const chunks = splitText(text, { budget: 600, overlap: 120 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
      expect(chunk.trim().length).toBeGreaterThan(120);
      expect(chunk).toContain("Paragraph");
    }
    // No chunk is a duplicate of another: an overlap-only chunk would be.
    expect(new Set(chunks).size).toBe(chunks.length);
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

describe("groupForMerge", () => {
  it("groups parts so one merge prompt stays inside the budget", () => {
    const parts = Array.from({ length: 8 }, () => "x".repeat(1000));
    const groups = groupForMerge(parts, 2500);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.length).toBeLessThan(parts.length);
    for (const group of groups) {
      const size = group.reduce((total, part) => total + part.length + 24, 0);
      expect(size).toBeLessThanOrEqual(2500);
    }
  });

  it("truncates a single part that is larger than the whole budget", () => {
    const groups = groupForMerge(["y".repeat(9000)], 2000);
    expect(groups).toHaveLength(1);
    expect(groups[0][0].length).toBeLessThan(2000);
  });
});
