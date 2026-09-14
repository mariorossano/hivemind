export const SEARCH_Q_MAX = 200;
export const SEARCH_TOKEN_CAP = 8;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_SNIPPET = 220;

export function parseSearchQuery(raw: string): string[] {
  const q = raw.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, SEARCH_Q_MAX);
  if (!q) return [];
  const tokens: string[] = [];
  let i = 0;
  while (i < q.length && tokens.length < SEARCH_TOKEN_CAP) {
    while (q[i] === " ") i += 1;
    if (i >= q.length) break;
    if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      const phrase = (end === -1 ? q.slice(i + 1) : q.slice(i + 1, end)).trim();
      if (phrase) tokens.push(phrase);
      i = end === -1 ? q.length : end + 1;
      continue;
    }
    let j = i;
    while (j < q.length && q[j] !== " ") j += 1;
    tokens.push(q.slice(i, j));
    i = j;
  }
  return tokens;
}

/** UI live search: two+ chars, a seq, or a non-ASCII mark (✅, CJK). */
export function isLiveSearchQuery(raw: string): boolean {
  const q = raw.trim();
  if (!q) return false;
  if (q.length >= 2) return true;
  if (/^\d+$/.test(q)) return true;
  return /[^\x00-\x7F]/.test(q);
}

export function likeNeedle(token: string): string {
  return `%${token.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&")}%`;
}

export function clampSearchLimit(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Number(raw) : SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(n)));
}

export function snippetAround(body: string, tokens: string[], max = SEARCH_SNIPPET): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let at = 0;
  for (const token of tokens) {
    const i = lower.indexOf(token.toLowerCase());
    if (i >= 0) {
      at = i;
      break;
    }
  }
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
