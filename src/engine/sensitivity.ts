import type { Category, Detection, ScanResult } from "./types";

/**
 * Local sensitivity scan.
 *
 * This runs before any model call and never touches the network. Its only job
 * is to answer one question: may this text leave the device?
 *
 * The rules are deliberately boring (regular expressions + curated keyword
 * lists) because a classifier that needs a model cannot decide whether a
 * document may be given to a model.
 */

export interface SignalRule {
  id: string;
  category: Category;
  label: string;
  /** Score added the first time this signal appears. */
  weight: number;
  /** Score added for each additional occurrence, up to `maxBonus`. */
  perExtra: number;
  maxBonus: number;
  pattern: RegExp;
  /** Rejects false positives, e.g. card numbers that fail the Luhn check. */
  validate?: (match: string) => boolean;
  /** False for keyword signals: they raise the score but are never rewritten. */
  redactable?: boolean;
  /** Custom placeholder for a match (defaults to [REDACTED:CATEGORY]). */
  maskMatch?: (match: string) => string;
}

const KEYWORDS = (...words: string[]) => new RegExp(`\\b(?:${words.join("|")})\\b`, "gi");

export const RULES: SignalRule[] = [
  {
    id: "credential",
    redactable: true,
    category: "credential",
    label: "Credential / secret in text",
    weight: 55,
    perExtra: 10,
    maxBonus: 30,
    // "password: hunter2", "api_key = sk-…", "비밀번호: 1234"
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|passphrase|access[_-]?token|private[_-]?key|비밀번호|접속\s*암호)\b\s*[:=]\s*\S{4,}/gi,
  },
  {
    id: "rrn",
    redactable: true,
    category: "government_id",
    label: "Korean resident registration number",
    weight: 50,
    perExtra: 12,
    maxBonus: 40,
    pattern: /(?<!\d)\d{6}[-\s]?[1-4]\d{6}(?!\d)/g,
  },
  {
    id: "passport",
    redactable: true,
    category: "government_id",
    label: "Passport / ID document number",
    weight: 40,
    perExtra: 8,
    maxBonus: 24,
    pattern: /(?<![A-Za-z0-9])[MS]\d{8}(?![0-9])/g,
  },
  {
    id: "card",
    redactable: true,
    category: "payment",
    label: "Payment card number",
    weight: 45,
    perExtra: 10,
    maxBonus: 30,
    pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g,
    validate: (m) => luhn(m.replace(/[^0-9]/g, "")),
  },
  {
    id: "account",
    redactable: true,
    category: "financial",
    label: "Bank account number",
    weight: 32,
    perExtra: 8,
    maxBonus: 24,
    pattern: /(?<!\d)\d{3,6}-\d{2,6}-\d{4,8}(?!\d)/g,
  },
  {
    id: "phone",
    redactable: true,
    category: "contact",
    label: "Phone number",
    weight: 16,
    perExtra: 4,
    maxBonus: 12,
    // Korean mobile numbers and international numbers with a country code.
    pattern:
      /(?<!\d)(?:\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,9}|0?1[016789][-\s]?\d{3,4}[-\s]?\d{4})(?!\d)/g,
  },
  {
    id: "email",
    redactable: true,
    category: "contact",
    label: "Email address",
    weight: 14,
    perExtra: 3,
    maxBonus: 9,
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  },
  {
    id: "ip",
    category: "contact",
    label: "IP address",
    weight: 6,
    perExtra: 2,
    maxBonus: 6,
    pattern: /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g,
  },
  {
    id: "named-person",
    category: "identity",
    label: "Named individual",
    weight: 26,
    perExtra: 4,
    maxBonus: 12,
    redactable: true,
    // "Patient: Daniel R. Okafor", "성명: 김민수"
    pattern:
      /(?:\b(?:patient|employee|applicant|signatory|candidate|contact name)\b|성명|이름|환자명)\s*[:：]\s*[A-Za-z가-힣][A-Za-z가-힣.\-']*(?:\s+[A-Za-z가-힣][A-Za-z가-힣.\-']*){0,3}/gi,
    maskMatch: (match) => match.replace(/[:：][\s\S]*$/, ": [REDACTED:IDENTITY]"),
  },
  {
    id: "health",
    category: "health",
    label: "Health information",
    weight: 30,
    perExtra: 6,
    maxBonus: 24,
    pattern: KEYWORDS(
      "diagnosis",
      "diagnosed",
      "prescription",
      "prescribed",
      "medical record",
      "patient",
      "symptom",
      "therapy",
      "blood test",
      "진단",
      "처방",
      "복용",
      "병원",
      "검사결과",
      "투약",
      "수술",
    ),
  },
  {
    id: "finance",
    category: "financial",
    label: "Financial information",
    weight: 24,
    perExtra: 5,
    maxBonus: 20,
    pattern: KEYWORDS(
      "salary",
      "payroll",
      "balance",
      "invoice",
      "loan",
      "net worth",
      "급여",
      "연봉",
      "잔액",
      "계좌",
      "대출",
      "세금",
      "정산",
    ),
  },
  {
    id: "legal",
    category: "legal",
    label: "Contract / legal terms",
    weight: 20,
    perExtra: 4,
    maxBonus: 16,
    pattern: KEYWORDS(
      "confidential",
      "non-disclosure",
      "nda",
      "indemnity",
      "arbitration",
      "without prejudice",
      "비밀유지",
      "계약서",
      "손해배상",
      "합의금",
    ),
  },
];

