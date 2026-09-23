import 'server-only';

import type Decimal from 'decimal.js';
import { asc, eq, inArray } from 'drizzle-orm';

import type { ChartPoint } from '@/lib/charts/series';
import { db, instruments, portfolios, portfolioTargets } from '@/lib/db';
import { getFxRatesForRange } from '@/lib/fx/nbp';
import {
  buildDailyPortfolioSeries,
  loadDailyClosesByInstrument,
} from '@/lib/history/portfolio-series';
import type { HoldingsSourceRow } from '@/lib/holdings/live-view';
import { loadHoldingsInputs } from '@/lib/holdings/live-view';
import type { HoldingQuote } from '@/lib/holdings/live-payload';
import { resolvePortfolioScope } from '@/lib/holdings/scope';
import { computePortfolioSummary } from '@/lib/holdings/summary';
import { syncInstrumentProfiles } from '@/lib/instruments/profile';
import { INDEX_PROXIES } from '@/lib/market-strip/compose';
import { loadProxyCloses } from '@/lib/day-report/benchmarks';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { dec, directionOf, fmtMoney, fmtPct, ZERO, type Direction } from '@/lib/money';
import { computePositions, type Position } from '@/lib/position-engine';

import {
  ALLOCATION_DIMENSIONS,
  buildAllocation,
  type AllocationDimension,
  type AllocationHolding,
  type InstrumentProfile,
} from './allocation';
import {
  buildCashFlows,
  externalFlowsByDay,
  mapFlowsToAxis,
  NO_DAY_FLOW,
} from './cash-flows';
import { buildConcentration } from './concentration';
import { buildTargetDrift, type TargetWeight } from './target-drift';
import { buildBenchmark, type BenchmarkRefusal } from './benchmark';
import { addDaysISO, isoFromEpochMs } from './dates';
import { sliceColorVar } from './palette';
import { twrr, type TwrrDay } from './twrr';
import { xirr, type CashFlow, type XirrRefusal } from './xirr';

/**
 * The ONE analytics walk: scope resolve → holdings inputs → engine → summary
 * → the UNDOWNSAMPLED daily series → SPY + FX → instrument profiles → all
 * four allocation folds → every figure formatted server-side.
 *
 * Three decisions here are load-bearing:
 *
 * 1. **`buildDailyPortfolioSeries` is called DIRECTLY**, never the
 *    downsampling wrapper in `portfolio-series.ts` that the charts use. That
 *    wrapper applies `downsample()` to ~400 points, and a day-chained TWRR
 *    over sampled points produces a number that looks plausible and is wrong.
 *    (The wrapper is not named here on purpose — an acceptance criterion
 *    greps this directory for it, and a mention would read as a call.)
 * 2. **One exclusion set per SURFACE, from one resolver** (bug audit
 *    2026-08-18, blocker 2; scoped 2026-08-19, major 2). Two different
 *    exclusion mechanisms used to run
 *    side by side: the summary's "open and unpriceable" filter shaped the
 *    cash flows, while the daily series applied its OWN exclusions (no daily
 *    closes in the window, no FX, non-USD, and everything past the backfill
 *    bound) which were then discarded. An instrument in one set and not the
 *    other makes its buy day read as a large loss or a large gain depending
 *    on which way the mismatch fell, and distorts the rebased benchmark line
 *    with it. So ONE resolver — `resolveExclusions()` — decides both, and the
 *    TIME-SERIES surfaces (the valuation curve, the cash flows, XIRR, TWRR
 *    and the benchmark) take the UNION: the series is rebuilt without it and
 *    the flows are filtered by it, so the instruments in the value curve and
 *    the instruments in the cash-flow stream are the same set, always.
 *
 *    **The union stops at the time series.** The value tiles and the
 *    allocation breakdown are a snapshot of TODAY's quotes and need no daily
 *    bars at all, so the only exclusion that can apply to them is
 *    `no_live_quote` (bug audit 2026-08-19, major 2). Applying the union
 *    there dropped real, live-priced holdings from "priced value",
 *    "unrealized gain" and every allocation percentage the moment a cold
 *    history cache pushed the 13th alphabetical symbol past
 *    `MAX_BACKFILL_SYMBOLS` — an understatement that healed itself over the
 *    next few page loads and was therefore invisible in any single run.
 *
 *    Both reasons still reach the screen, but each CAPTION is scoped to the
 *    surface it sits beside: a caption must never claim an exclusion that
 *    does not apply to the figure next to it. "No live quote" only ever
 *    applies to an OPEN position (a closed one needs no price and its flows
 *    are complete on both sides); "no price history" applies to any
 *    instrument the value curve could not carry at all — including a closed
 *    one, whose buy and sell would otherwise move the chain's denominator
 *    without ever moving its value.
 * 3. **Rates do not add up; amounts do.** A scoped XIRR/TWRR is the rate of a
 *    different cash-flow stream and is NOT expected to average to the All
 *    figure. What agrees by construction is the ALLOCATION — every dimension
 *    folds ONE set of per-portfolio engine runs, so the per-portfolio slices
 *    sum to the All values. The TILES fold that same set rather than a
 *    separate combined run (bug audit 2026-08-18, minor 6): a combined run
 *    can consume another portfolio's shares on an oversell where a
 *    per-portfolio run clamps at zero, so the two would state values for
 *    different quantity sets. The UI caption says exactly that and nothing
 *    stronger.
 *
 * Best-effort throughout: every leg that fails degrades to a NAMED refusal on
 * the payload and logs. The page never 500s because a vendor hiccuped.
 */

