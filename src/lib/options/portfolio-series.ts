import 'server-only';

import { and, asc, eq, gte, inArray, lte, min } from 'drizzle-orm';
import { z } from 'zod';

import { shouldOverlayFormingDay } from '@/lib/charts/forming-day';
import { OPTIONS_CHART_RANGES, resolveRange } from '@/lib/charts/ranges';
import { emptySeries, type SeriesPayload } from '@/lib/charts/series';
import { db, optionDailyCloses, optionDailyMarks, optionPositions } from '@/lib/db';
import { nyDateISOAt, regularSessionFor } from '@/lib/market-data/market-clock';
import { getOptionSnapshots, massiveProvider } from '@/lib/market-data/massive';
import {
  everyTickerHasToday,
  optionCardOverlayPrice,
  optionOverlayRows,
} from '@/lib/options/forming-overlay';
import { markOptionQuotes } from '@/lib/options/option-mark';
import type { OptionPositionRow } from '@/lib/options/options-payload';
import {
  composeOptionsSeries,
  disclosedEstimatedFrom,
  mergeOptionValuations,
  type ComposeOptionsSeriesOptions,
  type OptionValuationRow,
} from '@/lib/options/value-series';

/**
 * The options value series, extracted VERBATIM from the two Server Actions in
 * `src/app/(app)/options/actions.ts` (2026-08-18) so `/api/mobile/v1/series/
 * options` can call the same body the web calls — the arrangement stage S1
 * already applied to every other action the phone needed. The actions keep
 * their session gate and now do nothing else; behaviour is unchanged.
 *
 * MARKS FIRST, TRADED CLOSES BEHIND THEM (2026-08-20, on the user's decision
 * — this REVERSES the marks-only rule of 2026-08-15 for PAST dates only).
 * Marks (`option_daily_marks`) began on 2026-08-17 and cannot be reconstructed
 * backwards: there is no historical IV/greeks endpoint on this tier, so a
 * backfilled mark would be fabricated. Real traded closes
 * (`option_daily_closes`) CAN be fetched back three months, and now are. So:
 * a date with a mark is priced from the mark (the number the cards and totals
 * use, so the line's tail agrees with the card), a date with only a traded
 * close is priced from that close, and a date with neither stays a HOLE.
 *
 * The 2026-08-15 concern was real and is not dismissed: on a thin contract a
 * mark and the same day's close can differ by tens of percent, so the line CAN
 * step once, at the date recording began. That is why the payload carries
 * `estimatedFrom` and both surfaces print a caption naming it — the step is
 * disclosed rather than mysterious. What is NOT allowed is filling a hole with
 * an interpolation, a carry-forward, or a fabricated mark.
 *
 * Every refusal path answers `emptySeries()`, indistinguishable from "nothing
 * recorded yet" — a ticker the user does not track must never be
 * distinguishable from one that has no marks.
 */

export const optionsRangeSchema = z.enum(OPTIONS_CHART_RANGES);

/**
 * Bounded shape check for an OCC-form vendor ticker arriving from a URL or a
 * client call. Ownership — not this regex — is the security gate: the queries
 * below are scoped to the caller's own `option_positions` rows, so a ticker
 * that is merely well-formed still charts nothing. The bound exists so a
 * hand-crafted request cannot push an arbitrarily long string at the database.
 */
export const contractTickerSchema = z.string().trim().min(1).max(64);

/** The lot columns both series read, in one place. */
export const LOT_COLUMNS = {
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
} as const;

/** What `LOT_COLUMNS` selects: every numeric arrives as a string, as always. */
type RawLotRow = Omit<OptionPositionRow, 'contractType'> & { contractType: string };

/** The `contractType` narrowing the loader uses — text column, checked. */
function narrowRows(rows: RawLotRow[]): OptionPositionRow[] {
  return rows.map((r) => ({
    ...r,
    contractType: r.contractType === 'put' ? 'put' : 'call',
  }));
}

export async function loadUserOptionLots(userId: string): Promise<OptionPositionRow[]> {
  const rows = await db
    .select(LOT_COLUMNS)
    .from(optionPositions)
    .where(eq(optionPositions.userId, userId))
    .orderBy(asc(optionPositions.createdAt));
  return narrowRows(rows);
}

