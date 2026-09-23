import { emptySeries, type ChartPoint, type SeriesPayload } from '@/lib/charts/series';
import { ZERO, dec, pctChange, toNumeric } from '@/lib/money';

import { utcNoonMs } from './ny-dates';
import { compactOptionLabel, type OptionPositionRow } from './options-payload';

/**
 * The options value series — pure and isomorphic, the `portfolio-series.ts`
 * philosophy at daily granularity: recorded valuations in, `SeriesPayload`
 * out,
 * all Decimal; the only money→float exit is chart geometry on the phone
 * (`PlotPoints.swift`).
 *
 * Honesty rules, exhaustively:
 * - A point exists only for a date with at least one recorded valuation —
 *   days with none stay HOLES, never interpolated, never carried forward.
 * - An active lot with no valuation on a date is excluded from BOTH value and
 *   basis that day (never zeroed) and marks the day partial — the caveat
 *   line names the count. On a SUM ACROSS CONTRACTS this is not enough (see
 *   {@link ComposeOptionsSeriesOptions.requireEveryActiveLot}): a partial sum
 *   is a wrong TOTAL, so the book-wide builder asks for the day to be a hole
 *   instead.
 * - `partialDays` counts EVERY day an active lot could not be priced —
 *   including the days the book-wide builder drops entirely (2026-08-20 fix).
 *   A dropped day is the most incompletely-priced day there is; leaving it out
 *   of the count made a chart showing 7 of 63 days say "missing quotes for 0
 *   days", which is the one thing this app does not do. The surface copy
 *   ("Missing quotes for N days in this range") is true of both kinds.
 * - A lot active in the window with ZERO readings ON A PLOTTED DAY is named in
 *   `excludedSymbols` — never silently absent. Readings that landed only on
 *   dropped days do not count as being on the chart, because they are not.
 * - `r` (simple return vs basis) rides only where the basis is nonzero —
 *   `toReturnPoints` compatibility, "percent of nothing" stays absent.
 * - Lots activate at `tradeDate` and leave the series after
 *   `expirationDate` — a stated v1 simplification (no exercise/assignment
 *   lifecycle).
 *
 * MARK / CLOSE PRECEDENCE (2026-08-20, reversing the marks-only rule of
 * 2026-08-15 on the user's decision): a date carrying a model MARK is priced
 * from the mark — that is the number the cards and totals use, so the chart's
 * recent tail and the card agree. A date with NO mark but a real traded CLOSE
 * is priced from the close, which is what gives the line the months that
 * predate mark recording. A date with neither produces no row, and therefore
 * no point: a hole, as always. {@link mergeOptionValuations} is where that
 * decision lives, and it reports the seam (`estimatedFrom`) so the surface can
 * say out loud where traded prices stop and estimates begin.
 */

/**
 * One recorded per-share VALUATION for a contract on a date — since
 * 2026-08-15 that is a model MARK (`option_daily_marks`), which is why this
 * carries a neutral `price` rather than a `close`: the series and the cards
 * must speak for the same kind of number. The math below never cared which.
 */
export interface OptionValuationRow {
  /** OCC-form vendor ticker. */
  ticker: string;
  /** NY calendar date, 'YYYY-MM-DD'. */
  asOf: string;
  /** Decimal string, per share. */
  price: string;
}

/** What {@link mergeOptionValuations} answers: the priced rows, plus the date
 *  from which a MODEL ESTIMATE was actually used. */
export interface MergedOptionValuations {
  rows: OptionValuationRow[];
  /** Earliest `asOf` at which a mark won — null when no mark contributed at
   *  all (every point is a real traded close, so there is nothing to
   *  disclose). */
  estimatedFrom: string | null;
}

/**
 * Marks ∪ closes, per `(ticker, asOf)`, with the precedence documented above:
 * MARK wins, traded CLOSE fills, neither → NO ROW (a hole; nothing here
 * interpolates or carries forward).
 *
 * Pure and isomorphic — no clock, no I/O, no arithmetic: prices are decimal
 * strings passed through untouched, so this cannot introduce a float.
 *
 * The seam is REAL and known: on dates carrying both, a thin contract's mark
 * and close can differ by tens of percent (measured 2026-08-20:
 * O:RXRX261120C00003500 0,45 vs 0,33). Preferring the mark therefore CAN draw
 * a visible step where recording began — one step, at one known date, which
 * `estimatedFrom` exists to name on the surface. The alternative (prefer the
 * close everywhere) would put the chart's last point at a different number
 * from the card's, which is the worse incoherence. Do not change the
 * precedence without saying so.
 */
export function mergeOptionValuations(
  marks: readonly OptionValuationRow[],
  closes: readonly OptionValuationRow[],
): MergedOptionValuations {
  const key = (row: OptionValuationRow) => `${row.ticker}\u0000${row.asOf}`;

  const byKey = new Map<string, OptionValuationRow>();
  for (const close of closes) byKey.set(key(close), close);

  let estimatedFrom: string | null = null;
  for (const mark of marks) {
    byKey.set(key(mark), mark);
    if (estimatedFrom === null || mark.asOf < estimatedFrom) estimatedFrom = mark.asOf;
  }

  // Ascending by date — the order the composer's callers already produce, and
  // the one `composeOptionsSeries` is documented against.
  const rows = [...byKey.values()].sort((a, b) =>
    a.asOf === b.asOf ? a.ticker.localeCompare(b.ticker) : a.asOf < b.asOf ? -1 : 1,
  );

  return { rows, estimatedFrom };
}

