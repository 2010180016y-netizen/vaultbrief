import { splitSentences } from "./chunk";
import type { Brief } from "./types";

/**
 * Simulator used when no Firebase project is configured.
 *
 * It is a classic extractive summariser (word frequency, position bias): it
 * reads the text and picks sentences. It is NOT a language model and every
 * receipt it produces is marked `simulated: true` in the UI, so the app can be
 * demonstrated and tested end to end without claiming a model ran.
 */

const STOP = new Set(
  `a an the and or but if then than that this these those of to in on for with without from by as at is are was were be been being it its we you they he she i not no do does did has have had will would can could should may might must more most other such only own same so very just also into over under about after before between during above below up down out off again further once here there when where why how all any both each few nor too s t don now`.split(
    /\s+/,
  ),
);

function score(text: string): { sentence: string; value: number; index: number }[] {
  const sentences = splitSentences(text);
  const freq = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    if (word.length < 3 || STOP.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return sentences.map((sentence, index) => {
    const words = sentence.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
    let value = 0;
    for (const word of words) {
      if (STOP.has(word)) continue;
      value += freq.get(word) ?? 0;
    }
    // Normalise by length so long sentences do not win by default, and give a
    // small bonus to the opening of the document.
    const normalised = value / Math.sqrt(Math.max(4, words.length));
    return { sentence: sentence.trim(), value: normalised * (index === 0 ? 1.35 : 1), index };
  });
}

const FLAG_PATTERN =
  /\b(must|shall|deadline|due|risk|penalt|lawsuit|fine|terminate|expires?|by \d{1,2}|before \d{1,2}|within \d+|amount|total|₩|\$|원|기한|위약|손해|만료)\b/i;

export function extractiveBrief(text: string, titleFallback = "Brief"): Brief {
  const ranked = score(text);
  if (ranked.length === 0) {
    return { title: titleFallback, tldr: text.slice(0, 160), points: [], flags: [] };
  }
  const ordered = [...ranked].sort((a, b) => a.index - b.index);
  const top = [...ranked].sort((a, b) => b.value - a.value);
  const tldrSource = top[0].sentence;
  const tldr = tldrSource.length > 220 ? `${tldrSource.slice(0, 217)}…` : tldrSource;

  const points = top
    .slice(1, 6)
    .sort((a, b) => a.index - b.index)
    .map((item) => (item.sentence.length > 160 ? `${item.sentence.slice(0, 157)}…` : item.sentence));

  const flags = ordered
    .filter((item) => FLAG_PATTERN.test(item.sentence))
    .slice(0, 3)
    .map((item) => (item.sentence.length > 140 ? `${item.sentence.slice(0, 137)}…` : item.sentence));

  const title = buildTitle(text, titleFallback);
  return { title, tldr, points, flags };
}

function buildTitle(text: string, titleFallback: string): string {
  const firstLine = text.split(/\n/).map((l) => l.trim()).find((l) => l.length > 0 && l.length < 90);
  if (firstLine && !FLAG_PATTERN.test(firstLine) && firstLine.split(/\s+/).length <= 12) {
    return firstLine.replace(/[.]$/, "");
  }
  const ranked = score(text).sort((a, b) => b.value - a.value);
  if (ranked.length === 0) return titleFallback;
  const words = ranked[0].sentence.split(/\s+/).slice(0, 7).join(" ");
  return words.replace(/[.,;:]$/, "") || titleFallback;
}
