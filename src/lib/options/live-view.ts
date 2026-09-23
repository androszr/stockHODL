import 'server-only';

import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import { db, optionDailyMarks, optionPositions } from '@/lib/db';
import { fetchMarketStatusBestEffort } from '@/lib/holdings/live-view';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { dec } from '@/lib/money';
import { getOptionSnapshots } from '@/lib/market-data/massive';
import type { OptionQuoteOutcome } from '@/lib/market-data/options-types';
import type { Candle, MarketSessionInfo } from '@/lib/market-data/provider';

import { fetchOptionsTotalTrendBestEffort, fetchOptionTrendsBestEffort } from '@/lib/trend/load';

import { syncOptionDailyCloses } from './close-sync';
import { MAX_MARK_BASIS_AGE_DAYS, type PreviousMark } from './fresh-print';
import { addCalendarDaysISO } from './ny-dates';
import type { TrendSlot } from '@/lib/trend/day-trend';

import type { OptionPositionRow } from './options-payload';

/**
 * The Options LOADER — the one data walk the page (initial render) and
 * `GET /api/quotes/options` (the 60 s poll) both run: user rows → deduped
 * vendor batch → daily-bar sync → market status. DELIBERATELY PARALLEL to
 * the Holdings and Watchlist walks (the watchlist rationale,
 * docs/context.md): option tickers never enter `loadHoldingsInputs`, the
 * Holdings vendor batch or either SSE route — the portfolio's payload stays
 * byte-identical to before this feature. The bars come from the TTL-cached
 * `syncOptionDailyCloses` (2026-08-15) — never a per-poll aggregates
 * fan-out — and feed the freshest-print resolver; the equity cache tables
 * (`latest_quotes`, `price_snapshots`) stay untouched.
 */

export interface LoadedOptions {
  /** Insertion-ordered (oldest lot first) — the only ordering for now. */
  rows: OptionPositionRow[];
  quotes: Map<string, OptionQuoteOutcome>;
  /** Trailing daily bars per ticker, for `resolveOptionPrints`. */
  bars: Map<string, Candle[]>;
  /**
   * Underlying spot per symbol, from the SAME snapshot batch as the quotes —
   * the model mark's other input. Absent = no mark for that contract, i.e.
   * today's traded-price behaviour, never a broken card.
   */
  spots: Map<string, string>;
  /**
   * The ≤2 most recent recorded marks per ticker, NEWEST FIRST, up to and
   * INCLUDING today's NY date. Two, because while the market is shut the day
   * figure is the move between the last two recorded evenings; the resolver
   * applies the strictly-before-today rule itself on the running branch.
   */
  recentMarks: Map<string, PreviousMark[]>;
  /**
   * OCC ticker to its five-session trend strip, holes included. Loaded here
   * rather than in the composer so `composeOptionsPayload` stays pure and the
   * 60s poll re-composes without a second database walk — the
   * `HoldingsInputs.trends` precedent.
   */
  trends: Map<string, TrendSlot[]>;
  /** The unexpired book summed, USD — `LoadedOptionsInputs.summaryTrend`. */
  summaryTrend?: TrendSlot[];
  market: MarketSessionInfo;
}

