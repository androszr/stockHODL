/**
 * Defensive read-side parsers for the two jsonb columns on `news_articles`.
 * Pure and isomorphic (no env, no DB) so unit tests import them directly.
 *
 * The columns hold the vendor arrays verbatim — loosely validated at write —
 * and the vendor's shape beyond `insights[].ticker` is UNVERIFIED: every
 * field here is optional, an unknown `sentiment` value survives as its raw
 * word (rendered muted, never a colored guess), and malformed entries are
 * dropped, never thrown. A crash on a jsonb row would take the whole detail
 * page with it.
 */

export interface NewsInsight {
  ticker: string;
  /** The vendor's word, verbatim — 'positive' | 'negative' | anything. */
  sentiment: string | null;
}

/** jsonb → per-ticker insights; anything that is not `{ ticker: string }` drops. */
export function parseNewsInsights(raw: unknown): NewsInsight[] {
  if (!Array.isArray(raw)) return [];
  const insights: NewsInsight[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.ticker !== 'string' || record.ticker === '') continue;
    const ticker = record.ticker.toUpperCase();
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    insights.push({
      ticker,
      sentiment: typeof record.sentiment === 'string' ? record.sentiment : null,
    });
  }
  return insights;
}

/** jsonb → keyword strings; non-strings drop, order preserved. */
export function parseNewsKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === 'string' && k !== '');
}
