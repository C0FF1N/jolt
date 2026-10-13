export type Bounded = {
  text: string;
  truncated: boolean;
  /** Offset to pass to continue reading; only meaningful when truncated. */
  nextOffset: number;
  totalChars: number;
  start: number;
  end: number;
};

/**
 * Cuts `text` to at most `maxChars` starting at `offset`, preferring a line
 * boundary so YAML rows are never split. maxChars <= 0 means unlimited.
 * Never truncates silently: callers must surface `truncated`/`nextOffset`.
 */
export function boundText(
  text: string,
  { maxChars, offset = 0 }: { maxChars: number; offset?: number },
): Bounded {
  const total = text.length;
  // Offsets we hand out are either line starts or the result of a hard cut of an
  // oversized line; honour them exactly (re-aligning would repeat the same page forever).
  const start = Math.max(0, Math.min(offset, total));
  if (maxChars <= 0 || total - start <= maxChars) {
    return { text: text.slice(start), truncated: false, nextOffset: total, totalChars: total, start, end: total };
  }
  let end = start + maxChars;
  const nl = text.lastIndexOf("\n", end - 1);
  if (nl > start) end = nl + 1;
  return {
    text: text.slice(start, end),
    truncated: true,
    nextOffset: end,
    totalChars: total,
    start,
    end,
  };
}

export function defaultMaxSnapshotChars(): number {
  const raw = process.env.BROWSERMCP_MAX_SNAPSHOT_CHARS;
  if (raw === undefined || raw === "") return 200_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200_000;
}
