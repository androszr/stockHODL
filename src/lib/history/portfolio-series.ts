import 'server-only';

import type Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';

import { mapWithConcurrency } from '@/lib/async-pool';
import { shouldOverlayFormingDay } from '@/lib/charts/forming-day';
import {
  lastSharedSessionDates,
  resolveRange,
  sliceLastSessions,
  type ChartRange,
  type ResolvedIntradayRange,
} from '@/lib/charts/ranges';
import {
  downsample,
  emptySeries,
  type ChartPoint,
  type SeriesPayload,
} from '@/lib/charts/series';
import { tagSessionPhases } from '@/lib/charts/session-phase';
import { db, instruments, portfolios, transactions } from '@/lib/db';
import { getCurrentFxRateToPln, getFxRatesForRange } from '@/lib/fx/nbp';
import {
  nyDateISOAt,
  regularSessionFor,
  type CalendarOverride,
} from '@/lib/market-data/market-clock';
import { massiveProvider } from '@/lib/market-data/massive';
import type { Candle } from '@/lib/market-data/provider';
import { dec, pctChange, ZERO } from '@/lib/money';
import { computePositions, type EngineTransaction } from '@/lib/position-engine';

import { equityOverlayPoint, patchDailyCloses } from './forming-overlay';
import {
  getDailyBars,
  getDailyCloses,
  getLatestClosesBefore,
  MAX_BACKFILL_SYMBOLS,
} from './price-history';

/**
 * The portfolio value series, computed ON THE FLY from immutable cached
 * inputs (daily closes in `price_snapshots`, NBP rates in `fx_rates`) and the
 * user's editable transactions — deliberately NO materialized value-snapshot
 * table (decision of 2026-08-11): raw inputs never invalidate, while a
 * materialized series would need its whole tail invalidated on every
 * backdated transaction edit. A short in-process memo absorbs range-switch
 * bursts instead.
 *
 * All arithmetic is Decimal via `money.ts`; the only float exit is chart
 * geometry on the phone (`PlotPoints.swift`), at render.
 *
 * Exclusion semantics mirror `summary.ts`: an instrument the series cannot
 * price AT ALL in the window (a non-US listing — the provider is US-only —
 * or a currency with no FX data) goes to `excludedSymbols` and contributes
 * NOTHING; a merely transient hole (a day before an instrument's first close
 * in the window) marks the day partial via `partialDays`. Never a silent
 * undercount.
 */

/**
 * Fan-out bound for the intraday (1D/5D) portfolio chart: one vendor request
 * per instrument per cache miss. Beyond the bound the intraday portfolio
 * series degrades to an honest empty state instead of firing dozens of
 * requests in one call. (The user accepted the N-requests cost on 2026-08-11;
 * this bound is the safety net, and the 1M+ ranges are unaffected.)
 *
 * Raised from 12 on 2026-08-15. At 12 it was a safety net on an OPT-IN range;
 * once 1D became the chart default (f920137) it became a silent blank chart
 * on every cold dashboard load for anyone holding more than a dozen
 * instruments — the bound was sized for a situation that no longer existed.
 * The user chose fan-out over a blank chart: the tier is unlimited REST, the
 * 60 s intraday cache absorbs repeat loads, and this is a single-user app.
 * Still bounded, because an unbounded fan-out is a different failure.
 */
export const MAX_INTRADAY_SYMBOLS = 60;

/**
 * How many history fetches (Massive intraday aggregates; Neon/provider daily
 * closes) may be in flight at once (2026-08-16, trim-bundle plan — replaced
 * the strictly sequential loops). Why 5: latency is `ceil(N / pool) × RTT`,
 * so at a typical 10-20 instruments a pool of 5 gives 2-4 rounds (~0.4-1.2 s)
 * versus 1.5-6 s sequential — the audit's target — and at the
 * `MAX_INTRADAY_SYMBOLS = 60` ceiling it caps at 12 rounds. The Starter tier
 * is unlimited REST, but a 60-wide instantaneous burst is abuse-shaped and
 * invites throttling, while ≤5 in flight matches an ordinary busy browser
 * tab; Neon HTTP treats each query as one HTTPS request, trivially fine at 5.
 * It sits in the middle of the audit's 4-6 band — past ~6 the round count
 * barely drops while the burst risk keeps growing. The NBP FX loops are NOT
 * pooled: the no-fan-out discipline there is documented policy
 * (`live-view.ts`, `nbp.ts`), not an accident.
 */
const HISTORY_CONCURRENCY = 5;

/** The pool, bound once — every pooled task below is never-throw by contract
 *  (catch-to-`[]` inside, or `getDailyCloses`' own contract), so the pool's
 *  documented rejection propagation cannot fire in practice. */
function mapWithHistoryPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return mapWithConcurrency(items, HISTORY_CONCURRENCY, fn);
}