/**
 * The benchmark, hardcoded. No setting, no picker, no schema column — one
 * shape, one story (see the plan's Out of scope).
 */
const MEMO_TTL_MS = 60_000;

/* ------------------------------------------------------------------ *
 * The serializable payload. EVERY figure is a pre-formatted string —
 * nothing on this screen is re-derived on the client.
 * ------------------------------------------------------------------ */

export interface MetricDisplay {
  /** Formatted percent, or '—' when refused. */
  value: string;
  direction: Direction;
  /** A sentence explaining a refusal; null when there is a figure. */
  note: string | null;
}

export interface AllocationSliceDisplay {
  key: string;
  label: string;
  /** Formatted PLN amount. */
  value: string;
  /** Formatted percent, or '—'. */
  pct: string;
  /** Plotted share of the total, 0–100, as a decimal STRING (geometry input). */
  share: string;
  /** `var(--color-cat-*)` — a token name, never a colour literal. */
  colorVar: string;
}

export interface AnalyticsScope {
  id: string;
  name: string;
}

/**
 * Why an instrument was left out. The two reasons read differently to a
 * person and the screen states them separately: "we have no price for it
 * today" is a transient vendor gap, while "we have no price history for it"
 * means it could never be drawn on the curve at all.
 */
export type ExclusionReason = 'no_live_quote' | 'no_price_history';

export interface ExcludedSymbol {
  symbol: string;
  reason: ExclusionReason;
}

export interface AnalyticsView {
  scopeId: string | null;
  scopes: AnalyticsScope[];
  /** First trade date in scope, 'YYYY-MM-DD'; null when there is nothing. */
  inceptionDateISO: string | null;
  xirr: MetricDisplay;
  twrrAnnualized: MetricDisplay;
  twrrCumulative: MetricDisplay;
  /** Unrealized gain over priced open positions, formatted PLN; null when none. */
  totalGain: string | null;
  totalGainDirection: Direction;
  totalValue: string | null;
  breakdown: Record<AllocationDimension, AllocationSliceDisplay[]>;
  /**
   * The biggest position and the HHI score over the TICKER slices — the same
   * fold the breakdown beside it renders, so the two can never disagree.
   * Null when nothing in the scope could be priced: a refusal, never a
   * fabricated zero score.
   */
  concentration: {
    topSymbol: string;
    /** Formatted percent — the SAME `fmtPct` spelling as the slice rows. */
    topShare: string;
    /** HHI scaled 0–100, an integer string (half-up). */
    score: string;
  } | null;
  /**
   * Target weights versus today's actual shares, for ONE portfolio.
   *
   * Null on the All scope by design (targets are strictly per portfolio) and
   * null when the scope has neither an open holding nor a stored target —
   * a refusal, never a fabricated row of zeros. Every figure is a
   * pre-formatted string folded from the SAME priced holdings the breakdown
   * beside it renders, so the two can never disagree.
   */
  targetDrift: {
    rows: {
      instrumentId: string;
      symbol: string;
      /** Formatted percent, or null for a holding with NO target (never '0'). */
      target: string | null;
      /** Formatted percent, or '—' when nothing in the scope is priced. */
      actual: string;
      /** Signed percentage-POINT delta, e.g. '+10,00 pp'; null without both sides. */
      drift: string | null;
      /** Formatted PLN, always POSITIVE — `action` carries the direction. */
      amount: string | null;
      action: 'buy' | 'sell' | null;
    }[];
    /** One sentence iff the targets do not add up to 100%; else null. */
    sumNote: string | null;
  } | null;
  benchmark: {
    portfolio: ChartPoint[];
    benchmark: ChartPoint[];
    degradedReason: BenchmarkRefusal | null;
  };
  /** Instruments left out of EVERY figure — named with a reason, never zeroed. */
  excludedSymbols: ExcludedSymbol[];
  /** Days the TWRR chain could say nothing about. */
  skippedDays: number;
  /** Days summed from an incomplete instrument set (the series' own flag). */
  partialDays: number;
}

/* ------------------------------------------------------------------ *
 * Refusal wording — one sentence each, from the reason code.
 * ------------------------------------------------------------------ */

