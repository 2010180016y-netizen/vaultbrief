import type { Brief } from "./types";

/**
 * Prompts shared by both routes.
 *
 * The on-device model gets a shorter instruction than the cloud model: same
 * output shape, less scaffolding. Keeping one schema on both sides is what
 * makes the fallback invisible to the rest of the app.
 *
 * Language: both prompts ask for the brief in the language of the document.
 * Gemini Nano is created with `languages: ["en"]` (the only guaranteed option
 * on every Chrome build), but it still summarises Korean text and answers in
 * Korean, which is what a Korean document should get.
 */

export const BRIEF_KEYS = ["title", "tldr", "points", "flags"] as const;

const SHAPE = `{"title": "...", "tldr": "...", "points": ["..."], "flags": ["..."]}`;

export function onDevicePrompt(text: string): string {
  return [
    "Brief the text below for a busy reader.",
    `Reply with JSON only, no prose and no markdown fences, shaped exactly like ${SHAPE}.`,
    "title: max 8 words. tldr: max 30 words. points: 3 to 5 short facts. flags: risks, deadlines or amounts, or [] if none.",
    "Use only information from the text. Write in the language of the text.",
    "Keep any [REDACTED:...] placeholder exactly as written.",
    "",
    "TEXT:",
    text,
  ].join("\n");
}

export function cloudPrompt(text: string): string {
  return [
    "You are a briefing analyst. Produce a tight, factual brief of the document below for a busy professional reader.",
    "Rules:",
    "- Use only information present in the document. Do not add outside knowledge.",
    "- Title: at most 8 words, specific and concrete.",
    "- TL;DR: at most 40 words, one or two sentences, stating what the document is and what matters.",
    "- Points: 3 to 6 items. Each under 25 words. Prefer facts, numbers, names, dates.",
    "- Flags: risks, obligations, deadlines, amounts, or decisions required. Empty array when there are none.",
    "- Preserve any [REDACTED:...] placeholders exactly as written.",
    "- Write the brief in the language of the document.",
    "",
    "Respond with JSON only.",
    "",
    "DOCUMENT:",
    text,
  ].join("\n");
}

export function mergePrompt(summaries: string[]): string {
  return [
    "Below are briefs of consecutive parts of one longer document.",
    "Merge them into a single brief of the whole document without repeating yourself.",
    `Reply with JSON only, shaped exactly like ${SHAPE}.`,
    "Points: 4 to 6 items covering the whole document. Flags: only risks or deadlines that appear in the parts.",
    "Write in the language of the parts.",
    "",
    summaries.map((s, i) => `PART ${i + 1}:\n${s}`).join("\n\n"),
  ].join("\n");
}

/** Structured output schema handed to the cloud model. */
export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "At most 8 words." },
    tldr: { type: "string", description: "One or two sentences." },
    points: { type: "array", items: { type: "string" } },
    flags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "tldr", "points", "flags"],
} as const;

function asStringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, limit);
}

function clamp(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function tryParse(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Models sometimes wrap JSON in prose or fences even when told not to. Parse
 * defensively, and if there is no JSON at all, still render something useful
 * instead of throwing the whole run away.
 */
export function parseBrief(raw: string, fallbackTitle = "Brief"): Brief {
  const text = (raw ?? "").trim();
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (!parsed) continue;
    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? clamp(parsed.title.trim(), 120)
        : fallbackTitle;
    const tldr = typeof parsed.tldr === "string" ? clamp(parsed.tldr.trim()) : "";
    const points = asStringArray(parsed.points, 8).map((point) => clamp(point, 320));
    const flags = asStringArray(parsed.flags, 6).map((flag) => clamp(flag, 320));
    if (tldr || points.length > 0 || flags.length > 0) {
      return { title, tldr, points, flags };
    }
    // Valid JSON, empty content: keep the title instead of echoing raw JSON.
    if (typeof parsed.title === "string") return { title, tldr: "", points: [], flags: [] };
  }

  const prose = text
    .replace(/```[a-z]*/gi, " ")
    .replace(/[{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = prose
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return {
    title: fallbackTitle,
    tldr: clamp(sentences.slice(0, 2).join(" ") || prose.slice(0, 200)),
    points: sentences.slice(2, 6).map((sentence) => clamp(sentence, 320)),
    flags: [],
  };
}