interface InstrumentRef {
  id: string;
  symbol: string;
  currency: string;
}

type EngineFn = typeof computePositions;

/* ------------------------------------------------------------------ *
 * Quantity boundaries — the engine reuse. Holdings change ONLY on
 * transaction dates, so the position engine runs once per unique trade
 * date (dozens of calls) and every day in between inherits the last
 * boundary's quantities — never once per charted day (~1250 on 5Y).
 * ------------------------------------------------------------------ */

interface QuantityBoundary {
  /** Trade date this boundary takes effect on ('YYYY-MM-DD'). */
  date: string;
  /** instrumentId → held quantity as of end of `date`. */
  qtyById: Map<string, Decimal>;
  /** instrumentId → open cost basis in PLN as of end of `date` (the engine's
   *  `costBasisPLN`: trade-date FX rates, fees included) — the denominator of
   *  the simple-return curve, captured in the SAME engine run. */
  basisById: Map<string, Decimal>;
}

function buildQuantityBoundaries(
  txs: readonly EngineTransaction[],
  engine: EngineFn,
  maxDate: string,
): QuantityBoundary[] {
  // Dates past the window end can never be queried (every charted day is
  // ≤ maxDate) — a transaction dated after the window has no effect, and the
  // engine is not run for it.
  const uniqueDates = [...new Set(txs.map((t) => t.tradeDate))].filter((d) => d <= maxDate).sort();
  return uniqueDates.map((date) => {
    const positions = engine(txs.filter((t) => t.tradeDate <= date));
    const qtyById = new Map<string, Decimal>();
    const basisById = new Map<string, Decimal>();
    for (const position of positions) {
      qtyById.set(position.instrumentId, position.quantity);
      basisById.set(position.instrumentId, position.costBasisPLN);
    }
    return { date, qtyById, basisById };
  });
}

/** Held quantity of one instrument on a calendar day (last boundary ≤ day). */
function quantityOn(boundaries: readonly QuantityBoundary[], instrumentId: string, day: string): Decimal {
  let qty = ZERO;
  for (const boundary of boundaries) {
    if (boundary.date > day) break;
    qty = boundary.qtyById.get(instrumentId) ?? ZERO;
  }
  return qty;
}

/** Open PLN cost basis of one instrument on a calendar day (last boundary ≤ day). */
function basisOn(boundaries: readonly QuantityBoundary[], instrumentId: string, day: string): Decimal {
  let basis = ZERO;
  for (const boundary of boundaries) {
    if (boundary.date > day) break;
    basis = boundary.basisById.get(instrumentId) ?? ZERO;
  }
  return basis;
}

/** Whether an instrument is ever held (> 0) on any day inside the window. */
function heldInWindow(
  boundaries: readonly QuantityBoundary[],
  instrumentId: string,
  from: string,
  to: string,
): boolean {
  if (quantityOn(boundaries, instrumentId, from).greaterThan(0)) return true;
  for (const boundary of boundaries) {
    if (boundary.date <= from || boundary.date > to) continue;
    if ((boundary.qtyById.get(instrumentId) ?? ZERO).greaterThan(0)) return true;
  }
  return false;
}

