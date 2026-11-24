/**
 * Paragraph aware splitter.
 *
 * Chunking matters for hybrid inference: the on-device model has a small
 * context window, so anything longer must be summarised map-reduce style
 * (summarise each chunk, then summarise the summaries). The same splitter is
 * used for cloud requests so that latency and cost stay predictable.
 */

export interface ChunkOptions {
  /** Soft maximum characters per chunk. */
  budget: number;
  /** Characters repeated from the end of the previous chunk. */
  overlap?: number;
}

export function splitText(text: string, { budget, overlap = 0 }: ChunkOptions): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [];
  if (clean.length <= budget) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    if (overlap > 0 && current.length > overlap) {
      current = current.slice(-overlap);
    } else {
      current = "";
    }
  };

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) continue;

    if (piece.length > budget) {
      // A single huge paragraph: fall back to sentence, then hard splits.
      for (const sentence of splitSentences(piece)) {
        if (current.length + sentence.length + 1 > budget) push();
        if (sentence.length > budget) {
          for (let i = 0; i < sentence.length; i += budget) {
            const slice = sentence.slice(i, i + budget);
            if (current.length + slice.length > budget) push();
            current += (current ? " " : "") + slice;
          }
        } else {
          current += (current ? " " : "") + sentence;
        }
      }
      continue;
    }

    if (current.length + piece.length + 2 > budget) push();
    current += (current ? "\n\n" : "") + piece;
  }
  push();

  return chunks.filter((c) => c.trim().length > 0);
}

export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?。！？\n]+[.!?。！？]+["')\]]*|[^.!?。！？\n]+$/g);
  return (parts ?? [text]).map((s) => s.trim()).filter(Boolean);
}

/** Rough token estimate. ~4 characters per token for mixed English text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
