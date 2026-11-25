import { analyze, anonymize, RECOGNIZER_BY_ENTITY, statsFor, type AnalyzerStats, type PiiEntity, type RecognizerResult } from "./presidio";
import { redact } from "./sensitivity";
import type { Category, Detection, ScanResult } from "./types";

/**
 * The Presidio layer, wired into VaultBrief.
 *
 * `sensitivity.ts` answers "may this leave the device?" with regex rules that
 * are intentionally boring. This module adds the second opinion that decides
 * *what exactly* gets rewritten: Presidio-shaped entity recognition with
 * checksum validation and context-word confidence, plus Presidio's anonymizer.
 * Routing uses the union of both layers (`mergeScans`), so an identifier that
 * only the Presidio layer knows about (an IBAN, a Korean business number) still
 * raises the score and still gets masked.
 */

export interface PiiEntityView {
  entityType: PiiEntity;
  label: string;
  category: Category;
  count: number;
  maxScore: number;
  validated: number;
  contextBoosted: number;
  /** Up to three masked examples, never the raw value. */
  examples: string[];
}

export interface PiiAnalysis {
  results: RecognizerResult[];
  stats: AnalyzerStats;
  entities: PiiEntityView[];
  /** 0–100, comparable with `ScanResult.score`. */
  score: number;
  maskable: number;
  maskedChars: number;
}

function maskSample(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 3) return "•••";
  const keep = Math.min(3, Math.floor(trimmed.length / 4));
  return `${trimmed.slice(0, keep)}${"•".repeat(Math.min(10, trimmed.length - keep))}`;
}

/** Per-entity weights, mirroring the sensitivity scan so the two scores are comparable. */
function weightOf(entity: PiiEntity): number {
  return RECOGNIZER_BY_ENTITY.get(entity)?.weight ?? 10;
}

export function analyzeDocument(text: string): PiiAnalysis {
  const results = analyze(text);
  const stats = statsFor(results);

  const byEntity = new Map<PiiEntity, RecognizerResult[]>();
  for (const result of results) {
    const list = byEntity.get(result.entity_type) ?? [];
    list.push(result);
    byEntity.set(result.entity_type, list);
  }

  const entities: PiiEntityView[] = [];
  let score = 0;
  let maskable = 0;
  let maskedChars = 0;
  const categories = new Set<Category>();

  for (const [entityType, list] of byEntity) {
    const definition = RECOGNIZER_BY_ENTITY.get(entityType);
    if (!definition) continue;
    const weight = weightOf(entityType);
    const maxScore = Math.max(...list.map((r) => r.score));
    const validated = list.filter((r) => r.analysis_explanation.validation_result === true).length;
    const contextBoosted = list.filter((r) => r.analysis_explanation.supportive_context_word).length;
    score += weight + Math.min(weight, (list.length - 1) * 4);
    if (definition.redactable !== false) {
      maskable += list.length;
      maskedChars += list.reduce((sum, r) => sum + (r.end - r.start), 0);
    }
    categories.add(definition.category);
    entities.push({
      entityType,
      label: definition.label,
      category: definition.category,
      count: list.length,
      maxScore,
      validated,
      contextBoosted,
      examples: list.slice(0, 3).map((r) => maskSample(text.slice(r.start, r.end))),
    });
  }

  if (categories.size > 1) score += (categories.size - 1) * 4;

  return {
    results,
    stats,
    entities: entities.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    score: Math.min(100, score),
    maskable,
    maskedChars,
  };
}

export interface MaskedDocument {
  text: string;
  replaced: number;
  analysis: PiiAnalysis;
}

/**
 * Two-stage masking: Presidio's anonymizer rewrites the entities it recognised
 * with typed placeholders, then the original regex rules sweep whatever is
 * label-shaped (`주소: …`) but not entity-shaped. Placeholders contain no
 * identifiers, so the second stage cannot double-mask.
 */
export function maskDocument(text: string): MaskedDocument {
  const analysis = analyzeDocument(text);
  const operators = Object.fromEntries(
    analysis.entities.map((entity) => [
      entity.entityType,
      {
        operator: "replace" as const,
        newValue: `[REDACTED:${entity.category.toUpperCase()}]`,
      },
    ]),
  );
  const presidioPass = anonymize(text, analysis.results, operators);
  const regexPass = redact(presidioPass.text);
  return {
    text: regexPass.text,
    replaced: presidioPass.items.length + regexPass.replaced,
    analysis,
  };
}

/**
 * Unions the regex scan with the Presidio analysis so the router sees every
 * identifier either layer found. The score is the larger of the two, not their
 * sum: the two layers mostly find the same spans, and adding them would push
 * ordinary documents over the threshold.
 */
export function mergeScans(base: ScanResult, analysis: PiiAnalysis): ScanResult {
  const detections: Detection[] = [...base.detections];
  for (const entity of analysis.entities) {
    const existing = detections.find((d) => d.label === entity.label);
    if (existing) {
      existing.count = Math.max(existing.count, entity.count);
      existing.weight = Math.max(existing.weight, weightOf(entity.entityType));
      for (const example of entity.examples) {
        if (existing.examples.length < 3 && !existing.examples.includes(example)) {
          existing.examples.push(example);
        }
      }
    } else {
      detections.push({
        category: entity.category,
        label: entity.label,
        count: entity.count,
        weight: weightOf(entity.entityType),
        examples: entity.examples,
      });
    }
  }
  const score = Math.max(base.score, analysis.score);
  return {
    ...base,
    score,
    detections,
    redactable: Math.max(base.redactable, analysis.maskable),
    redactedChars: Math.max(base.redactedChars, analysis.maskedChars),
  };
}
