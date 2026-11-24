/**
 * Paragraph aware splitter.
 *
 * Chunking matters for hybrid inference: the on-device model has a small
 * context window, so anything longer must be summarised map-reduce style
 * (summarise each chunk, then summarise the summaries). The same splitter is
 * used for cloud requests so that latency and cost stay predictable.
 *
 * Invariants (locked by tests):
 *   - no chunk is longer than `budget`;
 *   - the overlap carried between chunks never becomes a chunk on its own
 *     (an overlap-only chunk used to be emitted and summarised as if it were
 *     real content);
 *   - every character of the input appears in at least one chunk.
 */

export interface ChunkOptions {
  /** Soft maximum characters per chunk. */
  budget: number;
  /** Characters repeated for context from the end of the previous chunk. */
  overlap?: number;
}

export function splitText(text: string, { budget, overlap = 0 }: ChunkOptions): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [];
  const cap = Math.max(200, Math.floor(budget));
  if (clean.length <= cap) return [clean];

  const lap = Math.max(0, Math.min(Math.floor(overlap), Math.floor(cap / 4)));
  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  /** Characters added since the last flush; 0 means `current` is only overlap. */
  let fresh = 0;

  const flush = () => {
    if (fresh > 0 && current.trim()) chunks.push(current.trim());
    current = lap > 0 && current.length > lap ? current.slice(-lap) : "";
    fresh = 0;
  };

  const append = (piece: string) => {
    if (current.length + piece.length + 1 > cap) {
      if (fresh > 0) flush();
      // If the overlap still leaves no room, drop it rather than exceed the cap.
      if (current.length + piece.length + 1 > cap) current = "";
    }
    current += (current ? " " : "") + piece;
    fresh += piece.length;
  };

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) continue;

    if (piece.length <= cap) {
      append(piece);
      continue;
    }

    // A single huge paragraph: fall back to sentences, then hard splits.
    for (const sentence of splitSentences(piece)) {
      if (sentence.length <= cap) {
        append(sentence);
        continue;
      }
      let index = 0;
      while (index < sentence.length) {
        const room = cap - current.length - (current ? 1 : 0);
        const take = Math.max(1, room);
        const slice = sentence.slice(index, index + take);
        current += (current ? " " : "") + slice;
        fresh += slice.length;
        index += slice.length;
        if (index < sentence.length) flush();
      }
    }
  }
  flush();

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?。！？\n]+[.!?。！？]+["')\]]*|[^.!?。！？\n]+$/g);
  return (parts ?? [text]).map((s) => s.trim()).filter(Boolean);
}

/** Rough token estimate. ~4 characters per token for mixed English text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