/** Score at or above which the router treats a document as sensitive. */
export const SENSITIVE_THRESHOLD = 40;

export function luhn(digits: string): boolean {
  if (digits.length < 13) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskSample(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 3) return "•••";
  const keep = Math.min(3, Math.floor(trimmed.length / 4));
  return `${trimmed.slice(0, keep)}${"•".repeat(Math.min(10, trimmed.length - keep))}`;
}

interface RawHit {
  rule: SignalRule;
  value: string;
  index: number;
}

function collect(text: string): RawHit[] {
  const hits: RawHit[] = [];
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const value = match[0];
      if (!value) continue;
      if (rule.validate && !rule.validate(value)) continue;
      // A 16-digit run that is also a resident number should not be counted twice.
      const overlaps = hits.some(
        (h) => h.index === match.index! && h.value.length === value.length,
      );
      if (overlaps) continue;
      hits.push({ rule, value, index: match.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function scan(text: string): ScanResult {
  const hits = collect(text);
  const byRule = new Map<string, RawHit[]>();
  for (const hit of hits) {
    const list = byRule.get(hit.rule.id) ?? [];
    list.push(hit);
    byRule.set(hit.rule.id, list);
  }

  const detections: Detection[] = [];
  let score = 0;
  let redactable = 0;
  let redactedChars = 0;

  for (const rule of RULES) {
    const list = byRule.get(rule.id);
    if (!list || list.length === 0) continue;
    const bonus = Math.min(rule.maxBonus, rule.perExtra * (list.length - 1));
    score += rule.weight + bonus;
    detections.push({
      category: rule.category,
      label: rule.label,
      count: list.length,
      weight: rule.weight + bonus,
      examples: list.slice(0, 3).map((h) => maskSample(h.value)),
    });
    if (rule.redactable) {
      redactable += list.length;
      redactedChars += list.reduce((sum, h) => sum + h.value.length, 0);
    }
  }

  // Distinct sensitive categories compound: a document that is both medical and
  // financial is more revealing than either alone.
  const categories = new Set(detections.map((d) => d.category));
  if (categories.size > 1) score += (categories.size - 1) * 6;

  return {
    score: Math.min(100, score),
    detections,
    hits: hits.length,
    redactable,
    redactedChars,
  };
}

/**
 * Replaces every redactable span with a typed placeholder. The placeholders are
 * plain ASCII tokens so that the masked text can still be summarised sensibly
 * ("the patient, [REDACTED:CONTACT], was diagnosed …").
 */
export function redact(text: string): { text: string; replaced: number } {
  const hits = collect(text).filter((hit) => hit.rule.redactable);
  if (hits.length === 0) return { text, replaced: 0 };

  let out = "";
  let cursor = 0;
  for (const hit of hits) {
    if (hit.index < cursor) continue;
    out += text.slice(cursor, hit.index);
    out += hit.rule.maskMatch
      ? hit.rule.maskMatch(hit.value)
      : `[REDACTED:${hit.rule.category.toUpperCase()}]`;
    cursor = hit.index + hit.value.length;
  }
  out += text.slice(cursor);
  return { text: out, replaced: hits.length };
}

export function isSensitive(result: ScanResult, threshold = SENSITIVE_THRESHOLD): boolean {
  return result.score >= threshold;
}
