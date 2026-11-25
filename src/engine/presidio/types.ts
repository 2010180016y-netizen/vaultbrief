import type { Category } from "../types";

/**
 * Vocabulary of the Presidio layer.
 *
 * The shapes follow microsoft/presidio's Python API (`RecognizerResult`,
 * `AnalysisExplanation`, `Pattern`), so a result produced here can be compared
 * one-to-one with the oracle output in `docs/presidio-oracle.json`.
 */

export type PiiEntity =
  | "PERSON"
  | "LOCATION"
  | "EMAIL_ADDRESS"
  | "PHONE_NUMBER"
  | "CREDIT_CARD"
  | "IBAN_CODE"
  | "IP_ADDRESS"
  | "URL"
  | "US_SSN"
  | "KR_RRN"
  | "KR_BRN"
  | "KR_DRIVER_LICENSE"
  | "KR_PASSPORT"
  | "KR_ACCOUNT"
  | "DATE_TIME";

/** Presidio's `Pattern`: one regex plus the score a hit earns. */
export interface PresidioPattern {
  name: string;
  regex: RegExp;
  /** Base score 0–1, before validation and context. */
  score: number;
  /** 1-based capture group to report (the value inside a label), default whole match. */
  group?: number;
}

/** Outcome of a recognizer's format/checksum check. */
export interface ValidationOutcome {
  valid: boolean;
  /** Score to use instead of the pattern score. Keeps a real PII value above the mask threshold. */
  score?: number;
  note?: string;
}

/** Presidio's `AnalysisExplanation`, reduced to the fields we can fill without spaCy. */
export interface AnalysisExplanation {
  recognizer: string;
  pattern_name?: string;
  original_score: number;
  score: number;
  score_context_improvement?: number;
  supportive_context_word?: string;
  validation_result?: boolean;
  textual_explanation?: string;
}

/** Presidio's `RecognizerResult`. */
export interface RecognizerResult {
  entity_type: PiiEntity;
  start: number;
  end: number;
  score: number;
  analysis_explanation: AnalysisExplanation;
}

/** A recognizer, the TypeScript equivalent of `PatternRecognizer` + our app metadata. */
export interface RecognizerDefinition {
  /** Presidio entity name, e.g. `KR_RRN`. */
  entityType: PiiEntity;
  /** Recognizer name for the explanation trail, e.g. `KrRrnRecognizer`. */
  name: string;
  /** Which VaultBrief category this entity belongs to (drives the 0–100 score). */
  category: Category;
  /** Human label shown in the UI. */
  label: string;
  patterns: PresidioPattern[];
  /** Context words that raise confidence when they appear just before the value. */
  context: string[];
  /** Format/checksum validation, Presidio's `validate_result`. */
  validate?: (value: string, text: string, start: number, end: number) => ValidationOutcome | boolean;
  /** Weight used when this entity contributes to the document score. */
  weight: number;
  /** False for entities we report but never rewrite (URLs, dates). */
  redactable?: boolean;
}

export interface AnalyzeOptions {
  /** Restrict to these entities (Presidio's `entities=`). */
  entities?: PiiEntity[];
  /** Presidio default 0.4. */
  scoreThreshold?: number;
  /** Tokens inspected before a match for context words. Presidio default 5. */
  contextPrefix?: number;
  /** Tokens inspected after a match. Presidio default 0; we use 0 to stay faithful. */
  contextSuffix?: number;
  /** Presidio's `context_similarity_factor`. */
  contextBoost?: number;
}

export const DEFAULT_SCORE_THRESHOLD = 0.4;
export const CONTEXT_SIMILARITY_FACTOR = 0.35;
export const MIN_SCORE_WITH_CONTEXT_SIMILARITY = 0.4;
/** Presidio's `invalidate_result_score`. */
export const INVALIDATE_RESULT_SCORE = 0.4;