/**
 * Whether the seam is worth DISCLOSING on a given line — pure, and the answer
 * the payload's `estimatedFrom` carries.
 *
 * A caption reading "estimated values from D — earlier points are traded
 * closing prices" is a claim about points to the LEFT of D. When the line's
 * own first point is D (or later), there are none, and the caption would
 * describe a part of the chart that is not on the screen — true of a contract
 * added after the backfill ran, whose every plotted day is a mark. Nothing to
 * disclose, so the field stays absent (the `p?`/`r?` optional precedent).
 *
 * The same applies past the RIGHT edge: a mark whose date never became a point
 * (its day was a hole for the line as a whole) would name a date nothing on
 * the screen was priced from. Disclose only a seam the drawn line crosses.
 *
 * `points` are ascending by date, as `composeOptionsSeries` emits them.
 */
export function disclosedEstimatedFrom(
  estimatedFrom: string | null,
  points: readonly ChartPoint[],
): string | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (estimatedFrom === null || first === undefined || last === undefined) return null;
  const seam = utcNoonMs(estimatedFrom);
  return seam > first.t && seam <= last.t ? estimatedFrom : null;
}

/** How a caller tunes the composer's treatment of an incompletely-priced day. */
export interface ComposeOptionsSeriesOptions {
  /**
   * When true, a date on which ANY active lot has no valuation produces NO
   * point at all — a hole — instead of a partial sum (2026-08-20 fix).
   *
   * This is the BOOK-WIDE builder's setting and only its. Once closes fill in
   * behind the marks, coverage varies per contract: a thin contract that did
   * not print on a Tuesday would drop out of that Tuesday's TOTAL while the
   * liquid ones stayed in, plotting a total that was never the book's value
   * (measured on production data: up to 52% understated, with a phantom
   * "overnight gain" the next day when coverage returned). A total is either
   * of the whole book or it is not a total, so the day becomes a hole — the
   * same answer this app gives every other missing number, never partial,
   * never carried forward.
   *
   * A dropped day is NOT silent: it increments `partialDays` like any other
   * incompletely-priced day, and a lot whose only readings landed on dropped
   * days is named in `excludedSymbols`. Both are what the caveat line under
   * the chart renders.
   *
   * A SINGLE-contract chart leaves this false: there the day already IS a hole
   * when its one lot is unpriced, and lots of the same contract share one
   * price, so `partialDays` keeps its original meaning there.
   */
  requireEveryActiveLot?: boolean;
}

export function composeOptionsSeries(
  rows: readonly OptionPositionRow[],
  valuations: readonly OptionValuationRow[],
  window: { fromISO: string; toISO: string },
  options: ComposeOptionsSeriesOptions = {},
): SeriesPayload {
  // Clip defensively; the caller already selects the window.
  const inWindow = valuations.filter((c) => c.asOf >= window.fromISO && c.asOf <= window.toISO);
  if (inWindow.length === 0) return emptySeries();

  // date → (ticker → price). Two lots of one ticker share one row.
  const closesByDate = new Map<string, Map<string, string>>();
  for (const row of inWindow) {
    let byTicker = closesByDate.get(row.asOf);
    if (byTicker === undefined) {
      byTicker = new Map();
      closesByDate.set(row.asOf, byTicker);
    }
    byTicker.set(row.ticker, row.price);
  }

  const dates = [...closesByDate.keys()].sort();
  const anchorDate = dates[0];

  const points: ChartPoint[] = [];
  let partialDays = 0;
  const lotsWithReadings = new Set<OptionPositionRow>();

  for (const date of dates) {
    const byTicker = closesByDate.get(date) as Map<string, string>;

    let value = ZERO;
    let basis = ZERO;
    let contributed = 0;
    let dayPartial = false;
    // Staged, not committed: a lot only counts as "on the chart" once the day
    // it priced actually becomes a point (see the drop below).
    const pricedToday: OptionPositionRow[] = [];

    for (const lot of rows) {
      // Active: bought on or before this date, not yet past expiry.
      if (lot.tradeDate > date || lot.expirationDate < date) continue;
      const price = byTicker.get(lot.ticker);
      if (price === undefined) {
        // Active but unreadable this day — excluded from BOTH sides, never
        // zeroed, never carried forward; the day is honestly partial.
        dayPartial = true;
        continue;
      }
      const contracts = dec(lot.quantity).times(dec(lot.sharesPerContract));
      value = value.plus(dec(price).times(contracts));
      basis = basis.plus(dec(lot.entryPrice).times(contracts).plus(dec(lot.fees)));
      contributed += 1;
      pricedToday.push(lot);
    }

    if (contributed === 0) continue; // no contributions → NO point (a hole)
    // A sum across contracts is only a TOTAL when every active lot is priced;
    // otherwise the day is a hole rather than an understated point. The day
    // still counts as partial: it is missing from the line BECAUSE a quote was
    // missing, and the caveat line is the only place the user can learn that.
    if (dayPartial) partialDays += 1;
    if (dayPartial && options.requireEveryActiveLot === true) continue;

    for (const lot of pricedToday) lotsWithReadings.add(lot);

    const r = pctChange(basis, value);
    const point: ChartPoint = { t: utcNoonMs(date), v: toNumeric(value) };
    if (r !== null) point.r = toNumeric(r);
    points.push(point);
  }

  // Lots active somewhere in the window that never contributed a reading to a
  // PLOTTED day. A lot whose only readings fell on days the book-wide builder
  // dropped is named here: nothing it priced reached the screen, so "not
  // included" is exactly what happened to it.
  const excludedSymbols: string[] = [];
  for (const lot of rows) {
    if (lotsWithReadings.has(lot)) continue;
    if (lot.tradeDate > window.toISO || lot.expirationDate < window.fromISO) continue;
    const label = compactOptionLabel(lot);
    if (!excludedSymbols.includes(label)) excludedSymbols.push(label);
  }

  return { points, partialDays, excludedSymbols, anchorDate };
}
