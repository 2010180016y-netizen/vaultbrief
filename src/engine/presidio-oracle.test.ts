import { describe, expect, it } from "vitest";
import corpus from "../../docs/pii-corpus.json";
import oracle from "../../docs/presidio-oracle.json";
import { analyze } from "./presidio";

/**
 * Cross-validation against the reference implementation.
 *
 * `docs/presidio-oracle.json` is produced by running the real
 * microsoft/presidio analyzer (Python, spaCy en_core_web_sm) over the same
 * corpus — see `scripts/presidio-oracle.py`. The browser cannot run Presidio,
 * so this is how the TypeScript port is held to it: the committed oracle is the
 * fixed reference and regenerating it is a one-command diff.
 */

interface CorpusSample {
  id: string;
  language: string;
  text: string;
  expect: string[];
}

interface OracleResult {
  entity_type: string;
  start: number;
  end: number;
  score: number;
  value: string;
}

interface OracleSample {
  id: string;
  results: OracleResult[];
}

const samples = corpus.samples as CorpusSample[];
const oracleById = new Map<string, OracleSample>(
  (oracle.samples as OracleSample[]).map((sample) => [sample.id, sample]),
);
const SHARED = new Set<string>(oracle.shared_entities as string[]);

/** Entity types the oracle found that the corpus does not consider PII (Presidio's own noise). */
function oracleFalsePositives(sample: CorpusSample): OracleResult[] {
  const expected = new Set(sample.expect);
  return (oracleById.get(sample.id)?.results ?? []).filter(
    (result) => result.score >= 0.5 && SHARED.has(result.entity_type) && !expected.has(result.entity_type),
  );
}

describe("Presidio oracle agreement", () => {
  it("covers every entity the labelled corpus expects", () => {
    const missing: string[] = [];
    for (const sample of samples) {
      const found = new Set<string>(analyze(sample.text).map((result) => String(result.entity_type)));
      for (const entity of sample.expect) {
        if (!found.has(entity)) missing.push(`${sample.id}:${entity}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("finds the same strong English entities the real Presidio found", () => {
    let comparable = 0;
    const disagreements: string[] = [];
    for (const sample of samples) {
      const found = new Set<string>(analyze(sample.text).map((result) => String(result.entity_type)));
      for (const result of oracleById.get(sample.id)?.results ?? []) {
        if (result.score < 0.5 || !SHARED.has(result.entity_type)) continue;
        // DATE_TIME is deliberately stricter here: Presidio's date recognizer
        // labels "0134", "Q3" and "quarterly" as dates, which is noise for a
        // privacy score that must not block an ordinary newsletter.
        if (result.entity_type === "DATE_TIME") continue;
        if (!sample.expect.includes(result.entity_type)) continue;
        comparable += 1;
        if (!found.has(result.entity_type)) {
          disagreements.push(`${sample.id}:${result.entity_type} ${JSON.stringify(result.value)}`);
        }
      }
    }
    expect(comparable).toBeGreaterThanOrEqual(3);
    expect(disagreements).toEqual([]);
  });

  it("does not reproduce Presidio's false positives", () => {
    const reproduced: string[] = [];
    for (const sample of samples) {
      const found = new Set<string>(analyze(sample.text).map((result) => String(result.entity_type)));
      for (const result of oracleFalsePositives(sample)) {
        if (found.has(result.entity_type)) {
          reproduced.push(`${sample.id}:${result.entity_type} ${JSON.stringify(result.value)}`);
        }
      }
    }
    expect(reproduced).toEqual([]);
  });

  it("documents the gap the port fills: stock Presidio has no Korean recognizers", () => {
    const korean = samples.filter((sample) => sample.language === "ko");
    const oracleFound = korean.reduce(
      (total, sample) => total + (oracleById.get(sample.id)?.results.length ?? 0),
      0,
    );
    expect(korean.length).toBeGreaterThanOrEqual(3);
    expect(oracleFound).toBe(0);
    const ours = korean.reduce((total, sample) => total + analyze(sample.text).length, 0);
    expect(ours).toBeGreaterThanOrEqual(8);
  });

  it("reports oracle recall lower than the port's on the labelled corpus", () => {
    const total = samples.reduce((sum, sample) => sum + sample.expect.length, 0);
    expect(total).toBeGreaterThan(0);
    const oracleHits = samples.reduce((sum, sample) => {
      const found = new Set((oracleById.get(sample.id)?.results ?? []).map((r) => r.entity_type));
      return sum + sample.expect.filter((entity) => found.has(entity)).length;
    }, 0);
    const portHits = samples.reduce((sum, sample) => {
      const found = new Set<string>(analyze(sample.text).map((r) => String(r.entity_type)));
      return sum + sample.expect.filter((entity) => found.has(entity)).length;
    }, 0);
    // Reference recall is reported, not asserted beyond "worse": the point of
    // the port is coverage (Korean, checksums), not beating Presidio overall.
    expect(oracleHits).toBeLessThan(portHits);
    expect(oracleHits / total).toBeLessThan(0.75);
  });

  it("pins the oracle to the version that produced it", () => {
    expect(oracle.generated_by).toBe("scripts/presidio-oracle.py");
    expect(oracle.presidio_analyzer).toMatch(/^2\.\d+\.\d+$/);
    expect(oracle.spacy_model).toBe("en_core_web_sm");
  });
});