export async function loadOptionsInputs(userId: string): Promise<LoadedOptions> {
  const rawRows = await db
    .select({
      id: optionPositions.id,
      ticker: optionPositions.ticker,
      underlying: optionPositions.underlying,
      contractType: optionPositions.contractType,
      strikePrice: optionPositions.strikePrice,
      expirationDate: optionPositions.expirationDate,
      sharesPerContract: optionPositions.sharesPerContract,
      quantity: optionPositions.quantity,
      entryPrice: optionPositions.entryPrice,
      tradeDate: optionPositions.tradeDate,
      fees: optionPositions.fees,
    })
    .from(optionPositions)
    .where(eq(optionPositions.userId, userId))
    .orderBy(asc(optionPositions.createdAt));

  // `contractType` is checked, never cast wholesale — the DB only ever
  // receives 'call' | 'put' through the validated action, but the column
  // type is text (the `side` precedent in the Holdings loader).
  const rows: OptionPositionRow[] = rawRows.map((r) => ({
    ...r,
    contractType: r.contractType === 'put' ? 'put' : 'call',
  }));

  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const underlyings = [...new Set(rows.map((r) => r.underlying))];

  // Best-effort quotes AND underlying spots — ONE mixed snapshot batch, the
  // same single request per poll as before (2 contracts + 2 underlyings = 4
  // tickers today). `getOptionSnapshots` degrades per-chunk internally, but
  // even a wholesale throw must not take the tab down — the cards then
  // render their dash state (`fetchQuotesBestEffort` discipline), and an
  // empty spots map simply means no mark, i.e. the pre-2026-08-15 behaviour.
  let quotes = new Map<string, OptionQuoteOutcome>();
  let spots = new Map<string, string>();
  try {
    const snapshots = await getOptionSnapshots(tickers, underlyings);
    quotes = snapshots.quotes;
    spots = snapshots.spots;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'option quote fetch failed';
    console.error(`Option quote lookup failed: ${message}`);
    quotes = new Map();
    spots = new Map();
  }

  // Best-effort bars: the sync degrades per-ticker internally, but even a
  // wholesale throw degrades to an empty map — cards fall back to plain
  // snapshot behavior, never a broken tab.
  let bars = new Map<string, Candle[]>();
  try {
    bars = await syncOptionDailyCloses(tickers);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'option close sync failed';
    console.error(`Option close sync failed: ${message}`);
    bars = new Map();
  }

  // Best-effort recent marks: the TWO newest recorded marks per ticker, in
  // ONE query for every ticker — never one query per contract.
  //
  // The upper bound is today's NY date INCLUSIVE (not strictly before, as it
  // once was), because after the 19:30 ET cron the row for the LAST COMPLETED
  // session carries today's date, and the shut-market rule must be able to see
  // it. Safe only because `resolveOptionPrints` keeps its own `asOf < today`
  // guard on the running branch — that guard is what still stops the cron's
  // own row from becoming its own comparison base and manufacturing a 0,00%.
  //
  // The floor is 2 × the max basis age: the newer mark must be ≤5 days old AND
  // the gap ≤5 days, so no row outside 10 days can ever form a valid pair.
  //
  // A failure degrades to an empty map: no pair on either branch, i.e. an
  // em-dash — never a mark measured against a traded close, never a zero.
  let recentMarks = new Map<string, PreviousMark[]>();
  if (tickers.length > 0) {
    try {
      const todayISO = nyDateISOAt(Date.now());
      const markRows = await db
        .select({
          ticker: optionDailyMarks.ticker,
          asOf: optionDailyMarks.asOf,
          mark: optionDailyMarks.mark,
        })
        .from(optionDailyMarks)
        .where(
          and(
            inArray(optionDailyMarks.ticker, tickers),
            lte(optionDailyMarks.asOf, todayISO),
            gte(
              optionDailyMarks.asOf,
              addCalendarDaysISO(todayISO, -2 * MAX_MARK_BASIS_AGE_DAYS),
            ),
          ),
        )
        .orderBy(desc(optionDailyMarks.asOf));
      // Descending by date, so pushing in row order keeps each list
      // newest-first — the order `resolveOptionPrints` documents and relies on.
      for (const row of markRows) {
        const list = recentMarks.get(row.ticker);
        if (list === undefined) {
          recentMarks.set(row.ticker, [{ asOf: row.asOf, mark: row.mark }]);
        } else if (list.length < 2) {
          list.push({ asOf: row.asOf, mark: row.mark });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'recent mark read failed';
      console.error(`Option recent-mark read failed: ${message}`);
      recentMarks = new Map();
    }
  }

  // Best-effort, and deliberately NOT folded into the recent-mark read above:
  // that query is bounded by `MAX_MARK_BASIS_AGE_DAYS` for the day-pair rule
  // and widening it would loosen a guard that exists for a different reason.
  const trends = await fetchOptionTrendsBestEffort(tickers);
  // Unexpired lots only — the set the visible "Options" total describes.
  const todayISO = nyDateISOAt(Date.now());
  const summaryTrend = await fetchOptionsTotalTrendBestEffort(
    rows
      .filter((row) => row.expirationDate >= todayISO)
      .map((row) => ({
        key: row.ticker,
        units: dec(row.quantity).times(dec(row.sharesPerContract)).toString(),
        currency: 'USD',
      })),
  );

  const market = await fetchMarketStatusBestEffort();

  return { rows, quotes, bars, spots, recentMarks, trends, summaryTrend, market };
}
