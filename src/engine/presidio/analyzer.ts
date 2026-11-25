import { RECOGNIZERS } from "./recognizers";
import {
  CONTEXT_SIMILARITY_FACTOR,
  DEFAULT_SCORE_THRESHOLD,
  INVALIDATE_RESULT_SCORE,
  MIN_SCORE_WITH_CONTEXT_SIMILARITY,
  type AnalysisExplanation,
  type AnalyzeOptions,
  type PiiEntity,
  type RecognizerDefinition,
  type RecognizerResult,
  type ValidationOutcome,
} from "./types";

/**
 * A TypeScript implementation of the parts of Presidio's `AnalyzerEngine` that
 * matter inside a browser tab:
 *
 *   1. every pattern recognizer runs over the text (Presidio's `PatternRecognizer`);
 *   2. each hit is validated (checksum/format) — a failure lowers confidence to
 *      `invalidate_result_score` instead of silently keeping it;
 *   3. context words in the preceding tokens raise confidence by
 *      `context_similarity_factor` (Presidio's `LemmaContextAwareEnhancer`);
 *   4. overlapping hits collapse to the most confident one (`remove_duplicates`);
 *   5. results below the score threshold are dropped.
 *
 * The remaining Presidio machinery (spaCy NER, lemmatised context vectors,
 * the AnalyzerEngine's dynamic loading) is deliberately not ported: it cannot
 * run in the tab, and a recognizer that needs to fetch a model could not
 * answer "may this text leave the device?" before the model has arrived.
 */

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** Korean particles that attach to a context word ("계좌번호는", "주민번호가"). */
const JOSA = /(?:은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|께서|부터|까지)$/u;

function lastTokens(text: string, end: number, count: number): string[] {
  if (count <= 0) return [];
  const prefix = text.slice(0, end);
  const tokens = prefix.split(WORD_SPLIT).filter(Boolean);
  return tokens.slice(-count);
}

function normalise(token: string): string {
  return token.toLowerCase().replace(JOSA, "");
}

/**
 * Presidio compares lemmas; we compare normalised tokens. A Korean context word
 * is frequently a substring of a compound label ("주민등록번호" contains
 * "주민번호" only after particle stripping), so a containment test is the
 * closest dependency-free equivalent.
 */
export function contextMatches(token: string, contextWord: string): boolean {
  const tokenNorm = normalise(token);
  const wordNorm = contextWord.toLowerCase();
  if (!tokenNorm) return false;
  if (tokenNorm === wordNorm) return true;
  if (wordNorm.length >= 2 && tokenNorm.includes(wordNorm)) return true;
  if (tokenNorm.length >= 4 && wordNorm.includes(tokenNorm)) return true;
  return false;
}

function supportiveWord(tokens: string[], context: string[]): string | undefined {
  for (const contextWord of context) {
    for (const token of tokens) {
      if (contextMatches(token, contextWord)) return contextWord;
    }
  }
  return undefined;
}

function runValidation(
  definition: RecognizerDefinition,
  value: string,
  text: string,
  start: number,
  end: number,
): ValidationOutcome | null {
  if (!definition.validate) return null;
  const outcome = definition.validate(value, text, start, end);
  return typeof outcome === "boolean" ? { valid: outcome } : outcome;
}

interface Candidate {
  definition: RecognizerDefinition;
  result: RecognizerResult;
}

/**
 * Runs every recognizer and returns Presidio-shaped results, highest
 * confidence first, with overlapping spans already resolved.
 */
