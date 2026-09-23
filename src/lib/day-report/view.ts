import 'server-only';

import type Decimal from 'decimal.js';

import type { DayReportResponse } from '@/lib/api/contracts/day-report';
import { addDaysIso } from '@/lib/dates';
import { getFxRatesForRange } from '@/lib/fx/nbp';
import { getLatestClosesBefore } from '@/lib/history/price-history';
import { loadDailyClosesByInstrument } from '@/lib/history/portfolio-series';
import { loadHoldingsInputs } from '@/lib/holdings/live-view';
import { resolvePortfolioScope } from '@/lib/holdings/scope';
import { signedMoney } from '@/lib/holdings/live-payload';
import { readStoredCalendar } from '@/lib/market-data/calendar-store';
import { regularSessionFor } from '@/lib/market-data/market-clock';
import { directionOf, fmtDecimal, fmtMoney, fmtPct } from '@/lib/money';
import { loadHeadlinesForSymbols } from '@/lib/news/feed';
import { dayReportOptionLabel } from '@/lib/options/options-payload';
import { computePositions } from '@/lib/position-engine';

import { benchmarkDayChanges } from './benchmarks';
import {
  adjacentSessionDays,
  dayReportBounds,
  isReportableDay,
  segmentAvailability,
  type DayReportBounds,
} from './calendar';
import { loadEventsForDay, EARNINGS_CAPTION } from './events';
import { dayReportFacts, type DayReportFacts } from './facts';
import { computeDayReportFigures, liveFigures, usdPlnMove, type DayReportFigures } from './figures';
import type { DayReportKind } from './kinds';
import { scopeKeyFor } from './kinds';
import { factsFingerprint, readNarrative } from './narrative-store';
import { computeOptionsDayFigures, combineDayFigures, liveOptionsDayFigures } from './options-figures';
import { loadOptionsForDay } from './options-loader';
import { chooseFigureSource } from './source';
import { dayValueLine } from './value-line';
import type { StoredDayFigure } from './view-types';

const MEMO_TTL_MS = 60_000;
const viewMemo = new Map<
  string,
  { at: number; view: DayReportResponse; figure: StoredDayFigure; held: DayReportHeld }
>();

/**
 * What the WRITER needs beyond the screen payload: every held name (not
 * just the five movers on screen) and every open option position, so it
 * can search earnings dates and place expiries. Server-side only — never
 * on the wire.
 */
export interface DayReportHeld {
  symbols: Array<{ symbol: string; name: string }>;
  options: Array<{ underlying: string; label: string; expirationDate: string }>;
}

const NO_HELD: DayReportHeld = { symbols: [], options: [] };

/** A composed report and the headline figure it showed — the pair the narrative store persists together. */
export interface DayReportViewWithFigure {
  view: DayReportResponse;
  /** Null on the early-return paths (no trades, no reportable day): nothing was computed. */
  figure: StoredDayFigure | null;
  held: DayReportHeld;
}

export function invalidateDayReportMemo(userId: string): void {
  for (const key of viewMemo.keys()) {
    if (key.startsWith(`day-report:${userId}:`)) viewMemo.delete(key);
  }
}

export async function getDayReportView(
  userId: string,
  input: { day?: string; kind: DayReportKind; portfolioId?: string },
): Promise<DayReportResponse> {
  return (await getDayReportViewWithFigure(userId, input)).view;
}

