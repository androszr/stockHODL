import 'server-only';

import { and, inArray } from 'drizzle-orm';

import { db, optionDailyCloses, optionDailyMarks } from '@/lib/db';
import { dec } from '@/lib/money';
import type { ClosePoint } from '@/lib/trend/day-trend';

import { mergeOptionValuations, type OptionValuationRow } from './value-series';

/**
 * Leaf reader for the option trend strip: every recorded valuation for a set
 * of contracts across a KNOWN set of sessions.
 *
 * A leaf under `recent-changes.ts`'s rule — it imports the db/schema, money,
 * and the pure merge, and nothing that reaches a vendor. Read-only; neither
 * option table is written here (`close-sync.ts` and `mark-sync.ts` remain
 * their single writers).
 *
 * **Two queries, both bounded by the session list.** The dates are known
 * before the read — the caller has already resolved the calendar — so this
 * matches `as_of` against that exact set rather than ranking a window. There
 * is no `row_number()` here and none is needed: six dates times the tracked
 * book is a small, exactly-specified read, and an unranked `IN` cannot drift
 * out of step with what the strip is about to draw. That is the difference
 * from the equity reader, which has no session list to lean on.
 *
 * **Precedence is not decided here.** `mergeOptionValuations` owns it — mark
 * beats traded close, neither yields no row — and re-deciding it in a second
 * place is how the chart and the tile would come to disagree about the same
 * evening. What this module adds is the `source` tag the merge does not carry,
 * recovered by asking whether a mark existed for that exact `(ticker, asOf)`.
 * The grader needs it because a change measured from a mark to a close is a
 * change of measuring instrument as much as a change of price.
 *
 * THROWS on a database failure, like `getRecentCloses`: the caller's
 * best-effort wrapper decides how to degrade.
 */
export async function getRecentOptionValuations(
  tickers: readonly string[],
  sessions: readonly string[],
): Promise<Map<string, ClosePoint[]>> {
  // drizzle's `inArray` errors on an empty list rather than matching nothing,
  // and a query for no contracts is a query worth not making.
  if (tickers.length === 0 || sessions.length === 0) return new Map();

  const uniqueTickers = [...new Set(tickers)];
  const dates = [...new Set(sessions)];

  const [markRows, closeRows] = await Promise.all([
    db
      .select({
        ticker: optionDailyMarks.ticker,
        asOf: optionDailyMarks.asOf,
        price: optionDailyMarks.mark,
      })
      .from(optionDailyMarks)
      .where(
        and(
          inArray(optionDailyMarks.ticker, uniqueTickers),
          inArray(optionDailyMarks.asOf, dates),
        ),
      ),
    db
      .select({
        ticker: optionDailyCloses.ticker,
        asOf: optionDailyCloses.asOf,
        price: optionDailyCloses.close,
      })
      .from(optionDailyCloses)
      .where(
        and(
          inArray(optionDailyCloses.ticker, uniqueTickers),
          inArray(optionDailyCloses.asOf, dates),
        ),
      ),
  ]);

  return tagValuations(markRows.map(normalize), closeRows.map(normalize));
}

/**
 * The pure half: merged valuations, grouped by ticker, each tagged with the
 * kind of number it is.
 *
 * Split out so the tagging is testable without a database — it is the part
 * with a decision in it. `mergeOptionValuations` still owns the precedence;
 * all this adds is the answer to "did a mark win here?", which the merge does
 * not carry and the grader cannot do without.
 */
export function tagValuations(
  marks: readonly OptionValuationRow[],
  closes: readonly OptionValuationRow[],
): Map<string, ClosePoint[]> {
  const byTicker = new Map<string, ClosePoint[]>();
  const markKeys = new Set(marks.map(valuationKey));
  const { rows } = mergeOptionValuations(marks, closes);

  for (const row of rows) {
    const point: ClosePoint = {
      asOf: row.asOf,
      close: row.price,
      source: markKeys.has(valuationKey(row)) ? 'mark' : 'close',
    };
    const list = byTicker.get(row.ticker);
    if (list) list.push(point);
    else byTicker.set(row.ticker, [point]);
  }

  return byTicker;
}

/** Ticker and date, joined on a separator neither field can contain. */
function valuationKey(row: { ticker: string; asOf: string }): string {
  return `${row.ticker}|${row.asOf}`;
}

/**
 * `numeric(20,8)` comes back zero-padded ('12.10000000'). Re-normalising
 * through `dec()` keeps the padding out of anything the grader formats, the
 * same courtesy `getRecentCloses` does — and it is a Decimal round trip, never
 * a float one.
 */
function normalize(row: { ticker: string; asOf: string; price: string }): OptionValuationRow {
  return { ticker: row.ticker, asOf: row.asOf, price: dec(row.price).toString() };
}
