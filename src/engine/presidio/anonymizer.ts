import { stableHash } from "../checksums";
import type { PiiEntity, RecognizerResult } from "./types";

/**
 * Presidio's `AnonymizerEngine`, ported.
 *
 * Same operators (`replace`, `redact`, `mask`, `hash`, `keep`) and the same
 * `OperatorResult` shape, so the masked copy this app sends can be inspected
 * exactly like Presidio's output. `hash` uses FNV-1a here: it is a stable
 * pseudonym for correlation, not a cryptographic commitment — the default
 * operator stays `replace`, which sends a typed placeholder and nothing else.
 */

export type OperatorName = "replace" | "redact" | "mask" | "hash" | "keep";

export interface OperatorConfig {
  operator: OperatorName;
  /** For `replace`: the exact text. Defaults to `<ENTITY_TYPE>`. */
  newValue?: string;
  /** For `mask`: character used, default `*`. */
  maskingChar?: string;
  /** For `mask`: how many characters to mask. Defaults to the whole value. */
  charsToMask?: number;
  /** For `mask`: mask from the end instead of the start (like a card number). */
  fromEnd?: boolean;
}

export interface OperatorResult {
  start: number;
  end: number;
  entity_type: PiiEntity;
  text: string;
  operator: OperatorName;
}

export interface AnonymizedResult {
  text: string;
  items: OperatorResult[];
}

export type OperatorMap = Partial<Record<PiiEntity | "DEFAULT", OperatorConfig | OperatorName>>;

const DEFAULT_OPERATOR: OperatorConfig = { operator: "replace" };

function resolve(operators: OperatorMap | undefined, entity: PiiEntity): OperatorConfig {
  const entry = operators?.[entity] ?? operators?.DEFAULT;
  if (!entry) return DEFAULT_OPERATOR;
  return typeof entry === "string" ? { operator: entry } : entry;
}

export function applyOperator(value: string, entity: PiiEntity, config: OperatorConfig): string {
  switch (config.operator) {
    case "redact":
      return "";
    case "keep":
      return value;
    case "mask": {
      const char = config.maskingChar?.slice(0, 1) || "*";
      const count = Math.min(value.length, config.charsToMask ?? value.length);
      if (config.fromEnd) {
        return value.slice(0, value.length - count) + char.repeat(count);
      }
      return char.repeat(count) + value.slice(count);
    }
    case "hash":
      return stableHash(value);
    case "replace":
    default:
      return config.newValue ?? `<${entity}>`;
  }
}

/** Applies operators to every result and returns the rewritten text plus the edit trail. */
export function anonymize(
  text: string,
  results: RecognizerResult[],
  operators?: OperatorMap,
): AnonymizedResult {
  // Overlaps must not double-rewrite: keep the highest score, then the earliest.
  const ordered = [...results]
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .reduce<RecognizerResult[]>((kept, result) => {
      const overlaps = kept.some((other) => result.start < other.end && other.start < result.end);
      if (!overlaps) kept.push(result);
      return kept;
    }, [])
    .sort((a, b) => a.start - b.start);

  if (ordered.length === 0) return { text, items: [] };

  let out = "";
  let cursor = 0;
  const items: OperatorResult[] = [];
  for (const result of ordered) {
    if (result.start < cursor) continue;
    const value = text.slice(result.start, result.end);
    const config = resolve(operators, result.entity_type);
    const replacement = applyOperator(value, result.entity_type, config);
    out += text.slice(cursor, result.start) + replacement;
    cursor = result.end;
    items.push({
      start: result.start,
      end: result.end,
      entity_type: result.entity_type,
      text: replacement,
      operator: config.operator,
    });
  }
  out += text.slice(cursor);
  return { text: out, items };
}
