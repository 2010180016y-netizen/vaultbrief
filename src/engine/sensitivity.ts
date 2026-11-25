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
 *
 * Two rule kinds:
 *   - value rules  (email, card, resident number…): raise the score AND can be
 *     rewritten by `redact()`.
 *   - signal rules (health / finance / legal vocabulary): raise the score,
 *     never rewritten — rewriting the word "patient" would destroy the brief.
 *     `scan()` reports these in `residual` so the UI can say what a masked copy
 *     still reveals.
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

const ASCII_ONLY = /^[\x20-\x7E]+$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word boundaries only exist for ASCII in JavaScript: `\b` never matches next
 * to a Hangul syllable, so `/\b진단\b/` matches nothing at all. English terms
 * keep `\b`; Korean terms are matched without boundaries (Korean is agglutinative
 * — "진단명" and "진단서" both contain the signal) and allow the spacing to vary
 * ("검사 결과" / "검사결과").
 */
export function keywordPattern(words: string[]): RegExp {
  const english: string[] = [];
  const korean: string[] = [];
  for (const word of words) {
    if (ASCII_ONLY.test(word)) {
      english.push(escapeRegExp(word).replace(/ /g, "\\s+"));
    } else {
      korean.push(
        [...word]
          .map((char) => escapeRegExp(char))
          .join("\\s*"),
      );
    }
  }
  const parts: string[] = [];
  if (english.length > 0) parts.push(`\\b(?:${english.join("|")})\\b`);
  if (korean.length > 0) parts.push(`(?:${korean.join("|")})`);
  return new RegExp(parts.join("|"), "gi");
}

const KEYWORDS = (...words: string[]) => keywordPattern(words);

