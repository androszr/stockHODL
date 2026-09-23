import 'server-only';

import type { WidgetSummaryResponseContract } from '@/lib/api/contracts';
import { mapWithConcurrency } from '@/lib/async-pool';
import { resolveRange } from '@/lib/charts/ranges';
import { addDaysIso } from '@/lib/dates';
import {
  composeHoldingsView,
  loadHoldingsInputs,
  type HoldingQuote,
} from '@/lib/holdings/live-view';
import { computePortfolioSummary } from '@/lib/holdings/summary';
import {
  MAX_INTRADAY_SYMBOLS,
  getPortfolioValueSeries,
} from '@/lib/history/portfolio-series';
import { nyDateISOAt } from '@/lib/market-data/market-clock';
import { massiveProvider } from '@/lib/market-data/massive';
import { dec, toNumeric } from '@/lib/money';
import { resolveOptionPrints } from '@/lib/options/fresh-print';
import { loadOptionsInputs } from '@/lib/options/live-view';
import { markOptionQuotes } from '@/lib/options/option-mark';
import { composeLiveOptionsPayload } from '@/lib/options/options-payload';
import {
  computePositions,
  displayablePositions,
  type EngineTransaction,
} from '@/lib/position-engine';

import {
  downsampleDayLine,
  fittedCap,
  lastRegularSession,
  sessionBounds,
  shouldShipWidgetDayLines,
  toSessionPercentSeries,
  type SessionBounds,
  type WidgetDayPoint,
} from './day-line';
import {
  optionsSessionPercentSeries,
  type OptionIntradayLot,
  type OptionPrint,
} from './options-intraday';

/** Same pool width as `portfolio-series.ts` — never export theirs. */
const HISTORY_CONCURRENCY = 5;

/** Hold the last percent out to `endMs` so a closed day is full width. */
function carryLastPercentTo(
  points: readonly WidgetDayPoint[],
  endMs: number,
): WidgetDayPoint[] {
  const last = points[points.length - 1];
  if (!last || endMs <= last.t) return [...points];
  return [...points, { t: endMs, p: last.p }];
}

function previousClosePLN(
  txs: readonly EngineTransaction[],
  quotes: ReadonlyMap<string, HoldingQuote>,
  fxRates: ReadonlyMap<string, string>,
): string | null {
  const positions = displayablePositions(computePositions([...txs], quotes, fxRates));
  const summaryQuotes = new Map(
    [...quotes].map(([symbol, quote]) => [
      symbol,
      { price: quote.price, currency: quote.currency, dayChangeAmt: quote.dayChangeAmt },
    ]),
  );
  const summary = computePortfolioSummary(positions, summaryQuotes, fxRates);
  if (summary.totalValuePLN === null || summary.dayChangePLN === null) return null;
  const baseline = summary.totalValuePLN.minus(summary.dayChangePLN);
  if (baseline.isZero()) return null;
  return toNumeric(baseline);
}