/** The whole tracked book's combined value over one of the five ranges. */
export async function userOptionsSeries(
  userId: string,
  range: string,
): Promise<SeriesPayload> {
  // The range never reaches a query as a raw string.
  const parsedRange = optionsRangeSchema.safeParse(range);
  if (!parsedRange.success) return emptySeries();

  const rawRows = await db
    .select(LOT_COLUMNS)
    .from(optionPositions)
    .where(eq(optionPositions.userId, userId));
  if (rawRows.length === 0) return emptySeries();

  const rows = narrowRows(rawRows);
  const tickers = [...new Set(rows.map((r) => r.ticker))];

  // The recording anchor: the earliest date ANY source can price — the lesser
  // of the first model mark and the first backfilled traded close over the
  // same ticker scope. Both null = nothing recorded yet, the honest "just
  // started" empty state, never a provider query.
  const [{ markAnchor }] = await db
    .select({ markAnchor: min(optionDailyMarks.asOf) })
    .from(optionDailyMarks)
    .where(inArray(optionDailyMarks.ticker, tickers));
  const [{ closeAnchor }] = await db
    .select({ closeAnchor: min(optionDailyCloses.asOf) })
    .from(optionDailyCloses)
    .where(inArray(optionDailyCloses.ticker, tickers));
  const anchor = earlier(markAnchor, closeAnchor);
  if (anchor === null) return emptySeries();

  const today = nyDateISOAt(Date.now());
  const resolved = resolveRange(parsedRange.data, {
    today,
    anchorDate: anchor,
  });
  // The options ranges are all daily by construction; anything else is empty.
  if (resolved === null || resolved.kind !== 'daily') return emptySeries(anchor);

  const marks = await db
    .select({
      ticker: optionDailyMarks.ticker,
      asOf: optionDailyMarks.asOf,
      price: optionDailyMarks.mark,
    })
    .from(optionDailyMarks)
    .where(
      and(
        inArray(optionDailyMarks.ticker, tickers),
        gte(optionDailyMarks.asOf, resolved.from),
        lte(optionDailyMarks.asOf, resolved.to),
      ),
    )
    .orderBy(asc(optionDailyMarks.asOf));

  const closes = await db
    .select({
      ticker: optionDailyCloses.ticker,
      asOf: optionDailyCloses.asOf,
      price: optionDailyCloses.close,
    })
    .from(optionDailyCloses)
    .where(
      and(
        inArray(optionDailyCloses.ticker, tickers),
        gte(optionDailyCloses.asOf, resolved.from),
        lte(optionDailyCloses.asOf, resolved.to),
      ),
    )
    .orderBy(asc(optionDailyCloses.asOf));

  // BOOK-WIDE: a date that cannot price every active lot is a HOLE, not a
  // partial sum (2026-08-20 fix). Mark and close coverage differ per contract
  // — a thin contract that did not print on a Tuesday would otherwise drop out
  // of that Tuesday's TOTAL and plot a number the book never had.
  const bookOverrides = await massiveProvider.getCalendarOverrides();
  const bookExisting = [...marks, ...closes];
  const marksForChart = shouldOverlayFormingDay({
    todayISO: today,
    nowMs: Date.now(),
    session: regularSessionFor(today, bookOverrides),
    existingDates: everyTickerHasToday(tickers, bookExisting, today) ? [today] : [],
  })
    ? await overlayFormingOptionMarks(
        tickers,
        [...new Set(rows.map((r) => r.underlying))],
        today,
        marks,
        closes,
      )
    : marks;
  return withEstimatedFrom(
    marksForChart,
    closes,
    rows,
    { fromISO: resolved.from, toISO: resolved.to },
    { requireEveryActiveLot: true },
  );
}

/** The earlier of two optional ISO dates — plain string ordering, the
 *  `coverage.ts` convention. Null when neither exists. */
function earlier(a: string | null | undefined, b: string | null | undefined): string | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a < b ? a : b;
}

/**
 * The shared tail of both builders: merge marks over closes, compose, and
 * carry the seam onto the payload. `estimatedFrom` rides only when a mark
 * actually contributed — a chart made entirely of traded closes has nothing to
 * disclose, and the field then stays absent (the `p?`/`r?` precedent).
 *
 * It also stays absent when NO plotted point PRECEDES the seam (2026-08-20
 * fix): a contract added after this ship, before the cron's backfill leg has
 * run for it, draws a line made of marks only, and "earlier points are traded
 * closing prices" would then be a caption about points that are not on the
 * screen. Disclose the seam only when the line actually crosses it.
 */
function withEstimatedFrom(
  marks: readonly OptionValuationRow[],
  closes: readonly OptionValuationRow[],
  rows: readonly OptionPositionRow[],
  window: { fromISO: string; toISO: string },
  options: ComposeOptionsSeriesOptions = {},
): SeriesPayload {
  const merged = mergeOptionValuations(marks, closes);
  const payload = composeOptionsSeries(rows, merged.rows, window, options);
  const seam = disclosedEstimatedFrom(merged.estimatedFrom, payload.points);
  if (seam === null) return payload;
  return { ...payload, estimatedFrom: seam };
}

/**
 * ONE contract's mark series — `userOptionsSeries` narrowed to a single OCC
 * ticker for the contract detail page.
 *
 * The rows passed to the composer are the user's OWN lots of this contract,
 * so the basis (and therefore the Return mode) describes exactly the position
 * the page is about, not the whole options book.
 */