const XIRR_REASON: Record<XirrRefusal, string> = {
  no_flows: 'No transactions in this scope yet.',
  no_sign_change: 'Nothing sold or valued yet.',
  no_bracket: 'No rate fits these flows.',
  too_short: 'Less than 30 days of history.',
};

const TOO_SHORT = XIRR_REASON.too_short;
const ALL_UNPRICED = 'Every holding in this scope is unpriced.';
const NOTHING_YET = 'Nothing to measure yet.';
/**
 * The disclosed refusal for money the day axis cannot carry (bug audit
 * 2026-08-18, blocker 1). Silently zeroing such a flow books the next priced
 * day's jump in value as pure performance; refusing says so instead.
 */
const FLOWS_OFF_AXIS = 'Some trades fall outside the days this scope can be priced on.';

function refused(note: string): MetricDisplay {
  return { value: '—', direction: 'neutral', note };
}

function figure(value: Decimal): MetricDisplay {
  return { value: fmtPct(value), direction: directionOf(value), note: null };
}

/* ------------------------------------------------------------------ *
 * The pure composer — exported so the exclusion rule and the scope
 * agreement are testable over injected inputs, with no DB and no vendor.
 * ------------------------------------------------------------------ */

export type AnalyticsTransaction = HoldingsSourceRow;

export interface AnalyticsComposeInputs {
  scopeId: string | null;
  scopes: AnalyticsScope[];
  /** ALL of the user's transactions; the scope filter is applied in here. */
  engineTxs: readonly AnalyticsTransaction[];
  quotes: ReadonlyMap<string, HoldingQuote>;
  fxRates: ReadonlyMap<string, string>;
  /** The UNDOWNSAMPLED daily series for the scope. */
  seriesPoints: readonly ChartPoint[];
  /**
   * Symbols the VALUATION SERIES could not carry — no daily closes in the
   * window, no FX, or past the backfill bound. Half of the one exclusion set
   * (decision 2); discarding them is what let a holding vanish from the curve
   * while its buys stayed in the flows.
   */
  seriesExcludedSymbols: readonly string[];
  partialDays: number;
  /**
   * The 'YYYY-MM-DD' of every partial day. A COUNT cannot tell the chain
   * WHICH day it must not measure, and a partial day that reads as empty is
   * indistinguishable from a liquidation without it (bug audit 2026-08-19,
   * major 1).
   */
  partialDates?: readonly string[];
  spyCloses: ReadonlyMap<string, string>;
  usdPlnByDay: ReadonlyMap<string, string>;
  profiles: ReadonlyMap<string, InstrumentProfile>;
  /**
   * The scope portfolio's stored target weights, joined to their symbols.
   * Empty (or absent) on the All scope — targets are strictly per portfolio.
   */
  targets?: readonly TargetWeight[];
  /** 'YYYY-MM-DD' in New York — the terminal cash flow's date. */
  todayISO: string;
}

/** One portfolio's engine run — the single source every figure folds. */
export interface PortfolioRun {
  portfolioId: string;
  portfolioName: string;
  positions: Position[];
}

/**
 * The engine, ONCE PER PORTFOLIO. Per-portfolio is the right granularity for
 * every figure on this screen: the portfolio dimension needs it, and running
 * the engine over the combined set as well would state the tiles for a
 * DIFFERENT quantity set than the slices whenever an oversell in one
 * portfolio would eat another portfolio's shares (a combined run nets them;
 * a per-portfolio run clamps at zero and flags `oversold`).
 */
export function runEnginePerPortfolio(
  txs: readonly AnalyticsTransaction[],
  quotes: ReadonlyMap<string, HoldingQuote>,
  fxRates: ReadonlyMap<string, string>,
): PortfolioRun[] {
  const byPortfolio = new Map<string, AnalyticsTransaction[]>();
  const names = new Map<string, string>();
  for (const t of txs) {
    names.set(t.portfolioId, t.portfolioName);
    const group = byPortfolio.get(t.portfolioId);
    if (group) group.push(t);
    else byPortfolio.set(t.portfolioId, [t]);
  }

  const runs: PortfolioRun[] = [];
  for (const [portfolioId, portfolioTxs] of byPortfolio) {
    runs.push({
      portfolioId,
      portfolioName: names.get(portfolioId) ?? 'Portfolio',
      positions: computePositions(portfolioTxs, quotes, fxRates),
    });
  }
  return runs;
}

export interface Exclusions {
  /**
   * The UNION — dropped from the valuation series and from the cash flows
   * alike, so the curve and the flow stream describe one instrument set.
   * Everything time-series (XIRR, TWRR, the benchmark) is governed by this.
   */
  seriesInstrumentIds: Set<string>;
  /**
   * `no_live_quote` ONLY — the exclusion that governs the SNAPSHOT surfaces:
   * the value tiles and the allocation breakdown. Those read today's quotes
   * and never a daily bar, so a history gap is not a reason to drop a
   * holding from them (bug audit 2026-08-19, major 2).
   */
  snapshotInstrumentIds: Set<string>;
  /** Every exclusion, named with its reason for the screen. Sorted by symbol. */
  symbols: ExcludedSymbol[];
}

