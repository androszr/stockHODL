import type { DayReportResponse } from '@/lib/api/contracts/day-report';
import { addDaysIso } from '@/lib/dates';

import type { DayReportHeld } from './view';

export interface DayReportFacts {
  kind: DayReportResponse['kind'];
  day: string;
  /** "Monday" — so the writer can say "Wednesday's Fed minutes" without arithmetic. */
  weekday: string;
  /** The report day's Monday..Friday, the window the writer's calendar covers. */
  week: { from: string; to: string };
  scope: string;
  /**
   * Every held name and every open option position — the writer searches
   * earnings dates for these and places expiries from them. The movers list
   * below is only the top five by contribution.
   */
  heldSymbols: DayReportHeld['symbols'];
  optionPositions: DayReportHeld['options'];
  headline: {
    valueAtClose: string | null;
    dayChange: string | null;
    dayChangePct: string | null;
    holdings: string | null;
    options: string | null;
    optionsRelation: string | null;
    partial: boolean;
    exclusions: string[];
  };
  recap: DayReportResponse['recap'];
  movers: Array<{
    symbol: string;
    name: string;
    contribution: string;
    priceMove: string | null;
  }>;
  benchmarks: Array<{ name: string; day: string | null; extended: string | null }>;
  usdPln: { rate: string; move: string } | null;
  /**
   * Source material, never copy: the writer reads these pages (web_fetch)
   * and folds what matters into the prose. `url` is what web_fetch is
   * allowed to open — the tool only fetches URLs already in the prompt.
   */
  headlines: Array<{
    title: string;
    publisher: string | null;
    publishedAt: string;
    tickers: string[];
    sentiment: string | null;
    url: string;
    summary: string | null;
  }>;
  /**
   * Only what the market feed knows for certain (option expiries this
   * week, an ex-dividend on the day). Never a caption about where the rest
   * comes from — the writer paraphrased one straight into the report.
   */
  events: DayReportResponse['events']['items'];
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

/** Monday..Friday of the ISO week containing `dayISO` (calendar days, not sessions). */
export function tradingWeekOf(dayISO: string): { from: string; to: string } {
  const [y, m, d] = dayISO.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  const from = addDaysIso(dayISO, offsetToMonday);
  return { from, to: addDaysIso(from, 4) };
}

export function weekdayOf(dayISO: string): string {
  const [y, m, d] = dayISO.split('-').map(Number);
  return WEEKDAY.format(new Date(Date.UTC(y, m - 1, d)));
}

export function dayReportFacts(
  view: DayReportResponse,
  scopeName = 'All portfolios',
  held: DayReportHeld = { symbols: [], options: [] },
): DayReportFacts {
  const part = (value: DayReportResponse['figures']['holdings']): string | null =>
    value?.dayChange?.text ?? null;
  return {
    kind: view.kind,
    day: view.day,
    weekday: weekdayOf(view.day),
    week: tradingWeekOf(view.day),
    scope: scopeName,
    heldSymbols: held.symbols,
    optionPositions: held.options,
    headline: {
      valueAtClose: view.figures.valueAtClose,
      dayChange: view.figures.dayChange?.text ?? null,
      dayChangePct: view.figures.dayChangePct,
      holdings: part(view.figures.holdings),
      options: part(view.figures.options),
      optionsRelation: view.figures.optionsRelation,
      partial: view.figures.partial,
      exclusions: [...view.figures.partialSymbols, ...view.figures.excludedSymbols],
    },
    recap: view.recap,
    movers: view.movers.slice(0, 5).map((mover) => ({
      symbol: mover.symbol,
      name: mover.displayName,
      contribution: mover.contribution.text,
      priceMove: mover.pricePct,
    })),
    benchmarks: view.benchmarks.map((benchmark) => ({
      name: benchmark.indexName,
      day: benchmark.dayPct,
      extended: benchmark.extendedPct,
    })),
    usdPln: view.usdPln ? { rate: view.usdPln.rate, move: view.usdPln.move } : null,
    headlines: view.headlines.slice(0, 12).map((headline) => ({
      title: headline.title,
      publisher: headline.publisherName,
      publishedAt: new Date(headline.publishedAtMs).toISOString(),
      tickers: headline.matchedTickers,
      sentiment: headline.sentiment,
      url: headline.url,
      summary: headline.summary,
    })),
    events: view.events.items,
  };
}