async function getDayReportViewWithFigure(
  userId: string,
  input: { day?: string; kind: DayReportKind; portfolioId?: string },
): Promise<DayReportViewWithFigure> {
  const scopeId = await resolvePortfolioScope(userId, input.portfolioId);
  const calendar = await readStoredCalendar();
  const loaded = await loadHoldingsInputs(userId);
  const rows = scopeId ? loaded.rows.filter((row) => row.portfolioId === scopeId) : loaded.rows;
  const firstTradeDate = rows.map((row) => row.tradeDate).sort()[0];
  const nowMs = Date.now();
  const latestCompleted = previousSession(addDaysIso(new Date(nowMs).toISOString().slice(0, 10), 1), calendar.overrides);
  if (firstTradeDate === undefined) {
    const day = input.day ?? latestCompleted ?? new Date(nowMs).toISOString().slice(0, 10);
    return { view: emptyView(day, input.kind, scopeId, loaded.inputs.portfolios ?? [], null), figure: null, held: NO_HELD };
  }
  const bounds = dayReportBounds({ nowMs, overrides: calendar.overrides, firstTradeDate });
  if (bounds === null) {
    return {
      view: emptyView(input.day ?? firstTradeDate, input.kind, scopeId, loaded.inputs.portfolios ?? [], null),
      figure: null,
      held: NO_HELD,
    };
  }

  const requested = input.day ?? bounds.latest;
  if (!isReportableDay(requested, bounds, calendar.overrides)) {
    const nearest = clampNearestDay(requested, bounds, calendar.overrides);
    return { view: emptyView(requested, input.kind, scopeId, loaded.inputs.portfolios ?? [], nearest), figure: null, held: NO_HELD };
  }

  const memoKey = `day-report:${userId}:${requested}:${scopeKeyFor(scopeId)}:${input.kind}`;
  const hit = viewMemo.get(memoKey);
  if (hit && nowMs - hit.at < MEMO_TTL_MS) return { view: hit.view, figure: hit.figure, held: hit.held };

  return composeDayReport({
    userId, kind: input.kind, scopeId, calendar, loaded, rows, nowMs, bounds, dayISO: requested, memoKey,
  });
}

interface ComposeContext {
  userId: string;
  kind: DayReportKind;
  scopeId: string | null;
  calendar: Awaited<ReturnType<typeof readStoredCalendar>>;
  loaded: Awaited<ReturnType<typeof loadHoldingsInputs>>;
  rows: Awaited<ReturnType<typeof loadHoldingsInputs>>['rows'];
  nowMs: number;
  bounds: DayReportBounds;
  dayISO: string;
  memoKey: string;
}

/**
 * The body of a report for one reportable day: figures, movers, line,
 * benchmarks, headlines, events, and the narrative read. Returns the view AND
 * the raw headline figure (as decimal strings) so the narrative store can
 * persist the exact number the page showed — the history list never
 * recomputes it. Memoised together for `MEMO_TTL_MS`.
 */