/**
 * THE exclusion resolver (decision 2). Exported because the impure walk needs
 * it to rebuild the valuation series from the same set the flows use — that
 * shared call is what makes the two sets identical rather than merely
 * similar.
 */
export function resolveExclusions(
  runs: readonly PortfolioRun[],
  seriesExcludedSymbols: readonly string[],
  quotes: ReadonlyMap<string, HoldingQuote>,
  fxRates: ReadonlyMap<string, string>,
): Exclusions {
  const reasonBySymbol = new Map<string, ExclusionReason>();
  const unquoted = new Set<string>();

  // The summary's doctrine, unchanged and reused rather than restated: a
  // position with quantity > 0 that it could not price is named, never
  // zeroed. A CLOSED position never reaches this list.
  for (const run of runs) {
    for (const symbol of computePortfolioSummary(run.positions, quotes, fxRates)
      .excludedSymbols) {
      reasonBySymbol.set(symbol, 'no_live_quote');
      unquoted.add(symbol);
    }
  }

  // "No price history" is the more fundamental gap and overwrites the other
  // wording: an instrument the curve cannot carry is out of the time series
  // whether or not a live quote exists for it, and it is out even when it is
  // closed — its buy and sell would otherwise move the chain's denominator
  // without ever moving its value. It does NOT reach the snapshot surfaces:
  // a holding with a live quote is worth what the quote says today whether or
  // not the app can draw its past.
  for (const symbol of seriesExcludedSymbols) reasonBySymbol.set(symbol, 'no_price_history');

  const seriesInstrumentIds = new Set<string>();
  const snapshotInstrumentIds = new Set<string>();
  for (const run of runs) {
    for (const position of run.positions) {
      if (reasonBySymbol.has(position.symbol)) seriesInstrumentIds.add(position.instrumentId);
      if (unquoted.has(position.symbol)) snapshotInstrumentIds.add(position.instrumentId);
    }
  }

  const symbols = [...reasonBySymbol]
    .map(([symbol, reason]) => ({ symbol, reason }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  return { seriesInstrumentIds, snapshotInstrumentIds, symbols };
}

/**
 * Format one portfolio's target drift. The arithmetic already happened in
 * `buildTargetDrift` on `Decimal`; this only spells the results, and it
 * NEVER parses a formatted string back into a number.
 *
 * `fmtPct` is the slice rows' formatter — one spelling of a share on the
 * whole screen, and a null actual renders '—' exactly as the slices do. A
 * drift is a percentage-POINT delta, so its '%' becomes ' pp' (the
 * `ChartChange` doctrine). The amount is always positive and `action`
 * carries the sign, so no renderer has to read a minus out of money.
 */
function composeTargetDrift(
  holdings: readonly AllocationHolding[],
  targets: readonly TargetWeight[],
): AnalyticsView['targetDrift'] {
  const drift = buildTargetDrift(holdings, targets);
  if (drift === null) return null;

  const rows = drift.rows.map((row) => {
    const amount = row.amountPLN;
    return {
      instrumentId: row.instrumentId,
      symbol: row.symbol,
      // Null, not '0': a holding with no target has no opinion attached.
      target: row.targetPct === null ? null : fmtPct(row.targetPct),
      actual: fmtPct(row.actualPct),
      drift: row.driftPp === null ? null : fmtPct(row.driftPp).replace(/%$/, ' pp'),
      amount: amount === null ? null : fmtMoney(amount.abs(), 'PLN'),
      action:
        amount === null || amount.isZero()
          ? null
          : amount.greaterThan(0)
            ? ('buy' as const)
            : ('sell' as const),
    };
  });

  // A zero sum means there are no targets at all (every stored target is
  // > 0), which is silence rather than a complaint about arithmetic.
  const sumNote =
    drift.targetSum.isZero() || drift.targetSum.equals(100)
      ? null
      : `Targets add up to ${fmtPct(drift.targetSum).replace(/^\+/, '')}, not 100%.`;

  return { rows, sumNote };
}

export function composeAnalyticsView(inputs: AnalyticsComposeInputs): AnalyticsView {
  const { scopeId, quotes, fxRates } = inputs;
  // The SAME filter `composeHoldingsView` applies, so the scoped figures and
  // the All figures come from one builder.
  const txs = scopeId
    ? inputs.engineTxs.filter((t) => t.portfolioId === scopeId)
    : [...inputs.engineTxs];

  const runs = runEnginePerPortfolio(txs, quotes, fxRates);
  const exclusions = resolveExclusions(runs, inputs.seriesExcludedSymbols, quotes, fxRates);

  // The TIME-SERIES set: the flows and the value curve must describe the same
  // instruments. (The snapshot surfaces below take the narrower set.)
  const flows = buildCashFlows(txs, { excludeInstrumentIds: exclusions.seriesInstrumentIds });
  const inceptionDateISO = flows.length > 0 ? flows[0].dateISO : null;

  /* ---- The priced holdings: ONE fold, feeding the tiles AND the slices ---- */

  const holdings: AllocationHolding[] = [];
  let pricedValuePLN = ZERO;
  let pricedCostPLN = ZERO;

  for (const run of runs) {
    for (const position of run.positions) {
      if (!position.quantity.greaterThan(0)) continue;
      // The SNAPSHOT set, not the union: these tiles and the slices below are
      // today's quotes, and a missing daily bar says nothing about what a
      // live-quoted holding is worth right now (bug audit 2026-08-19,
      // major 2).
      if (exclusions.snapshotInstrumentIds.has(position.instrumentId)) continue;

      const quote = quotes.get(position.symbol);
      // A quote in the wrong currency would be multiplied by the wrong FX
      // rate — the same guard the engine and the summary apply.
      if (!quote || quote.currency !== position.currency) continue;
      const rate = position.currency === 'PLN' ? '1' : fxRates.get(position.currency);
      if (rate === undefined) continue;

      const valuePLN = position.quantity.times(dec(quote.price)).times(dec(rate));
      pricedValuePLN = pricedValuePLN.plus(valuePLN);
      pricedCostPLN = pricedCostPLN.plus(position.costBasisPLN);

      holdings.push({
        instrumentId: position.instrumentId,
        symbol: position.symbol,
        currency: position.currency,
        portfolioId: run.portfolioId,
        portfolioName: run.portfolioName,
        quantity: position.quantity,
        valuePLN,
      });
    }
  }

  const anythingPriced = holdings.length > 0;
  const totalGainPLN = anythingPriced ? pricedValuePLN.minus(pricedCostPLN) : null;

  // The terminal value closes the flow set. A zero or absent value adds
  // NOTHING — a fabricated zero flow would claim the portfolio is worthless
  // rather than admitting it could not be priced.
  //
  // **The date convention, stated because it is not obvious.** `todayISO` is
  // the date in NEW YORK (the history layer's clock), while a trade date is
  // whatever calendar day the user picked in the form — a Warsaw evening is
  // already the next day there. So the terminal flow is dated the LATER of
  // the two: never before a trade it already values, which would otherwise
  // invert the last two flows' order for a few hours each evening.
  //
  // **And it is CLAMPED to one day past today** (bug audit 2026-08-19,
  // minor 3). The skew this convention exists for is at most one calendar
  // day, but `lastFlowDateISO` had no upper bound at all, so a trade typo'd
  // as `2035-01-15` dated the terminal valuation nine years out and
  // discounted today's value over fifteen years instead of six — XIRR fell
  // from ~7 %/yr to ~2.7 %/yr, plausibly, permanently and with nothing on
  // screen saying so. TWRR already discloses that case (the flow falls past
  // the day axis and both figures refuse); this is XIRR's equivalent floor.
  const lastFlowDateISO = flows.length > 0 ? flows[flows.length - 1].dateISO : inputs.todayISO;
  const terminalCapISO = addDaysISO(inputs.todayISO, 1);
  const laterOfTodayAndLastFlow =
    lastFlowDateISO > inputs.todayISO ? lastFlowDateISO : inputs.todayISO;
  const terminalDateISO =
    laterOfTodayAndLastFlow > terminalCapISO ? terminalCapISO : laterOfTodayAndLastFlow;
  const solvable: CashFlow[] =
    anythingPriced && pricedValuePLN.greaterThan(0)
      ? [...flows, { dateISO: terminalDateISO, amountPLN: pricedValuePLN }]
      : flows;

  const xirrResult = xirr(solvable);
  const xirrDisplay = xirrResult.ok
    ? figure(xirrResult.rate.times(100))
    : refused(
        // `no_flows` with transactions on file means the exclusion filter took
        // every one of them. "No transactions yet" would be a lie about a
        // scope that has plenty; the honest sentence names the real cause.
        xirrResult.reason === 'no_flows' && txs.length > 0
          ? ALL_UNPRICED
          : XIRR_REASON[xirrResult.reason],
      );

  // TWRR chains the DAILY series; the external flows are the transaction
  // flows only — the terminal value is a valuation, not a movement of money.
  //
  // The flows are SNAPPED onto the series' own day axis rather than looked up
  // by an exact date (blocker 1): a trade dated on a weekend or a holiday has
  // no axis day of its own, and dropping it books the next trading day's jump
  // in value as pure performance. Anything the axis still cannot carry is
  // reconciled and REFUSED below, never rounded to nothing.
  const axisDates = inputs.seriesPoints.map((point) => isoFromEpochMs(point.t));
  const axisFlows = mapFlowsToAxis(externalFlowsByDay(flows), axisDates);
  const partialDates = new Set(inputs.partialDates ?? []);
  const twrrDays: TwrrDay[] = inputs.seriesPoints.map((point, index) => {
    const dateISO = axisDates[index];
    const flow = axisFlows.byDay.get(dateISO) ?? NO_DAY_FLOW;
    return {
      dateISO,
      valuePLN: dec(point.v),
      // Gross on both sides: a day that both bought and liquidated is
      // unmeasurable from the net alone (blocker-class error, major 1).
      inflowPLN: flow.inflowPLN,
      outflowPLN: flow.outflowPLN,
      partial: partialDates.has(dateISO),
    };
  });
  const twrrResult = twrr(twrrDays);
  const hasChain = twrrDays.length >= 2;
  // The DATES, not the net remainder: an unmapped buy and an unmapped sale of
  // the same size net to zero while both are still missing from the chain.
  const flowsOffAxis = axisFlows.unmappedDates.length > 0;
  const twrrAnnualized = !hasChain
    ? refused(NOTHING_YET)
    : flowsOffAxis
      ? refused(FLOWS_OFF_AXIS)
      : twrrResult.annualized === null
        ? refused(TOO_SHORT)
        : figure(twrrResult.annualized);
  const twrrCumulative = !hasChain
    ? refused(NOTHING_YET)
    : flowsOffAxis
      ? refused(FLOWS_OFF_AXIS)
      : figure(twrrResult.cumulative);

  /* ---- Allocation: one fold, four dimensions, over the SAME holdings ---- */

  // The allocation's own caption names only what the ALLOCATION leaves out.
  // A `no_price_history` holding is in these slices at its full live value,
  // so claiming otherwise beside them would be a false statement about the
  // figure right next to it (bug audit 2026-08-19, major 2).
  const allocation = buildAllocation(
    holdings,
    inputs.profiles,
    exclusions.symbols
      .filter((excluded) => excluded.reason === 'no_live_quote')
      .map((excluded) => excluded.symbol),
  );
  // Concentration folds the SAME allocation result — the Decimal values, not
  // the formatted strings below, which would be a re-derivation one locale
  // away from wrong.
  const conc = buildConcentration(allocation);
  const concentration =
    conc === null
      ? null
      : {
          topSymbol: conc.topSymbol,
          // The SAME formatter the ticker slice rows use, so the block and
          // the row can never print two spellings of one share.
          topShare: fmtPct(conc.topShare),
          // 0–100 integer string, decimal.js half-up — an index carries no
          // honest decimals.
          score: conc.hhi.toFixed(0),
        };
  const breakdown = {} as Record<AllocationDimension, AllocationSliceDisplay[]>;
  for (const dimension of ALLOCATION_DIMENSIONS) {
    breakdown[dimension] = allocation.byDimension[dimension].map((slice, index) => ({
      key: slice.key,
      label: slice.label,
      value: fmtMoney(slice.valuePLN, 'PLN'),
      pct: slice.pct === null ? '—' : fmtPct(slice.pct),
      // Geometry input for the bar/ring widths — a decimal STRING, converted
      // at the render boundary like every other plotted figure.
      share: (slice.pct ?? dec(0)).toString(),
      colorVar: sliceColorVar(slice.key, index),
    }));
  }

  // Target drift folds the SAME `holdings` array the allocation just folded,
  // so the drift card and the breakdown beside it agree by construction.
  // Strictly per portfolio: the All scope gets no figures at all.
  const targetDrift =
    scopeId === null ? null : composeTargetDrift(holdings, inputs.targets ?? []);

  const benchmark = buildBenchmark(inputs.seriesPoints, inputs.spyCloses, inputs.usdPlnByDay);

  return {
    scopeId,
    scopes: inputs.scopes,
    inceptionDateISO,
    xirr: xirrDisplay,
    twrrAnnualized,
    twrrCumulative,
    // Both tiles come from the SAME per-portfolio runs as the slices below,
    // so "priced value" and "unrealized gain" can never describe different
    // quantity sets (minor 6).
    totalGain: totalGainPLN === null ? null : fmtMoney(totalGainPLN, 'PLN'),
    totalGainDirection: directionOf(totalGainPLN),
    totalValue: anythingPriced ? fmtMoney(pricedValuePLN, 'PLN') : null,
    breakdown,
    concentration,
    targetDrift,
    benchmark,
    excludedSymbols: exclusions.symbols,
    skippedDays: twrrResult.skippedDays,
    partialDays: inputs.partialDays,
  };
}

/* ------------------------------------------------------------------ *
 * The impure walk.
 * ------------------------------------------------------------------ */

const viewMemo = new Map<string, { at: number; view: AnalyticsView }>();

export function invalidateAnalyticsMemo(userId: string): void {
  for (const key of viewMemo.keys()) {
    if (key.startsWith(`analytics:${userId}:`)) viewMemo.delete(key);
  }
}

function emptyView(scopeId: string | null, scopes: AnalyticsScope[]): AnalyticsView {
  const breakdown = {} as Record<AllocationDimension, AllocationSliceDisplay[]>;
  for (const dimension of ALLOCATION_DIMENSIONS) breakdown[dimension] = [];
  return {
    scopeId,
    scopes,
    inceptionDateISO: null,
    xirr: refused(XIRR_REASON.no_flows),
    twrrAnnualized: refused(NOTHING_YET),
    twrrCumulative: refused(NOTHING_YET),
    totalGain: null,
    totalGainDirection: 'neutral',
    totalValue: null,
    breakdown,
    // REQUIRED even though nullable: the route parses the schema, and a
    // missing key here 500s every empty scope while populated tests stay
    // green.
    concentration: null,
    // Same trap as `concentration`: `.nullable()` is still REQUIRED by the
    // route's `parse`, so omitting this key 500s every empty scope.
    targetDrift: null,
    benchmark: { portfolio: [], benchmark: [], degradedReason: null },
    excludedSymbols: [],
    skippedDays: 0,
    partialDays: 0,
  };
}

export async function getAnalyticsView(
  userId: string,
  portfolioIdParam: string | string[] | undefined,
): Promise<AnalyticsView> {
  // The ONE resolver, so a stale chip degrades to All exactly as on Holdings.
  const scopeId = await resolvePortfolioScope(userId, portfolioIdParam);

  // The scope IS part of the key: a shared key would serve one scope's
  // numbers for another's for up to the TTL (the `portfolio-series.ts` memo,
  // same shape and same reason).
  const memoKey = `analytics:${userId}:${scopeId ?? 'all'}`;
  const hit = viewMemo.get(memoKey);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.view;
  if (hit) viewMemo.delete(memoKey);

  // The chips are resolved BEFORE the walk and OUTSIDE its try (bug audit
  // 2026-08-18, minor 8): a failing vendor or history leg must degrade to a
  // screen with no figures, not to a screen that looks like the user has no
  // portfolios at all.
  const scopes = await loadScopes(userId);

  try {
    const loaded = await loadHoldingsInputs(userId);
    // `loaded.rows` rather than `inputs.engineTxs`: they are the same array,
    // but `rows` is the typed one — `ScopedEngineTransaction` makes
    // `portfolioId` optional and carries no `portfolioName`, and the
    // allocation's portfolio dimension needs both.
    const rows = loaded.rows;

    const txs = scopeId ? rows.filter((t) => t.portfolioId === scopeId) : rows;
    if (txs.length === 0) return emptyView(scopeId, scopes);

    const today = nyDateISOAt(Date.now());
    const anchorDate = txs.map((t) => t.tradeDate).sort()[0];
    const window = { from: anchorDate, to: today };

    // Sorted by symbol, because only the FIRST `MAX_BACKFILL_SYMBOLS` of this
    // list get their history backfilled from the vendor. In transaction order
    // that bound would fall on a different set of instruments as the user
    // trades, so which holdings the value curve can carry would drift between
    // loads. Arbitrary-but-stable is the most this bound can offer, and the
    // ones it cannot carry are named on screen either way.
    const instrumentRefs = [
      ...new Map(
        txs.map((t) => [t.instrumentId, { id: t.instrumentId, symbol: t.symbol, currency: t.currency }]),
      ).values(),
    ].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

    const [closesByInstrument, fxByCurrency, usdPlnByDay, spyCloses, profiles, targets] =
      await Promise.all([
        loadDailyClosesByInstrument(instrumentRefs, window),
        loadFxByCurrency(instrumentRefs.map((i) => i.currency), window),
        // The benchmark is priced in USD and the portfolio in PLN, so this map
        // is needed even for an all-PLN portfolio.
        getFxRatesForRange('USD', window.from, window.to).catch(() => new Map<string, string>()),
        loadProxyCloses(INDEX_PROXIES[0], window),
        loadProfiles(instrumentRefs.map((i) => i.id)),
        // Targets are per portfolio, so the All scope asks for nothing at
        // all — `scopeId` has already been ownership-resolved above.
        scopeId === null ? Promise.resolve<TargetWeight[]>([]) : loadTargets(scopeId),
      ]);

    // Pass one: build the series to LEARN what it had to leave out.
    const firstPass = buildDailyPortfolioSeries({
      txs: [...txs],
      closesByInstrument,
      fxByCurrency,
      window,
    });

    // Pass two: ONE exclusion set (decision 2), and the series rebuilt
    // without it — so the instruments in the value curve and the instruments
    // in the cash-flow stream are the same set. Skipped entirely when there
    // is nothing to exclude, which is the common case.
    const runs = runEnginePerPortfolio(txs, loaded.quotes, loaded.inputs.fxRates);
    const exclusions = resolveExclusions(
      runs,
      firstPass.excludedSymbols,
      loaded.quotes,
      loaded.inputs.fxRates,
    );
    const built =
      exclusions.seriesInstrumentIds.size === 0
        ? firstPass
        : buildDailyPortfolioSeries({
            txs: txs.filter((t) => !exclusions.seriesInstrumentIds.has(t.instrumentId)),
            closesByInstrument,
            fxByCurrency,
            window,
          });

    const view = composeAnalyticsView({
      scopeId,
      scopes,
      engineTxs: txs,
      quotes: loaded.quotes,
      fxRates: loaded.inputs.fxRates,
      // The pure builder's own points — never the downsampled wrapper,
      // whose ~400-point cap would destroy the day chain TWRR is built from.
      seriesPoints: built.points,
      // Both passes' exclusions: the rebuild cannot introduce a new one (the
      // predicate is per instrument and independent of the others), and the
      // union is the belt on that reasoning.
      seriesExcludedSymbols: [...firstPass.excludedSymbols, ...built.excludedSymbols],
      partialDays: built.partialDays,
      // The dates, not just the count: the chain must know WHICH days it
      // cannot measure (major 1).
      partialDates: built.partialDates,
      spyCloses,
      usdPlnByDay,
      profiles,
      targets,
      todayISO: today,
    });

    viewMemo.set(memoKey, { at: Date.now(), view });
    return view;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'analytics build failed';
    console.error(`Analytics view failed: ${message}`);
    // The chips survive the failure: an empty chip row would say "you have no
    // portfolios", which is a different — and false — statement.
    return emptyView(scopeId, scopes);
  }
}

/**
 * The portfolio chips, on their own query and OUTSIDE the walk's try. They
 * are navigation, not figures: they must still render when every figure on
 * the screen has degraded. Ordered by the user's own drag/menu ordering, the
 * same `sortOrder` the Holdings chips use.
 */
async function loadScopes(userId: string): Promise<AnalyticsScope[]> {
  try {
    return await db
      .select({ id: portfolios.id, name: portfolios.name })
      .from(portfolios)
      .where(eq(portfolios.userId, userId))
      .orderBy(asc(portfolios.sortOrder), asc(portfolios.createdAt));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'portfolio list failed';
    console.error(`Analytics scope list failed: ${message}`);
    return [];
  }
}

/** Densified NBP maps per distinct non-PLN currency; a failure skips one. */
async function loadFxByCurrency(
  currencies: readonly string[],
  window: { from: string; to: string },
): Promise<Map<string, Map<string, string>>> {
  const fxByCurrency = new Map<string, Map<string, string>>();
  for (const currency of new Set(currencies)) {
    if (currency === 'PLN') continue;
    try {
      fxByCurrency.set(currency, await getFxRatesForRange(currency, window.from, window.to));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'fx range failed';
      console.error(`Analytics FX range failed: ${message}`);
    }
  }
  return fxByCurrency;
}

/**
 * Sync-on-visit, then read back — the `src/lib/dividends/view.ts` precedent:
 * there is no cron for the classification columns, so the page that needs
 * them is what fills them. Both halves are best-effort; the worst case is an
 * "Unknown" bucket that fills in on a later load.
 */
async function loadProfiles(
  instrumentIds: readonly string[],
): Promise<Map<string, InstrumentProfile>> {
  const profiles = new Map<string, InstrumentProfile>();
  if (instrumentIds.length === 0) return profiles;

  await syncInstrumentProfiles(instrumentIds);

  try {
    const rows = await db
      .select({
        id: instruments.id,
        sector: instruments.sector,
      })
      .from(instruments)
      .where(inArray(instruments.id, [...instrumentIds]));
    for (const row of rows) {
      profiles.set(row.id, { sector: row.sector });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'profile read failed';
    console.error(`Analytics profile read failed: ${message}`);
  }
  return profiles;
}

/**
 * One portfolio's stored target weights, joined to `instruments` for the
 * symbol the card prints. No `userId` filter is needed and none would help:
 * `scopeId` reached here through `resolvePortfolioScope`, which already
 * refused (degraded to All) anything the caller does not own.
 */
async function loadTargets(portfolioId: string): Promise<TargetWeight[]> {
  const rows = await db
    .select({
      instrumentId: portfolioTargets.instrumentId,
      symbol: instruments.symbol,
      targetPct: portfolioTargets.targetPct,
    })
    .from(portfolioTargets)
    .innerJoin(instruments, eq(instruments.id, portfolioTargets.instrumentId))
    .where(eq(portfolioTargets.portfolioId, portfolioId));

  // numeric(7,4) arrives as a padded string; `dec` is the only conversion
  // this value ever gets (non-negotiable #1).
  return rows.map((row) => ({
    instrumentId: row.instrumentId,
    symbol: row.symbol,
    targetPct: dec(row.targetPct),
  }));
}