async function holdingsDayLine(
  userId: string,
  loaded: Awaited<ReturnType<typeof loadHoldingsInputs>>,
): Promise<{ points: WidgetDayPoint[]; session: SessionBounds | null }> {
  try {
    // lastRegularSession keeps Friday until today's bars exist. Passing
    // that session into options skips its own early_trading empty-return,
    // and iOS live-colours it once status flips to open.
    if (loaded.inputs.market.status === 'early_trading') {
      return { points: [], session: null };
    }
    const series = await getPortfolioValueSeries(userId, '1D');
    const last = lastRegularSession(series.points);
    if (last.length === 0) return { points: [], session: null };
    const overrides = await massiveProvider.getCalendarOverrides();
    const session = sessionBounds(last[0].t, overrides);
    if (session === null) return { points: [], session: null };
    if (!shouldShipWidgetDayLines(loaded.inputs.market.status, session, Date.now())) {
      return { points: [], session: null };
    }
    const baseline = previousClosePLN(
      loaded.inputs.engineTxs,
      loaded.quotes,
      loaded.inputs.fxRates,
    );
    if (baseline === null) return { points: [], session };
    const endMs =
      loaded.inputs.market.status === 'open'
        ? Math.min(Date.now(), session.closeMs)
        : session.closeMs;
    return {
      points: downsampleDayLine(
        carryLastPercentTo(toSessionPercentSeries(last, baseline), endMs),
      ),
      session,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'holdings day-line failed';
    console.error(`Widget holdings day-line failed: ${message}`);
    return { points: [], session: null };
  }
}

async function optionsDayLine(
  loaded: Awaited<ReturnType<typeof loadOptionsInputs>>,
  session: SessionBounds | null,
): Promise<{ points: WidgetDayPoint[]; session: SessionBounds | null }> {
  try {
    const today = nyDateISOAt(Date.now());
    const lots: OptionIntradayLot[] = loaded.rows
      .filter((row) => row.expirationDate >= today)
      .map((row) => ({
        ticker: row.ticker,
        quantity: row.quantity,
        sharesPerContract: row.sharesPerContract,
      }));
    const tickers = [...new Set(lots.map((lot) => lot.ticker))];
    if (tickers.length === 0) return { points: [], session: null };
    if (tickers.length > MAX_INTRADAY_SYMBOLS) return { points: [], session: null };

    const nowMs = Date.now();
    const prints = resolveOptionPrints(
      loaded.quotes,
      loaded.bars,
      loaded.market,
      nowMs,
      markOptionQuotes(loaded.quotes, loaded.spots, nowMs),
      loaded.recentMarks,
    );
    const seedByTicker = new Map<string, string>();
    for (const ticker of tickers) {
      const print = prints.get(ticker);
      if (print?.dayBasisBaseMark) {
        seedByTicker.set(ticker, print.dayBasisBaseMark);
      } else if (print?.price && print.day) {
        seedByTicker.set(ticker, toNumeric(dec(print.price).minus(dec(print.day.amt))));
      }
    }
    if (seedByTicker.size === 0) return { points: [], session: null };

    let bounds = session;
    if (bounds === null) {
      // Pre-market of a live NY date has no regular bars yet — the plot is
      // absent until the cash open (numbers stay). Do not invent today's
      // unopened session; a walk-back would paint yesterday during 04:00–
      // 09:30 ET, which is the wrong closed-day case.
      if (loaded.market.status === 'early_trading') {
        return { points: [], session: null };
      }
      const overrides = await massiveProvider.getCalendarOverrides();
      let date = today;
      for (let i = 0; i < 7 && bounds === null; i++) {
        const candidate = sessionBounds(Date.parse(`${date}T20:00:00Z`), overrides);
        if (candidate && candidate.openMs <= Date.now()) bounds = candidate;
        date = addDaysIso(date, -1);
      }
      if (bounds === null) return { points: [], session: null };
    }
    if (!shouldShipWidgetDayLines(loaded.market.status, bounds, Date.now())) {
      return { points: [], session: null };
    }

    const resolved = resolveRange('1D', {
      today,
      anchorDate: addDaysIso(today, -30),
    });
    if (resolved === null || resolved.kind !== 'intraday') {
      return { points: [], session: null };
    }

    const printsByTicker = new Map<string, OptionPrint[]>();
    await mapWithConcurrency(tickers, HISTORY_CONCURRENCY, async (ticker) => {
      try {
        const candles = await massiveProvider.getAggregates(ticker, {
          multiplier: resolved.multiplier,
          timespan: 'minute',
          from: String(resolved.fromMs),
          to: String(resolved.toMs),
        });
        printsByTicker.set(
          ticker,
          candles.map((candle) => ({ t: candle.t, close: candle.close })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'option aggregates failed';
        console.error(`Widget options day-line failed (${ticker}): ${message}`);
        printsByTicker.set(ticker, []);
      }
    });

    const carryToMs =
      loaded.market.status === 'open'
        ? Math.min(Date.now(), bounds.closeMs)
        : bounds.closeMs;
    return {
      points: optionsSessionPercentSeries(
        lots,
        printsByTicker,
        seedByTicker,
        bounds,
        carryToMs,
      ),
      session: bounds,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'options day-line failed';
    console.error(`Widget options day-line failed: ${message}`);
    return { points: [], session: null };
  }
}

/**
 * Everything the widget paints. Summaries always return; `dayLines` is
 * best-effort and omitted when both paths are empty so the payload stays small.
 */
export async function loadWidgetSummary(
  userId: string,
): Promise<WidgetSummaryResponseContract> {
  const [holdingsLoaded, optionsLoaded] = await Promise.all([
    loadHoldingsInputs(userId),
    loadOptionsInputs(userId),
  ]);
  const view = composeHoldingsView(holdingsLoaded);
  const options = composeLiveOptionsPayload(optionsLoaded);

  let dayLines: WidgetSummaryResponseContract['dayLines'];
  try {
    const holdingsPath = await holdingsDayLine(userId, holdingsLoaded);
    const optionsPath = await optionsDayLine(optionsLoaded, holdingsPath.session);
    const session = holdingsPath.session ?? optionsPath.session;
    const cap = fittedCap(holdingsPath.points, optionsPath.points);
    const nowMs = Date.now();
    if (
      session !== null &&
      cap !== null &&
      !cap.isZero() &&
      shouldShipWidgetDayLines(view.live.market.status, session, nowMs)
    ) {
      dayLines = {
        sessionOpenMs: session.openMs,
        sessionCloseMs: session.closeMs,
        holdings: holdingsPath.points,
        options: optionsPath.points,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'day-line failed';
    console.error(`Widget day-line failed: ${message}`);
  }

  return {
    holdings: view.live.summary,
    options: options.summary,
    market: view.live.market,
    ...(dayLines ? { dayLines } : {}),
  };
}