async function composeDayReport(ctx: ComposeContext): Promise<DayReportViewWithFigure> {
  const { userId, kind, scopeId, calendar, loaded, rows, nowMs, bounds, dayISO, memoKey } = ctx;
  const reportPrevSession = previousSession(dayISO, calendar.overrides);
  const figureDayISO = kind === 'morning' ? (reportPrevSession ?? dayISO) : dayISO;
  const figurePrevSession = previousSession(figureDayISO, calendar.overrides);
  const source =
    kind === 'morning'
      ? 'stored' as const
      : chooseFigureSource({ dayISO, nowMs, overrides: calendar.overrides });
  const txs = rows.filter((row) => row.tradeDate <= dayISO);
  const figureTxs = rows.filter((row) => row.tradeDate <= figureDayISO);
  const positions = computePositions(figureTxs);
  const reportPositions = computePositions(txs);
  const refs = [
    ...new Map(
      txs.map((row) => [
        row.instrumentId,
        { id: row.instrumentId, symbol: row.symbol, currency: row.currency },
      ]),
    ).values(),
  ];
  const from = addDaysIso(figureDayISO, -21);
  const closesByInstrument = await loadDailyClosesByInstrument(refs, { from, to: figureDayISO });
  const fxByCurrency = new Map<string, Map<string, string>>();
  for (const currency of new Set(refs.map((ref) => ref.currency))) {
    fxByCurrency.set(currency, await getFxRatesForRange(currency, from, figureDayISO));
  }
  if (!fxByCurrency.has('USD')) {
    fxByCurrency.set('USD', await getFxRatesForRange('USD', addDaysIso(figureDayISO, -10), figureDayISO));
  }
  const fxForDay = new Map<string, string>();
  for (const [currency, rates] of fxByCurrency) {
    const rate = rates.get(figureDayISO);
    if (rate !== undefined) fxForDay.set(currency, rate);
  }

  let holdings: DayReportFigures;
  if (source === 'live') {
    holdings = liveFigures(
      computePositions(figureTxs, loaded.quotes, loaded.inputs.fxRates),
      loaded.quotes,
      loaded.inputs.fxRates,
    );
  } else {
    const current = new Map<string, string>();
    for (const [instrumentId, closes] of closesByInstrument) {
      const close = closes.get(figureDayISO);
      if (close !== undefined) current.set(instrumentId, close);
    }
    holdings = computeDayReportFigures({
      positions,
      closeByInstrument: current,
      prevCloseByInstrument: await getLatestClosesBefore(refs.map((ref) => ref.id), figureDayISO),
      fxByCurrency: fxForDay,
    });
  }

  const optionLoaded =
    figurePrevSession === null
      ? ({ status: 'unavailable' } as const)
      : await loadOptionsForDay(userId, figureDayISO, source, figurePrevSession, nowMs);
  const fxUsd = fxForDay.get('USD') ?? loaded.inputs.fxRates.get('USD');
  const options =
    scopeId !== null || optionLoaded.status !== 'ready' || fxUsd === undefined
      ? null
      : source === 'live'
        ? liveOptionsDayFigures(optionLoaded.contributions, fxUsd)
        : computeOptionsDayFigures({
            lots: optionLoaded.lots,
            valuationsByTickerDate: optionLoaded.valuationsByTickerDate,
            prevSession: figurePrevSession as string,
            dayISO: figureDayISO,
            fxUsd,
          });
  const combined = combineDayFigures(holdings, options);
  const movers = composeMovers(holdings.contributions);
  const optionMovers = composeOptionMovers(options?.groups ?? []);
  const line =
    kind === 'close'
      ? await dayValueLine(txs, dayISO, source, calendar.overrides, closesByInstrument, fxByCurrency)
      : { kind: 'none' as const, points: [], windowLabel: null, partialDays: 0, excludedSymbols: [] };
  const benchmarks = await benchmarkDayChanges(
    kind === 'morning' ? dayISO : figureDayISO,
    kind === 'morning' ? 'live' : source,
    calendar.overrides,
  );
  const usd = usdPlnMove(fxByCurrency.get('USD') ?? new Map(), figureDayISO);
  const session = regularSessionFor(dayISO, calendar.overrides);
  const previous = reportPrevSession ? regularSessionFor(reportPrevSession, calendar.overrides) : null;
  const headlineSymbols = [...new Set([
    ...reportPositions.filter((position) => position.quantity.gt(0)).map((position) => position.symbol),
    ...(optionLoaded.status === 'ready' ? optionLoaded.lots.map((lot) => lot.underlying) : []),
  ])];
  const headlines =
    session && previous
      ? await loadHeadlinesForSymbols(userId, headlineSymbols, {
          fromMs: previous.closeMs,
          // Morning = what was known before the bell, whenever it is read.
          toMs: kind === 'morning' ? Math.min(nowMs, session.openMs) : session.closeMs,
        })
      : [];
  const eventItems = await loadEventsForDay(
    userId,
    headlineSymbols,
    dayISO,
    optionLoaded.status === 'ready' ? optionLoaded.lots : [],
  );
  const adjacent = adjacentSessionDays(dayISO, bounds, calendar.overrides);
  const base: DayReportResponse = {
    status: 'ready',
    nearestDay: dayISO,
    day: dayISO,
    dayLabel: dayLabel(dayISO),
    kind: kind,
    prevDay: adjacent.prev,
    nextDay: adjacent.next,
    isLatest: dayISO === bounds.latest,
    segments: segmentAvailability(dayISO, nowMs, calendar.overrides),
    scopeId,
    scopes: (loaded.inputs.portfolios ?? []).map((portfolio) => ({ id: portfolio.id, name: portfolio.name })),
    figures: {
      status:
        combined.valueAtClosePLN !== null
          ? 'ready'
          : positions.length === 0 && (options?.groups.length ?? 0) === 0
            ? 'empty'
            : 'not_ready',
      source,
      // Whole złoty: at portfolio size the grosze are noise (owner's call, 2026-09-21).
      valueAtClose: combined.valueAtClosePLN ? fmtMoney(combined.valueAtClosePLN, 'PLN', 0) : null,
      dayChange: signedDisplay(combined.dayChangePLN),
      dayChangePct: combined.dayChangePct ? fmtPct(combined.dayChangePct) : null,
      holdings: figurePart(holdings),
      options: options ? figurePart(options) : null,
      optionsDayChangeUSD:
        options?.dayChangeUSD === null || options?.dayChangeUSD === undefined
          ? null
          : signedMoney(options.dayChangeUSD, 'USD'),
      optionsNote: scopeId === null ? null : 'Options are not assigned to portfolios.',
      optionsRelation: combined.optionsRelation,
      partial: combined.partial,
      partialSymbols: [...holdings.partialSymbols, ...(options?.excludedLabels ?? [])],
      excludedSymbols: holdings.excludedSymbols,
      positionCount: holdings.contributions.length + (options?.groups.length ?? 0),
    },
    recap:
      kind === 'morning' && combined.dayChangePLN !== null
        ? {
            day: figureDayISO,
            dayChange: signedDisplay(combined.dayChangePLN) as NonNullable<DayReportResponse['recap']>['dayChange'],
            dayChangePct: combined.dayChangePct ? fmtPct(combined.dayChangePct) : null,
          }
        : null,
    movers,
    optionMovers,
    valueLine: line,
    benchmarks: benchmarks.map((benchmark) => ({
      indexName: benchmark.indexName,
      proxySymbol: benchmark.proxySymbol,
      dayPct: benchmark.dayPct ? fmtPct(benchmark.dayPct) : null,
      direction: directionOf(benchmark.dayPct),
      extendedPct: benchmark.extendedPct ? fmtPct(benchmark.extendedPct) : null,
      extendedKind: benchmark.extendedKind,
    })),
    usdPln: usd
      ? {
          rate: fmtDecimal(usd.rate, 4, 4),
          move: fmtPct(usd.pct),
          direction: directionOf(usd.pct),
        }
      : null,
    headlines: headlines.map((headline) => ({
      id: headline.id,
      title: headline.title,
      publisherName: headline.publisherName,
      publishedAtMs: headline.publishedAtMs,
      matchedTickers: headline.matchedTickers,
      sentiment:
        headline.matchedTickers.map((ticker) => headline.sentimentByTicker[ticker]).find(Boolean) ?? null,
      url: headline.articleUrl,
      summary: headline.description,
    })),
    events: { items: eventItems, earningsCaption: EARNINGS_CAPTION },
    narrative: emptyNarrative(),
  };
  const nameBySymbol = new Map(rows.map((row) => [row.symbol, row.displayName]));
  const held: DayReportHeld = {
    symbols: reportPositions
      .filter((position) => position.quantity.gt(0))
      .map((position) => ({ symbol: position.symbol, name: nameBySymbol.get(position.symbol) ?? position.symbol })),
    options:
      optionLoaded.status === 'ready'
        ? optionLoaded.lots.map((lot) => ({
            underlying: lot.underlying,
            label: dayReportOptionLabel(lot),
            expirationDate: lot.expirationDate,
          }))
        : [],
  };
  const facts = dayReportFacts(base, scopeName(scopeId, loaded.inputs.portfolios ?? []), held);
  base.narrative = await readNarrative(
    userId,
    dayISO,
    scopeKeyFor(scopeId),
    kind,
    factsFingerprint(facts),
  );
  const figure: StoredDayFigure = {
    figureDay: figureDayISO,
    dayChangePLN: combined.dayChangePLN?.toString() ?? null,
    dayChangePct: combined.dayChangePct?.toString() ?? null,
    partial: combined.partial,
  };
  viewMemo.set(memoKey, { at: nowMs, view: base, figure, held });
  return { view: base, figure, held };
}