export const RULES: SignalRule[] = [
  {
    id: "secret-token",
    redactable: true,
    category: "credential",
    label: "API key / access token",
    weight: 60,
    perExtra: 8,
    maxBonus: 24,
    // Provider-shaped secrets that appear without a "key =" label.
    pattern:
      /(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/g,
  },
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
      /(?:\b(?:api[_-]?key|secret|password|passwd|passphrase|access[_-]?token|private[_-]?key)\b|비밀번호|접속\s*암호|인증\s*키)\s*[:=]\s*\S{4,}/gi,
  },
  {
    id: "rrn",
    redactable: true,
    category: "government_id",
    label: "Korean resident registration number",
    weight: 50,
    perExtra: 12,
    maxBonus: 40,
    pattern: /(?<!\d)\d{6}[-\s]?[1-8]\d{6}(?!\d)/g,
  },
  {
    id: "passport",
    redactable: true,
    category: "government_id",
    label: "Passport / ID document number",
    weight: 40,
    perExtra: 8,
    maxBonus: 24,
    pattern: /(?<![A-Za-z0-9])[MSROD]\d{8}(?![0-9])/g,
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
    id: "phone",
    redactable: true,
    category: "contact",
    label: "Phone number",
    weight: 16,
    perExtra: 4,
    maxBonus: 12,
    // Korean mobile and landline numbers, and international numbers with a
    // country code. Runs before `account`: 010-2841-7734 also fits the account
    // pattern, and a phone must not be reported (or weighted) as a bank account.
    pattern:
      /(?<!\d)(?:\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,9}|0(?:1[016789]|[2-6]\d?)[-\s]?\d{3,4}[-\s]?\d{4})(?!\d)/g,
  },
  {
    id: "account",
    redactable: true,
    category: "financial",
    label: "Bank account / business number",
    weight: 32,
    perExtra: 8,
    maxBonus: 24,
    pattern: /(?<!\d)\d{3,6}-\d{2,6}-\d{4,8}(?!\d)/g,
  },
  {
    id: "record-number",
    redactable: true,
    category: "identity",
    label: "Medical record / licence number",
    weight: 30,
    perExtra: 6,
    maxBonus: 12,
    // "MRN 4471-2291", "Patient ID: 88213", "차트번호 2026-118", "면허번호 제 41207 호"
    pattern:
      /(?:\b(?:MRN|medical record number|patient id|chart number)\b|환자\s*번호|차트\s*번호|면허\s*번호)\s*[:：]?\s*(?:제\s*)?[A-Z0-9][A-Z0-9-]{3,}/gi,
  },
  {
    id: "dob",
    redactable: true,
    category: "identity",
    label: "Date of birth",
    weight: 16,
    perExtra: 4,
    maxBonus: 8,
    // "DOB 1988-03-14", "Date of birth: 1988. 3. 14.", "생년월일 1988년 3월 14일"
    pattern:
      /(?:\b(?:DOB|date of birth)\b|생년월일|출생일)\s*[:：]?\s*\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}/gi,
    maskMatch: (match) => `${(match.match(/^(?:DOB|date of birth|생년월일|출생일)/i) ?? ["DOB"])[0]}: [REDACTED:IDENTITY]`,
  },
  {
    id: "address",
    redactable: true,
    category: "contact",
    label: "Postal address",
    weight: 18,
    perExtra: 4,
    maxBonus: 8,
    pattern: /(?:\baddress\b|주소)\s*[:：]\s*[^\n]{5,80}/gi,
    maskMatch: (match) => match.replace(/[:：][\s\S]*$/, ": [REDACTED:CONTACT]"),
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
    pattern: /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.])/g,
  },
  {
    id: "named-person",
    category: "identity",
    label: "Named individual",
    weight: 26,
    perExtra: 4,
    maxBonus: 12,
    redactable: true,
    // "Patient: Daniel R. Okafor", "성명: 김민수", "담당 의사: 이지훈"
    pattern:
      /(?:\b(?:patient|employee|applicant|signatory|candidate|contact name|attending)\b|성명|이름|환자명|담당\s*의사|수진자)[ \t]*[:：][ \t]*[A-Za-z가-힣][A-Za-z가-힣.\-']*(?:[ \t]+[A-Za-z가-힣][A-Za-z가-힣.\-']*){0,3}/gi,
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
      "discharge summary",
      "진단",
      "진단서",
      "소견",
      "처방",
      "처방전",
      "복용",
      "복약",
      "병원",
      "의원",
      "검사결과",
      "검사 결과",
      "투약",
      "수술",
      "시술",
      "입원",
      "퇴원",
      "내시경",
      "혈압",
      "당뇨",
      "질환",
      "증상",
      "통증",
      "알레르기",
      "임신",
      "출산",
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
      "월급",
      "잔액",
      "계좌",
      "예금",
      "적금",
      "대출",
      "이자",
      "세금",
      "소득",
      "정산",
      "법인카드",
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
      "계약",
      "손해배상",
      "위약금",
      "합의금",
      "합의서",
      "각서",
      "내용증명",
      "소송",
      "중재",
      "면책",
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

function spansOverlap(a: RawHit, b: RawHit): boolean {
  return a.index < b.index + b.value.length && b.index < a.index + a.value.length;
}

function collect(text: string): RawHit[] {
  const hits: RawHit[] = [];
  // RULES is ordered most-specific-first; when two rules match overlapping
  // spans (a 16-digit run that also contains a resident number) the earlier
  // rule wins, so the same characters are never counted or masked twice.
  for (const rule of RULES) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const value = match[0];
      if (!value) continue;
      if (rule.validate && !rule.validate(value)) continue;
      const hit: RawHit = { rule, value, index: match.index };
      if (hits.some((existing) => spansOverlap(existing, hit))) continue;
      hits.push(hit);
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
  const residual: string[] = [];
  let score = 0;
  let redactable = 0;
  let redactedChars = 0;
  let unmaskable = 0;

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
    } else {
      unmaskable += list.length;
      if (!residual.includes(rule.label)) residual.push(rule.label);
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
    unmaskable,
    residual,
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