export function analyze(
  text: string,
  options: AnalyzeOptions = {},
  registry: RecognizerDefinition[] = RECOGNIZERS,
): RecognizerResult[] {
  const threshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const prefixCount = options.contextPrefix ?? 5;
  const suffixCount = options.contextSuffix ?? 0;
  const boost = options.contextBoost ?? CONTEXT_SIMILARITY_FACTOR;
  const only = options.entities ? new Set<PiiEntity>(options.entities) : null;

  const candidates: Candidate[] = [];

  for (const definition of registry) {
    if (only && !only.has(definition.entityType)) continue;
    for (const pattern of definition.patterns) {
      const flags = pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`;
      const regex = new RegExp(pattern.regex.source, flags);
      for (const match of text.matchAll(regex)) {
        if (match.index === undefined) continue;
        const group = pattern.group ?? 0;
        const value = match[group];
        if (!value) continue;
        // Locate the capture group inside the full match, so a label-anchored
        // pattern reports the name rather than "Patient: Name".
        const offset = group === 0 ? 0 : match[0].indexOf(value);
        if (offset < 0) continue;
        const start = match.index + offset;
        const end = start + value.length;

        const validation = runValidation(definition, value, text, start, end);
        let score = pattern.score;
        if (validation) {
          score = validation.valid
            ? (validation.score ?? pattern.score)
            : (validation.score ?? INVALIDATE_RESULT_SCORE);
        }

        const tokens = [
          ...lastTokens(text, start, prefixCount),
          ...text.slice(end, end + 80).split(WORD_SPLIT).filter(Boolean).slice(0, suffixCount),
        ];
        const contextWord = supportiveWord(tokens, definition.context);
        let contextImprovement = 0;
        if (contextWord) {
          const before = score;
          score = Math.min(1, score + boost);
          if (score < MIN_SCORE_WITH_CONTEXT_SIMILARITY) score = MIN_SCORE_WITH_CONTEXT_SIMILARITY;
          contextImprovement = Math.round((score - before) * 1000) / 1000;
        }

        const explanation: AnalysisExplanation = {
          recognizer: definition.name,
          pattern_name: pattern.name,
          original_score: pattern.score,
          score: Math.round(score * 1000) / 1000,
          ...(contextImprovement > 0
            ? { score_context_improvement: contextImprovement, supportive_context_word: contextWord }
            : {}),
          ...(validation ? { validation_result: validation.valid } : {}),
          textual_explanation:
            validation?.note ??
            (contextWord
              ? `Confidence raised by context word “${contextWord}”.`
              : `${definition.label} matched ${pattern.name}.`),
        };

        candidates.push({
          definition,
          result: {
            entity_type: definition.entityType,
            start,
            end,
            score: explanation.score,
            analysis_explanation: explanation,
          },
        });
      }
    }
  }

  const kept: RecognizerResult[] = [];
  for (const candidate of dedupe(candidates)) {
    if (candidate.result.score >= threshold) kept.push(candidate.result);
  }
  return kept.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * Presidio's `remove_duplicates`: when two recognizers claim overlapping text,
 * the higher score wins; on a tie the longer span wins (a card number beats the
 * four digits inside it).
 */
function dedupe(candidates: Candidate[]): Candidate[] {
  const ranked = [...candidates].sort((a, b) => {
    if (b.result.score !== a.result.score) return b.result.score - a.result.score;
    return b.result.end - b.result.start - (a.result.end - a.result.start);
  });
  const kept: Candidate[] = [];
  for (const candidate of ranked) {
    const overlaps = kept.some(
      (other) =>
        candidate.result.start < other.result.end && other.result.start < candidate.result.end,
    );
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

/** Convenience wrapper used by the app and the tests. */
export function analyzePii(text: string, options: AnalyzeOptions = {}): RecognizerResult[] {
  return analyze(text, options);
}

export interface AnalyzerStats {
  entities: number;
  validated: number;
  unvalidated: number;
  contextBoosted: number;
  byEntity: Partial<Record<PiiEntity, number>>;
}

export function statsFor(results: RecognizerResult[]): AnalyzerStats {
  const stats: AnalyzerStats = { entities: results.length, validated: 0, unvalidated: 0, contextBoosted: 0, byEntity: {} };
  for (const result of results) {
    const explanation = result.analysis_explanation;
    if (explanation.validation_result === true) stats.validated += 1;
    if (explanation.validation_result === false) stats.unvalidated += 1;
    if (explanation.supportive_context_word) stats.contextBoosted += 1;
    stats.byEntity[result.entity_type] = (stats.byEntity[result.entity_type] ?? 0) + 1;
  }
  return stats;
}