/**
 * What the narrative store needs to write one report: the facts the model is
 * given (and that the fingerprint hashes — `figure` is deliberately NOT part
 * of them, so existing rows stay non-stale) plus the headline figure to
 * persist beside the prose. Null iff no narrative can be generated.
 */
export async function buildFactsForNarrative(
  userId: string,
  dayISO: string,
  portfolioId: string | null,
  kind: DayReportKind,
): Promise<{ facts: DayReportFacts; figure: StoredDayFigure | null } | null> {
  const { view, figure, held } = await getDayReportViewWithFigure(userId, {
    day: dayISO, kind, portfolioId: portfolioId ?? undefined,
  });
  if (!canGenerateNarrative(view, kind)) return null;
  const name = view.scopeId === null ? 'All portfolios' : view.scopes.find((scope) => scope.id === view.scopeId)?.name;
  return { facts: dayReportFacts(view, name ?? 'Portfolio', held), figure };
}

export function canGenerateNarrative(view: DayReportResponse, kind: DayReportKind): boolean {
  if (view.status !== 'ready') return false;
  if (kind === 'morning') return view.segments.morning === 'ready';
  return view.segments.close === 'ready' && view.figures.status === 'ready';
}

function previousSession(dayISO: string, overrides: Parameters<typeof regularSessionFor>[1]): string | null {
  let day = dayISO;
  for (let index = 0; index < 14; index++) {
    day = addDaysIso(day, -1);
    if (regularSessionFor(day, overrides)) return day;
  }
  return null;
}