export async function optionContractSeries(
  userId: string,
  ticker: string,
  range: string,
): Promise<SeriesPayload> {
  const parsedTicker = contractTickerSchema.safeParse(ticker);
  const parsedRange = optionsRangeSchema.safeParse(range);
  if (!parsedTicker.success || !parsedRange.success) return emptySeries();

  const rawRows = await db
    .select(LOT_COLUMNS)
    .from(optionPositions)
    .where(
      and(eq(optionPositions.userId, userId), eq(optionPositions.ticker, parsedTicker.data)),
    );
  if (rawRows.length === 0) return emptySeries();

  const rows = narrowRows(rawRows);

  // This contract's own recording anchor — the whole-book anchor would start
  // the line before this contract had a single reading and draw a leading
  // hole. Marks ∪ closes, same as the book-wide builder.
  const [{ markAnchor }] = await db
    .select({ markAnchor: min(optionDailyMarks.asOf) })
    .from(optionDailyMarks)
    .where(eq(optionDailyMarks.ticker, parsedTicker.data));
  const [{ closeAnchor }] = await db
    .select({ closeAnchor: min(optionDailyCloses.asOf) })
    .from(optionDailyCloses)
    .where(eq(optionDailyCloses.ticker, parsedTicker.data));
  const anchor = earlier(markAnchor, closeAnchor);
  if (anchor === null) return emptySeries();

  const today = nyDateISOAt(Date.now());
  const resolved = resolveRange(parsedRange.data, {
    today,
    anchorDate: anchor,
  });
  if (resolved === null || resolved.kind !== 'daily') return emptySeries(anchor);

  const marks = await db
    .select({
      ticker: optionDailyMarks.ticker,
      asOf: optionDailyMarks.asOf,
      price: optionDailyMarks.mark,
    })
    .from(optionDailyMarks)
    .where(
      and(
        eq(optionDailyMarks.ticker, parsedTicker.data),
        gte(optionDailyMarks.asOf, resolved.from),
        lte(optionDailyMarks.asOf, resolved.to),
      ),
    )
    .orderBy(asc(optionDailyMarks.asOf));

  const closes = await db
    .select({
      ticker: optionDailyCloses.ticker,
      asOf: optionDailyCloses.asOf,
      price: optionDailyCloses.close,
    })
    .from(optionDailyCloses)
    .where(
      and(
        eq(optionDailyCloses.ticker, parsedTicker.data),
        gte(optionDailyCloses.asOf, resolved.from),
        lte(optionDailyCloses.asOf, resolved.to),
      ),
    )
    .orderBy(asc(optionDailyCloses.asOf));

  // Single contract: no `requireEveryActiveLot`. There is nothing to sum
  // ACROSS here — every lot on the screen shares one price, so an unpriced day
  // is already a hole and `partialDays` keeps its original meaning.
  const contractOverrides = await massiveProvider.getCalendarOverrides();
  const contractExisting = [...marks, ...closes];
  const marksForChart = shouldOverlayFormingDay({
    todayISO: today,
    nowMs: Date.now(),
    session: regularSessionFor(today, contractOverrides),
    existingDates: everyTickerHasToday([parsedTicker.data], contractExisting, today)
      ? [today]
      : [],
  })
    ? await overlayFormingOptionMarks(
        [parsedTicker.data],
        [...new Set(rows.map((r) => r.underlying))],
        today,
        marks,
        closes,
      )
    : marks;
  return withEstimatedFrom(
    marksForChart,
    closes,
    rows,
    { fromISO: resolved.from, toISO: resolved.to },
  );
}

/**
 * Today's still-forming mark (model mark else snapshot last — the card
 * price), appended onto the marks array in memory only. Never inserts into
 * option_daily_marks / option_daily_closes.
 */
async function overlayFormingOptionMarks(
  tickers: readonly string[],
  underlyings: readonly string[],
  today: string,
  marks: OptionValuationRow[],
  closes: OptionValuationRow[],
): Promise<OptionValuationRow[]> {
  try {
    const { quotes, spots } = await getOptionSnapshots(tickers, underlyings);
    const modelMarks = markOptionQuotes(quotes, spots, Date.now());
    const liveByTicker = new Map<string, string>();
    for (const ticker of tickers) {
      const outcome = quotes.get(ticker);
      const price = optionCardOverlayPrice({
        mark: modelMarks.get(ticker),
        snapshotPrice: outcome?.ok ? outcome.quote.price : undefined,
        snapshotPrevClose: outcome?.ok ? outcome.quote.prevClose : undefined,
      });
      if (price !== null) liveByTicker.set(ticker, price);
    }
    const overlay = optionOverlayRows({
      todayISO: today,
      liveByTicker,
      existingAsOf: [...marks, ...closes],
    });
    return overlay.length === 0 ? marks : [...marks, ...overlay];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'forming overlay failed';
    console.error(`Options series forming overlay failed: ${message}`);
    return marks;
  }
}
