import 'server-only';

import { db, optionDailyMarks, optionPositions } from '@/lib/db';
import { readStoredCalendar } from '@/lib/market-data/calendar-store';
import { lastCompletedSessionDateISO } from '@/lib/market-data/market-clock';
import { getOptionSnapshots } from '@/lib/market-data/massive';

import { markOptionRecords } from './option-mark';

/**
 * The option MODEL-MARK recorder — the ONLY writer of `option_daily_marks`
 * (the `price-history.ts` / `close-sync.ts` single-writer discipline). One
 * row per tracked contract per completed NY session, written once and never
 * rewritten: a recorded mark is an immutable record of what the market's own
 * volatility surface said that evening.
 *
 * It rides the existing 23:30 UTC weekday `refresh-history` cron — no new cron
 * slot, no `vercel.json` entry. 23:30 UTC is 19:30 ET, after the close, so the
 * snapshot it marks from carries the session's final IV and the official
 * underlying close.
 *
 * UNVERIFIED, and called out deliberately: whether the vendor still returns
 * `implied_volatility` / `greeks` post-close on our tier. If it does not, no
 * row is written that night — an honest hole, exactly like a no-trade day —
 * and the morning-after check of this endpoint's `optionMarks` count is what
 * settles it. Nothing is invented to fill the gap.
 *
 * Errors degrade to "record what succeeded": message-only logs (never a key,
 * a header or a URL), no throw that could sink the equity history run beside
 * it.
 */
export async function recordOptionMarks(): Promise<number> {
  const contracts = await db
    .selectDistinct({
      ticker: optionPositions.ticker,
      underlying: optionPositions.underlying,
    })
    .from(optionPositions);
  if (contracts.length === 0) return 0;

  // Calendar overrides are REQUIRED here, unlike the `price-history.ts` /
  // `close-sync.ts` precedent that passes `[]`. Their safety argument — "a
  // holiday called 'completed' simply yields no usable data, so recording
  // self-corrects" — is true for a BAR-driven sync and false for this one:
  // the snapshot serves IV, greeks and a spot on a market holiday exactly as
  // it does after any close (the same vendor behaviour verified post-close on
  // 2026-08-15). Without overrides, `regularSessionFor` only rejects weekends,
  // so this cron (Mon–Fri) would write a mark on every weekday holiday: same
  // IV, same delta, the previous session's spot, one day less time value — a
  // pure-theta phantom point on a day the market never opened. It would land
  // on the chart as a trading day, become the next session's day-change
  // basis, and `onConflictDoNothing` would make it permanent (bug audit,
  // 2026-08-15).
  const { overrides } = await readStoredCalendar();
  const lastCompleted = lastCompletedSessionDateISO(Date.now(), overrides);
  if (lastCompleted === null) return 0;

  const tickers = [...new Set(contracts.map((c) => c.ticker))];
  const underlyings = [...new Set(contracts.map((c) => c.underlying))];

  const { quotes, spots } = await getOptionSnapshots(tickers, underlyings);
  // What WE recorded as each contract's underlying, so a vendor disagreement
  // cannot price a mark off the wrong company and persist it forever.
  const expectedUnderlyings = new Map(contracts.map((c) => [c.ticker, c.underlying]));
  const records = markOptionRecords(quotes, spots, Date.now(), expectedUnderlyings);
  if (records.size === 0) return 0;

  // Keyed on the MAP KEY, not `record.ticker`. The map key is the string WE
  // requested; `record.ticker` is the vendor's echo, and `getOptionSnapshots`
  // performs the requested-vs-returned reconciliation precisely because the
  // vendor uppercases. Every reader joins on our own stored string
  // (`inArray(optionDailyMarks.ticker, tickers)`), so persisting the vendor's
  // form would give the worst-shaped failure available: rows written, cron
  // reporting a healthy count, chart and day figures silently empty forever.
  // `close-sync.ts` already writes the requested ticker; this matches it.
  const rows = [...records.entries()].map(([ticker, record]) => ({
    ticker,
    asOf: lastCompleted,
    mark: record.mark,
    underlyingPrice: record.underlyingPrice,
    impliedVolatility: record.impliedVolatility,
    delta: record.delta,
    rate: record.rate,
  }));

  // Per row, deliberately NOT one batch: every persisted figure is
  // vendor-derived, and `numeric(20,8)` caps at 12 integer digits — one absurd
  // upstream IV or spot would make a single `values([...])` throw and cost the
  // WHOLE night's marks for every contract (security review, 2026-08-15). The
  // contract count here is the user's own position count, so the extra
  // statements are cheap; losing an evening that can never be re-recorded is
  // not. A mark is recorded ONCE per session — re-running the night is a no-op
  // by primary key, and a later run can never overwrite the evening's figure.
  let persisted = 0;
  for (const row of rows) {
    try {
      // `.returning()` so the count is what was RECORDED, not what was
      // attempted: with `onConflictDoNothing` a re-run of an already-recorded
      // session would otherwise report a healthy figure while writing nothing.
      // This count is the plan's designated signal for its one unverified
      // assumption (that IV survives post-close), so it has to mean what it
      // says.
      const written = await db
        .insert(optionDailyMarks)
        .values(row)
        .onConflictDoNothing()
        .returning({ ticker: optionDailyMarks.ticker });
      persisted += written.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'mark persist failed';
      console.error(`Option mark persist failed for ${row.ticker}: ${message}`);
    }
  }

  return persisted;
}
