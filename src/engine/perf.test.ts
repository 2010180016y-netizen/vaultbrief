import { describe, expect, it } from "vitest";
import { maskDocument } from "./pii";
import { SAMPLES } from "./samples";
import { scan } from "./sensitivity";

/**
 * The scanner runs on every keystroke, over as much as 60,000 characters, in the
 * same thread that draws the page. This measures the work instead of assuming
 * it is cheap, and locks the improvement that came from analysing each document
 * once per edit instead of four times.
 *
 * The budgets are deliberately loose (CI machines differ): the point is to catch
 * an order-of-magnitude regression, not to win a micro-benchmark.
 */

function time(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function longDocument(): string {
  const base = SAMPLES.map((sample) => sample.text).join("\n\n");
  return base.repeat(8).slice(0, 60_000);
}

describe("preview cost", () => {
  it("analyses a 60,000-character document inside the interactive budget", () => {
    const text = longDocument();
    expect(text.length).toBe(60_000);

    const single = time(() => {
      scan(text);
      maskDocument(text);
    });

    // What the screen used to do: rule scan + Presidio analysis + a second
    // Presidio analysis inside maskDocument() + a second rule scan in redact().
    const repeated = time(() => {
      scan(text);
      maskDocument(text);
      maskDocument(text);
    });

    console.log(
      `60k chars — one preview pass ${single.toFixed(1)} ms, duplicated work ${repeated.toFixed(1)} ms (${(
        repeated / single
      ).toFixed(2)}×)`,
    );

    expect(single).toBeLessThan(1500);
    expect(single).toBeLessThan(repeated);
  });

  it("stays fast on the Korean sample with identifiers", () => {
    const text = SAMPLES.find((sample) => sample.id === "korean-record")!.text.repeat(4);
    const elapsed = time(() => maskDocument(text));
    console.log(`${text.length} Korean characters — ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(400);
  });
});