function clampNearestDay(day: string, bounds: DayReportBounds, overrides: Parameters<typeof regularSessionFor>[1]): string {
  if (day <= bounds.earliest) return bounds.earliest;
  if (day >= bounds.latest) return bounds.latest;
  return previousSession(addDaysIso(day, 1), overrides) ?? bounds.earliest;
}

function signedDisplay(value: Decimal | null): DayReportResponse['figures']['dayChange'] {
  return value === null ? null : { text: signedMoney(value, 'PLN'), direction: directionOf(value) };
}

function figurePart(value: {
  valueAtClosePLN: Decimal | null;
  dayChangePLN: Decimal | null;
  dayChangePct: Decimal | null;
}): NonNullable<DayReportResponse['figures']['holdings']> {
  return {
    valueAtClose: value.valueAtClosePLN ? fmtMoney(value.valueAtClosePLN, 'PLN', 0) : null,
    dayChange: signedDisplay(value.dayChangePLN),
    dayChangePct: value.dayChangePct ? fmtPct(value.dayChangePct) : null,
  };
}

function composeMovers(contributions: DayReportFigures['contributions']): DayReportResponse['movers'] {
  const max = contributions[0]?.contributionPLN.abs();
  return contributions.map((item) => ({
    symbol: item.symbol,
    displayName: item.displayName,
    contribution: signedDisplay(item.contributionPLN) as DayReportResponse['movers'][number]['contribution'],
    pricePct: item.pricePct ? fmtPct(item.pricePct) : null,
    barShare: max && !max.isZero() ? item.contributionPLN.abs().div(max).times(100).toString() : '0',
  }));
}

function composeOptionMovers(
  groups: Array<{ label: string; contributionPLN: Decimal; pricePct: Decimal | null }>,
): DayReportResponse['optionMovers'] {
  const max = groups[0]?.contributionPLN.abs();
  return groups.map((item) => ({
    symbol: item.label,
    displayName: item.label,
    contribution: signedDisplay(item.contributionPLN) as DayReportResponse['movers'][number]['contribution'],
    pricePct: item.pricePct ? fmtPct(item.pricePct) : null,
    barShare: max && !max.isZero() ? item.contributionPLN.abs().div(max).times(100).toString() : '0',
  }));
}

function emptyNarrative(): DayReportResponse['narrative'] {
  return {
    status: 'pending',
    portfolioNarrative: null,
    eventsNarrative: null,
    macroNarrative: null,
    events: [],
    todayLine: null,
    sources: [],
    staleFigures: false,
  };
}

function emptyView(
  day: string,
  kind: DayReportKind,
  scopeId: string | null,
  portfolios: readonly { id: string; name: string }[],
  nearestDay: string | null,
): DayReportResponse {
  return {
    status: 'unavailable',
    nearestDay,
    day,
    dayLabel: dayLabel(day),
    kind,
    prevDay: null,
    nextDay: null,
    isLatest: false,
    segments: { morning: 'none', close: 'not_ready' },
    scopeId,
    scopes: portfolios.map((portfolio) => ({ ...portfolio })),
    figures: {
      status: 'empty', source: null, valueAtClose: null, dayChange: null, dayChangePct: null,
      holdings: null, options: null, optionsDayChangeUSD: null,
      optionsNote: scopeId === null ? null : 'Options are not assigned to portfolios.',
      optionsRelation: null, partial: false, partialSymbols: [], excludedSymbols: [], positionCount: 0,
    },
    recap: null,
    movers: [],
    optionMovers: [],
    valueLine: { kind: 'none', points: [], windowLabel: null, partialDays: 0, excludedSymbols: [] },
    benchmarks: [],
    usdPln: null,
    headlines: [],
    events: { items: [], earningsCaption: EARNINGS_CAPTION },
    narrative: { ...emptyNarrative(), status: 'unavailable' },
  };
}

function dayLabel(dayISO: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${dayISO}T12:00:00Z`));
}

function scopeName(scopeId: string | null, portfolios: readonly { id: string; name: string }[]): string {
  return scopeId === null ? 'All portfolios' : portfolios.find((portfolio) => portfolio.id === scopeId)?.name ?? 'Portfolio';
}