function uniqueInstruments(txs: readonly EngineTransaction[]): InstrumentRef[] {
  const byId = new Map<string, InstrumentRef>();
  for (const t of txs) {
    if (!byId.has(t.instrumentId)) {
      byId.set(t.instrumentId, { id: t.instrumentId, symbol: t.symbol, currency: t.currency });
    }
  }
  return [...byId.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

/* ------------------------------------------------------------------ *
 * Pure series builders — exported for the unit tests, which inject
 * closes/FX maps and a spy engine instead of mocking Drizzle.
 * ------------------------------------------------------------------ */

export interface DailySeriesInputs {
  txs: EngineTransaction[];
  /** instrumentId → ('YYYY-MM-DD' → close decimal string), window-scoped. */
  closesByInstrument: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** currency → dense ('YYYY-MM-DD' → rate) map; PLN is implicit at '1'. */
  fxByCurrency: ReadonlyMap<string, ReadonlyMap<string, string>>;
  window: { from: string; to: string };
  /** Injectable for the call-count test; defaults to the real engine. */
  engine?: EngineFn;
}

/**
 * The daily builder's own result: the chart payload's fields plus the DATES
 * of the partial days.
 *
 * `partialDays` is a count, and a count cannot tell a caller WHICH day was
 * summed from an incomplete set of prices. The analytics TWRR chain needs
 * exactly that: a day whose value is untrustworthy must break the chain
 * rather than be measured (bug audit 2026-08-19, major 1 — a sell-everything
 * day that also bought an instrument with no bar yet reads as a zero-value
 * day, and measuring it as a liquidation reports a large, confident and
 * entirely fictional loss). The field is deliberately NOT on `SeriesPayload`:
 * it is builder-internal detail, not something the charts serialize.
 */
export type DailySeriesResult = Omit<SeriesPayload, 'anchorDate'> & {
  /** 'YYYY-MM-DD' of every day summed from an incomplete instrument set. */
  partialDates: string[];
};

export function buildDailyPortfolioSeries(inputs: DailySeriesInputs): DailySeriesResult {
  const { txs, closesByInstrument, fxByCurrency, window } = inputs;
  const engine = inputs.engine ?? computePositions;

  const boundaries = buildQuantityBoundaries(txs, engine, window.to);
  const all = uniqueInstruments(txs);

  // Only instruments actually held inside the window matter; long-closed
  // positions neither contribute nor deserve an exclusion note.
  const relevant = all.filter((i) => heldInWindow(boundaries, i.id, window.from, window.to));

  const excludedSymbols: string[] = [];
  const included: InstrumentRef[] = [];
  for (const instrument of relevant) {
    const closes = closesByInstrument.get(instrument.id);
    const fxOk =
      instrument.currency === 'PLN' || (fxByCurrency.get(instrument.currency)?.size ?? 0) > 0;
    if (!closes || closes.size === 0 || !fxOk) {
      excludedSymbols.push(instrument.symbol);
    } else {
      included.push(instrument);
    }
  }

  // The day axis: every date any included instrument closed on, in-window.
  const days = new Set<string>();
  for (const instrument of included) {
    const closes = closesByInstrument.get(instrument.id);
    if (!closes) continue;
    for (const day of closes.keys()) {
      if (day >= window.from && day <= window.to) days.add(day);
    }
  }
  const sortedDays = [...days].sort();

  const lastClose = new Map<string, string>();
  const points: ChartPoint[] = [];
  const partialDates: string[] = [];

  for (const day of sortedDays) {
    let total = ZERO;
    let basisTotal = ZERO;
    let partial = false;

    for (const instrument of included) {
      const closes = closesByInstrument.get(instrument.id);
      const todayClose = closes?.get(day);
      if (todayClose !== undefined) lastClose.set(instrument.id, todayClose);

      const qty = quantityOn(boundaries, instrument.id, day);
      if (!qty.greaterThan(0)) continue;

      // Carry-forward: a day one instrument did not trade uses its newest
      // earlier close in the window. No earlier close at all (days before
      // its first bar) → the day is PARTIAL, never silently undercounted.
      const close = lastClose.get(instrument.id);
      if (close === undefined) {
        partial = true;
        continue;
      }

      const rate =
        instrument.currency === 'PLN' ? '1' : fxByCurrency.get(instrument.currency)?.get(day);
      if (rate === undefined) {
        partial = true;
        continue;
      }

      total = total.plus(qty.times(dec(close)).times(dec(rate)));
      // Basis accumulates under the SAME guards as value: an instrument that
      // contributed no value this point contributes no basis either, so the
      // return ratio always compares like with like.
      basisTotal = basisTotal.plus(basisOn(boundaries, instrument.id, day));
    }

    if (partial) partialDates.push(day);
    // Simple return vs open basis; `null` (zero basis — nothing owned yet or
    // fully liquidated) omits the field entirely: percent-of-nothing must not
    // masquerade as a flat 0%.
    const r = pctChange(basisTotal, total);
    const t = Date.parse(`${day}T00:00:00Z`);
    points.push(r === null ? { t, v: total.toString() } : { t, v: total.toString(), r: r.toString() });
  }

  return {
    points,
    partialDays: partialDates.length,
    partialDates,
    excludedSymbols: excludedSymbols.sort(),
  };
}

export interface IntradaySeriesInputs {
  txs: EngineTransaction[];
  /**
   * instrumentId → RAW fetch-window intraday candles, ascending by `t` —
   * deliberately NOT session-sliced per instrument (defect fix, 2026-08-14):
   * the builder restricts the axis to ONE shared trailing session window via
   * `lastSharedSessionDates`, and the pre-window bars feed the carry-forward
   * cursor so a quiet instrument holds its own last print.
   */
  candlesByInstrument: ReadonlyMap<string, readonly Candle[]>;
  /**
   * How many trailing shared sessions to chart (1 for 1D, 5 for 5D) — the
   * portfolio-wide replacement for the retired per-instrument slice.
   */
  sessions: number;
  /** currency → the latest published rate to PLN; PLN is implicit at '1'. */
  fxRateByCurrency: ReadonlyMap<string, string>;
  /**
   * instrumentId → last known DAILY close from before the charted window
   * (`price_snapshots`). Seeds the carry-forward: the axis is the union of
   * bar instants across instruments, and without a baseline an instrument
   * that has not printed its first bar yet contributes nothing — the window's
   * start would be systematically low, with a fake jump up as instruments
   * join. A missing baseline keeps the old partial behavior.
   */
  baselineCloseByInstrument?: ReadonlyMap<string, string>;
  /**
   * When present, extended-hours points get their `p` tag (the session-phase
   * tagger in `src/lib/charts/session-phase.ts`). The CALLER gates this on
   * range — 1D only.
   */
  sessionOverrides?: readonly CalendarOverride[];
  window: { from: string; to: string };
  engine?: EngineFn;
}

export function buildIntradayPortfolioSeries(
  inputs: IntradaySeriesInputs,
): Omit<SeriesPayload, 'anchorDate'> {
  const { txs, candlesByInstrument, fxRateByCurrency, window } = inputs;
  const engine = inputs.engine ?? computePositions;

  const boundaries = buildQuantityBoundaries(txs, engine, window.to);
  const all = uniqueInstruments(txs);
  const relevant = all.filter((i) => heldInWindow(boundaries, i.id, window.from, window.to));

  // Inclusion is decided on the RAW candles, deliberately: an instrument
  // whose bars all predate the shared window must stay INCLUDED and hold its
  // last print as a flat line — filtering on the windowed candles would route
  // it into `excludedSymbols` instead.
  const excludedSymbols: string[] = [];
  const included: InstrumentRef[] = [];
  for (const instrument of relevant) {
    const candles = candlesByInstrument.get(instrument.id);
    const fxOk =
      instrument.currency === 'PLN' || fxRateByCurrency.get(instrument.currency) !== undefined;
    if (!candles || candles.length === 0 || !fxOk) {
      excludedSymbols.push(instrument.symbol);
    } else {
      included.push(instrument);
    }
  }

  // ONE shared trailing session window for the whole portfolio (defect fix,
  // 2026-08-14): the axis is the union of bar instants across included
  // instruments, restricted to the trailing `sessions` NY dates of that
  // union. Without the restriction each instrument effectively charted its
  // own trailing session — an active stock's pre-market today glued after a
  // quiet stock's full yesterday, drawing a vertical cliff at the boundary.
  const sharedDates = new Set(
    lastSharedSessionDates(
      included.map((instrument) => candlesByInstrument.get(instrument.id) ?? []),
      inputs.sessions,
    ),
  );
  const dayByInstant = new Map<number, string>();
  for (const instrument of included) {
    for (const candle of candlesByInstrument.get(instrument.id) ?? []) {
      if (!dayByInstant.has(candle.t)) dayByInstant.set(candle.t, nyDateISOAt(candle.t));
    }
  }
  const sortedInstants = [...dayByInstant.keys()]
    .filter((t) => sharedDates.has(dayByInstant.get(t) as string))
    .sort((a, b) => a - b);

  // One ascending cursor per instrument — the sweep is O(bars), not O(n²).
  // At the first charted instant each cursor advances through ALL of its
  // instrument's pre-window bars, so a quiet instrument lands on its own last
  // print and holds flat across the shared window. (That last print may be a
  // late-trading bar rather than the official close — a grosz-level wobble the
  // pre-fix behavior shared; accepted.)
  const cursor = new Map<string, number>();

  // Carry-forward state, seeded with the pre-window daily closes so every
  // included instrument counts from the FIRST instant; its own first bar then
  // overwrites the seed.
  const lastClose = new Map<string, string>();
  if (inputs.baselineCloseByInstrument) {
    for (const instrument of included) {
      const baseline = inputs.baselineCloseByInstrument.get(instrument.id);
      if (baseline !== undefined) lastClose.set(instrument.id, baseline);
    }
  }

  const points: ChartPoint[] = [];
  let partialDays = 0;

  for (const t of sortedInstants) {
    let total = ZERO;
    let basisTotal = ZERO;
    let partial = false;
    const day = dayByInstant.get(t) as string;

    for (const instrument of included) {
      const candles = candlesByInstrument.get(instrument.id) ?? [];
      let index = cursor.get(instrument.id) ?? 0;
      while (index < candles.length && candles[index].t <= t) {
        lastClose.set(instrument.id, candles[index].close);
        index++;
      }
      cursor.set(instrument.id, index);

      const qty = quantityOn(boundaries, instrument.id, day);
      if (!qty.greaterThan(0)) continue;

      const close = lastClose.get(instrument.id);
      if (close === undefined) {
        partial = true;
        continue;
      }

      const rate =
        instrument.currency === 'PLN' ? '1' : fxRateByCurrency.get(instrument.currency);
      if (rate === undefined) {
        partial = true;
        continue;
      }

      total = total.plus(qty.times(dec(close)).times(dec(rate)));
      // Same-guards basis accumulation as the daily builder; `basisOn`
      // resolves per the NY date of the bar instant, so basis is constant
      // within a session and steps once on a trade date.
      basisTotal = basisTotal.plus(basisOn(boundaries, instrument.id, day));
    }

    if (partial) partialDays++;
    const r = pctChange(basisTotal, total);
    points.push(r === null ? { t, v: total.toString() } : { t, v: total.toString(), r: r.toString() });
  }

  // `[]` is meaningful (standard NYSE weekday schedule, no overrides) and
  // distinct from `undefined` (do not tag) — no truthiness check on length.
  const tagged = inputs.sessionOverrides
    ? tagSessionPhases(points, inputs.sessionOverrides)
    : points;
  return { points: tagged, partialDays, excludedSymbols: excludedSymbols.sort() };
}

/* ------------------------------------------------------------------ *
 * In-process memo. Best-effort on serverless (per-instance, and a
 * mutation on another instance cannot clear it) — the TTL is the real
 * staleness bound and 60 s is accepted (plan Risks 10).
 * ------------------------------------------------------------------ */

const SERIES_MEMO_TTL_MS = 60_000;
const seriesMemo = new Map<string, { at: number; result: SeriesPayload }>();

/** Called by the transaction mutations so an edit repaints promptly. */
export function invalidatePortfolioSeriesMemo(userId: string): void {
  for (const key of seriesMemo.keys()) {
    if (key.startsWith(`portfolio:${userId}:`)) seriesMemo.delete(key);
  }
}

function memoGet(key: string): SeriesPayload | null {
  const hit = seriesMemo.get(key);
  if (hit && Date.now() - hit.at < SERIES_MEMO_TTL_MS) return hit.result;
  if (hit) seriesMemo.delete(key);
  return null;
}

function memoSet(key: string, result: SeriesPayload): void {
  seriesMemo.set(key, { at: Date.now(), result });
}

/* ------------------------------------------------------------------ *
 * Loaders — the impure half.
 * ------------------------------------------------------------------ */

async function loadUserTransactions(
  userId: string,
  /** Scope to ONE portfolio (the `/?p=<id>` Holdings view); undefined = all. */
  portfolioId?: string,
): Promise<EngineTransaction[]> {
  const rows = await db
    .select({
      id: transactions.id,
      instrumentId: transactions.instrumentId,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
      side: transactions.side,
      quantity: transactions.quantity,
      price: transactions.price,
      fees: transactions.fees,
      fxRateToBase: transactions.fxRateToBase,
      tradeDate: transactions.tradeDate,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    // The userId predicate stays in EVERY variant: scoping by portfolio is a
    // filter on top of ownership, never a replacement for it.
    .where(
      portfolioId === undefined
        ? eq(portfolios.userId, userId)
        : and(eq(portfolios.userId, userId), eq(transactions.portfolioId, portfolioId)),
    );

  // `side` is checked, never cast wholesale — the column type is text.
  return rows.map((r) => ({ ...r, side: r.side === 'sell' ? ('sell' as const) : ('buy' as const) }));
}

/** Exported for the pooled-loader tests; production callers stay in-module. */
export async function loadIntradayCandles(
  included: readonly InstrumentRef[],
  resolved: ResolvedIntradayRange,
): Promise<Map<string, Candle[]>> {
  const spec = {
    multiplier: resolved.multiplier,
    timespan: 'minute' as const,
    from: String(resolved.fromMs),
    to: String(resolved.toMs),
  };

  // Bounded pool, at most HISTORY_CONCURRENCY in flight (2026-08-16,
  // trim-bundle plan — this replaced the strictly sequential walk; see the
  // constant's comment for why 5). Every task degrades to `[]` on its own —
  // one instrument's failure never rejects the pool or touches its
  // neighbours — and `MAX_INTRADAY_SYMBOLS` still caps the total fan-out
  // upstream.
  const candlesInInputOrder = await mapWithHistoryPool(
    included,
    async (instrument): Promise<Candle[]> => {
      // Non-USD instruments can never be priced by the US-only provider — do
      // not even ask; the empty entry routes them into excludedSymbols.
      if (instrument.currency !== 'USD' && instrument.currency !== 'PLN') {
        return [];
      }
      if (instrument.currency === 'PLN') {
        return [];
      }
      try {
        // Deliberately RAW (defect fix, 2026-08-14): slicing to the trailing
        // sessions PER INSTRUMENT here let each instrument chart a different
        // day. The builder slices ONCE, portfolio-wide, and uses the pre-window
        // bars to hold quiet instruments flat.
        return await massiveProvider.getAggregates(instrument.symbol, spec);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'intraday fetch failed';
        console.error(`Intraday bars failed (${instrument.symbol}): ${message}`);
        return [];
      }
    },
  );

  // The pool returns results in input order, so the Map's keys, insertion
  // order and completeness are identical to the sequential era.
  const byInstrument = new Map<string, Candle[]>();
  included.forEach((instrument, index) => {
    byInstrument.set(instrument.id, candlesInInputOrder[index]);
  });
  return byInstrument;
}

/**
 * The daily-range closes, one read-through `getDailyCloses` per instrument
 * over the same bounded pool — the provider backfill stays enabled only for
 * the first `MAX_BACKFILL_SYMBOLS` ORIGINAL indices, exactly like the
 * sequential loop's `index < bound`, because the pool passes original
 * indices through. `getDailyCloses` is never-throw by contract
 * (`price-history.ts`), so the pool cannot reject. Exported for the tests.
 */
export async function loadDailyClosesByInstrument(
  instrumentsList: readonly InstrumentRef[],
  window: { from: string; to: string },
): Promise<Map<string, Map<string, string>>> {
  const closesInInputOrder = await mapWithHistoryPool(instrumentsList, (instrument, index) =>
    getDailyCloses(instrument, window, { backfill: index < MAX_BACKFILL_SYMBOLS }),
  );

  const byInstrument = new Map<string, Map<string, string>>();
  instrumentsList.forEach((instrument, index) => {
    byInstrument.set(instrument.id, closesInInputOrder[index]);
  });
  return byInstrument;
}

/**
 * The portfolio value series in PLN for one of the eight chart ranges.
 * Best-effort end to end: every failure degrades (an excluded instrument, a
 * partial day, an empty series) and logs — it never throws to the caller.
 */
export async function getPortfolioValueSeries(
  userId: string,
  range: ChartRange,
  /**
   * Scope to one portfolio (the `/?p=<id>` Holdings view). The CALLER has
   * already checked the portfolio belongs to this user; the query re-scopes
   * by `userId` regardless, so a stale or forged id can only ever yield an
   * empty series — never another user's rows.
   */
  portfolioId?: string,
): Promise<SeriesPayload> {
  // The scope is part of the key: two scopes are two different series, and a
  // shared key would serve one for the other for up to the 60 s TTL.
  const memoKey = `portfolio:${userId}:${portfolioId ?? 'all'}:${range}`;
  const cached = memoGet(memoKey);
  if (cached) return cached;

  try {
    const txs = await loadUserTransactions(userId, portfolioId);
    if (txs.length === 0) return emptySeries(null);

    const anchorDate = txs.map((t) => t.tradeDate).sort()[0];
    const today = nyDateISOAt(Date.now());
    const resolved = resolveRange(range, { today, anchorDate });
    if (resolved === null) return emptySeries(null);

    const instrumentsList = uniqueInstruments(txs);
    let result: SeriesPayload;

    if (resolved.kind === 'daily') {
      const window = { from: resolved.from, to: resolved.to };

      // Pooled per-instrument backfill, bounded two ways: at most
      // HISTORY_CONCURRENCY reads in flight, and instruments beyond
      // MAX_BACKFILL_SYMBOLS serve cache-only this call and catch up later.
      const closesByInstrument = await loadDailyClosesByInstrument(instrumentsList, window);
      const closesForChart = await overlayFormingPortfolioCloses(
        instrumentsList,
        today,
        closesByInstrument,
      );

      const fxByCurrency = new Map<string, Map<string, string>>();
      for (const currency of new Set(instrumentsList.map((i) => i.currency))) {
        if (currency === 'PLN') continue;
        fxByCurrency.set(currency, await getFxRatesForRange(currency, window.from, window.to));
      }

      const built = buildDailyPortfolioSeries({
        txs,
        closesByInstrument: closesForChart,
        fxByCurrency,
        window,
      });
      // Field by field rather than a spread: `partialDates` is builder-internal
      // (the analytics chain needs it, the chart payload does not) and must not
      // ride along into a serialized response.
      result = {
        points: downsample(built.points),
        partialDays: built.partialDays,
        excludedSymbols: built.excludedSymbols,
        anchorDate,
      };
    } else {
      // kind === 'intraday' — overlay stays in the daily branch above.
      // The intraday fan-out bound: degrade to an honest empty state above it.
      if (instrumentsList.length > MAX_INTRADAY_SYMBOLS) {
        return emptySeries(anchorDate);
      }

      const window = { from: nyDateISOAt(resolved.fromMs), to: today };
      const candlesByInstrument = await loadIntradayCandles(instrumentsList, resolved);

      // Baseline: the last cached daily close STRICTLY BEFORE the first
      // CHARTED day — the first of the shared trailing session dates, not the
      // first fetched bar (the fetch window is deliberately over-wide).
      // Read-only against `price_snapshots` (no provider call — the daily
      // ranges keep it warm), and ONE batched `DISTINCT ON` query for the
      // whole set (2026-08-16, trim-bundle plan — this was a sequential N+1
      // loop); an instrument without a baseline is absent from the map and
      // keeps the old partial behavior. See
      // `IntradaySeriesInputs.baselineCloseByInstrument`.
      const [firstChartedDay] = lastSharedSessionDates(
        candlesByInstrument.values(),
        resolved.sessions,
      );
      // Snapshots exist only for USD instruments (the provider is US-only) —
      // the same filter the old loop's `continue` applied.
      const usdIds = instrumentsList
        .filter((instrument) => instrument.currency === 'USD')
        .map((instrument) => instrument.id);
      const baselineCloseByInstrument =
        firstChartedDay === undefined
          ? new Map<string, string>()
          : await getLatestClosesBefore(usdIds, firstChartedDay);

      // NBP has no intraday rates — the latest published daily mid applies to
      // the whole window (standard for a 1-day chart).
      const fxRateByCurrency = new Map<string, string>();
      for (const currency of new Set(instrumentsList.map((i) => i.currency))) {
        if (currency === 'PLN') continue;
        const rate = await getCurrentFxRateToPln(currency);
        if (rate.ok) fxRateByCurrency.set(currency, rate.rate);
      }

      // Extended-hours shading, 1D ONLY (matching the instrument path) — the
      // 5D range must not pay for the calendar nor grow its payload. Tagging
      // happens inside the builder so `downsample` receives already-tagged
      // points; tagging after sampling would misalign indices with the bars
      // the calendar classified. `getCalendarOverrides()` never throws by
      // contract — a vendor failure degrades to stale/stored/empty overrides.
      const sessionOverrides =
        range === '1D' ? await massiveProvider.getCalendarOverrides() : undefined;
      const built = buildIntradayPortfolioSeries({
        txs,
        candlesByInstrument,
        sessions: resolved.sessions,
        fxRateByCurrency,
        baselineCloseByInstrument,
        window,
        sessionOverrides,
      });
      result = { ...built, points: downsample(built.points), anchorDate };
    }

    memoSet(memoKey, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'series build failed';
    console.error(`Portfolio series failed (${range}): ${message}`);
    return emptySeries(null);
  }
}

/**
 * The price series for one instrument (the `/holdings/[ticker]` chart), in
 * the instrument's trading currency. The caller (Server Action / page) has
 * already verified the instrument belongs to the user's own transactions and
 * supplies that first trade date as the anchor. Best-effort like the
 * portfolio series; an instrument with no history at all (non-US market)
 * comes back empty with itself in `excludedSymbols` — the page renders the
 * explanation, never an error.
 */
export async function getInstrumentPriceSeries(
  instrument: InstrumentRef,
  anchorDate: string,
  range: ChartRange,
): Promise<SeriesPayload> {
  const memoKey = `price:${instrument.id}:${range}`;
  const cached = memoGet(memoKey);
  if (cached) return cached;

  try {
    const today = nyDateISOAt(Date.now());
    const resolved = resolveRange(range, { today, anchorDate });
    if (resolved === null) return emptySeries(anchorDate);

    let points: ChartPoint[];
    if (resolved.kind === 'daily') {
      // Bars, not closes: `o/h/l` ride along for the candlestick view — set
      // only when the stored row carries them (all three or none; a pre-repair
      // row draws as a line segment), so a candle-less payload serializes
      // byte-identically to before (the `p?` precedent).
      const bars = await getDailyBars(instrument, { from: resolved.from, to: resolved.to });
      // A live last is not a series: empty stored history stays excluded.
      if (bars.size === 0) {
        points = [];
      } else {
        points = [...bars.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([day, bar]) => ({
            t: Date.parse(`${day}T00:00:00Z`),
            v: bar.close,
            ...(bar.open !== null && bar.high !== null && bar.low !== null
              ? { o: bar.open, h: bar.high, l: bar.low }
              : {}),
          }));
        const overlay = await overlayFormingInstrumentPoint(instrument, today, bars.keys());
        if (overlay !== null) points.push(overlay);
      }
    } else {
      // kind === 'intraday' — overlay stays in the daily branch above.
      let candles: Candle[] = [];
      if (instrument.currency === 'USD') {
        try {
          candles = await massiveProvider.getAggregates(instrument.symbol, {
            multiplier: resolved.multiplier,
            timespan: 'minute',
            from: String(resolved.fromMs),
            to: String(resolved.toMs),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'intraday fetch failed';
          console.error(`Intraday bars failed (${instrument.symbol}): ${message}`);
        }
      }
      // Per-instrument slicing is correct BY CONSTRUCTION here (audited
      // 2026-08-14): with a single instrument its own trailing session IS the
      // shared session — no cross-instrument union exists to mix days.
      // Intraday candles already carry full OHLC (mapAggsResults drops
      // partial bars), so every point gets its `o/h/l` — same optional-field
      // contract as the daily branch.
      points = sliceLastSessions(candles, resolved.sessions).map((candle) => ({
        t: candle.t,
        v: candle.close,
        o: candle.open,
        h: candle.high,
        l: candle.low,
      }));

      // Extended-hours shading, 1D ONLY. The vendor's bars already span
      // 04:00–20:00 ET; this is the label that tells the chart which of them
      // the regular session did not produce. Deliberately not on 5D: five
      // sessions' worth of bands turns a 195-point line into stripes.
      // US listings only — `regularSessionFor` is the NYSE calendar, and a
      // Warsaw close shaded by New York hours would be a plain lie.
      if (range === '1D' && instrument.currency === 'USD' && points.length > 0) {
        points = tagSessionPhases(points, await massiveProvider.getCalendarOverrides());
      }
    }

    const result: SeriesPayload = {
      points: downsample(points),
      partialDays: 0,
      excludedSymbols: points.length === 0 ? [instrument.symbol] : [],
      anchorDate,
    };
    memoSet(memoKey, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'series build failed';
    console.error(`Price series failed (${instrument.symbol}, ${range}): ${message}`);
    return emptySeries(anchorDate);
  }
}

/**
 * Today's still-forming last, in memory only. Never writes snapshots or
 * coverage. A miss or throw leaves yesterday's last on the chart.
 */
async function overlayFormingInstrumentPoint(
  instrument: InstrumentRef,
  today: string,
  existingDates: Iterable<string>,
): Promise<ChartPoint | null> {
  try {
    const overrides = await massiveProvider.getCalendarOverrides();
    if (
      !shouldOverlayFormingDay({
        todayISO: today,
        nowMs: Date.now(),
        session: regularSessionFor(today, overrides),
        existingDates,
      })
    ) {
      return null;
    }

    const outcomes = await massiveProvider.getQuotes([instrument.symbol]);
    const outcome = outcomes.get(instrument.symbol);
    if (!outcome?.ok) return null;

    let open: string | null = null;
    let high: string | null = null;
    let low: string | null = null;
    try {
      const candles = await massiveProvider.getAggregates(instrument.symbol, {
        multiplier: 1,
        timespan: 'day',
        from: today,
        to: today,
      });
      const candle = candles.find((c) => nyDateISOAt(c.t) === today);
      if (candle !== undefined) {
        open = candle.open;
        high = candle.high;
        low = candle.low;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'forming daily bar failed';
      console.error(`Forming daily bar failed (${instrument.symbol}): ${message}`);
    }
    if (open === null || high === null || low === null) {
      const { dayOpen, dayHigh, dayLow } = outcome.quote;
      if (dayOpen !== null && dayHigh !== null && dayLow !== null) {
        open = dayOpen;
        high = dayHigh;
        low = dayLow;
      } else {
        open = null;
        high = null;
        low = null;
      }
    }

    return equityOverlayPoint({ todayISO: today, last: outcome.quote.price, open, high, low });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'forming overlay failed';
    console.error(`Price series forming overlay failed (${instrument.symbol}): ${message}`);
    return null;
  }
}

/**
 * Patch today's live last onto the daily closes map, in memory only.
 * Analytics TWRR keeps calling `loadDailyClosesByInstrument` unpatched.
 * One snapshot batch — never per-symbol daily aggregates.
 */
async function overlayFormingPortfolioCloses(
  instrumentsList: readonly InstrumentRef[],
  today: string,
  closesByInstrument: Map<string, Map<string, string>>,
): Promise<Map<string, Map<string, string>>> {
  const usd = instrumentsList.filter((instrument) => instrument.currency === 'USD');
  const patchable = usd.filter((instrument) => (closesByInstrument.get(instrument.id)?.size ?? 0) > 0);
  if (patchable.length === 0) return closesByInstrument;

  const everyHasToday = patchable.every((instrument) =>
    closesByInstrument.get(instrument.id)?.has(today),
  );

  try {
    const overrides = await massiveProvider.getCalendarOverrides();
    if (
      !shouldOverlayFormingDay({
        todayISO: today,
        nowMs: Date.now(),
        session: regularSessionFor(today, overrides),
        existingDates: everyHasToday ? [today] : [],
      })
    ) {
      return closesByInstrument;
    }

    const outcomes = await massiveProvider.getQuotes(
      patchable.map((instrument) => instrument.symbol),
    );
    const lastByInstrumentId = new Map<string, string>();
    for (const instrument of patchable) {
      const outcome = outcomes.get(instrument.symbol);
      if (outcome?.ok) lastByInstrumentId.set(instrument.id, outcome.quote.price);
    }
    return patchDailyCloses(closesByInstrument, today, lastByInstrumentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'forming overlay failed';
    console.error(`Portfolio series forming overlay failed: ${message}`);
    return closesByInstrument;
  }
}
