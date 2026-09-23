import type Decimal from 'decimal.js';

import type { HoldingQuote } from '@/lib/holdings/live-payload';
import { computePortfolioSummary } from '@/lib/holdings/summary';
import { dec, pctChange, ZERO } from '@/lib/money';
import type { Position } from '@/lib/position-engine';

export interface DayContribution {
  instrumentId: string;
  symbol: string;
  displayName: string;
  contributionPLN: Decimal;
  pricePct: Decimal | null;
  valuePLN: Decimal;
  weightPct: Decimal | null;
}

export interface DayReportFigures {
  contributions: DayContribution[];
  dayChangePLN: Decimal | null;
  dayChangePct: Decimal | null;
  valueAtClosePLN: Decimal | null;
  partialSymbols: string[];
  excludedSymbols: string[];
}

export function computeDayReportFigures(input: {
  positions: readonly Position[];
  closeByInstrument: ReadonlyMap<string, string>;
  prevCloseByInstrument: ReadonlyMap<string, string>;
  fxByCurrency: ReadonlyMap<string, string>;
}): DayReportFigures {
  const contributions: DayContribution[] = [];
  const partialSymbols: string[] = [];
  const excludedSymbols: string[] = [];
  let value = ZERO;
  let change = ZERO;
  let covered = 0;

  for (const position of input.positions) {
    if (!position.quantity.gt(0)) continue;
    if (position.currency !== 'USD' && position.currency !== 'PLN') {
      excludedSymbols.push(position.symbol);
      continue;
    }
    const closeRaw = input.closeByInstrument.get(position.instrumentId);
    const prevRaw = input.prevCloseByInstrument.get(position.instrumentId);
    const fxRaw = position.currency === 'PLN' ? '1' : input.fxByCurrency.get(position.currency);
    if (closeRaw === undefined || fxRaw === undefined) {
      partialSymbols.push(position.symbol);
      continue;
    }
    if (prevRaw === undefined) {
      partialSymbols.push(position.symbol);
      continue;
    }
    const close = dec(closeRaw);
    const previous = dec(prevRaw);
    const fx = dec(fxRaw);
    const valuePLN = position.quantity.times(close).times(fx);
    const contributionPLN = position.quantity.times(close.minus(previous)).times(fx);
    value = value.plus(valuePLN);
    change = change.plus(contributionPLN);
    covered++;
    contributions.push({
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      displayName: position.displayName,
      contributionPLN,
      pricePct: pctChange(previous, close),
      valuePLN,
      weightPct: null,
    });
  }

  contributions.sort((a, b) => b.contributionPLN.abs().comparedTo(a.contributionPLN.abs()));
  for (const contribution of contributions) {
    contribution.weightPct = value.isZero() ? null : contribution.valuePLN.div(value).times(100);
  }
  return {
    contributions,
    dayChangePLN: covered === 0 ? null : change,
    dayChangePct: covered === 0 ? null : pctChange(value.minus(change), value),
    valueAtClosePLN: covered === 0 ? null : value,
    partialSymbols,
    excludedSymbols,
  };
}

export function liveFigures(
  positions: readonly Position[],
  quotes: ReadonlyMap<string, HoldingQuote>,
  fxRates: ReadonlyMap<string, string>,
): DayReportFigures {
  const summary = computePortfolioSummary(positions, quotes, fxRates);
  const contributions: DayContribution[] = [];
  const partialSymbols: string[] = [];
  for (const position of positions) {
    if (!position.quantity.gt(0)) continue;
    const quote = quotes.get(position.symbol);
    const fxRaw = position.currency === 'PLN' ? '1' : fxRates.get(position.currency);
    if (!quote || quote.currency !== position.currency || fxRaw === undefined) continue;
    if (quote.dayChangeAmt === null) {
      partialSymbols.push(position.symbol);
      continue;
    }
    const fx = dec(fxRaw);
    const price = dec(quote.price);
    const amount = dec(quote.dayChangeAmt);
    const valuePLN = position.quantity.times(price).times(fx);
    contributions.push({
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      displayName: position.displayName,
      contributionPLN: position.quantity.times(amount).times(fx),
      pricePct: quote.dayChangePct === null ? null : dec(quote.dayChangePct),
      valuePLN,
      weightPct:
        summary.totalValuePLN === null || summary.totalValuePLN.isZero()
          ? null
          : valuePLN.div(summary.totalValuePLN).times(100),
    });
  }
  contributions.sort((a, b) => b.contributionPLN.abs().comparedTo(a.contributionPLN.abs()));
  return {
    contributions,
    dayChangePLN: summary.dayChangePLN,
    dayChangePct: summary.dayChangePct,
    valueAtClosePLN: summary.totalValuePLN,
    partialSymbols,
    excludedSymbols: summary.excludedSymbols,
  };
}

export function usdPlnMove(
  rates: ReadonlyMap<string, string>,
  dayISO: string,
): { rate: Decimal; pct: Decimal | null } | null {
  const dates = [...rates.keys()].filter((date) => date <= dayISO).sort();
  const raw = rates.get(dayISO);
  if (raw === undefined) return null;
  const rate = dec(raw);
  for (let index = dates.lastIndexOf(dayISO) - 1; index >= 0; index--) {
    const priorRaw = rates.get(dates[index]);
    if (priorRaw !== undefined && !dec(priorRaw).eq(rate)) {
      return { rate, pct: pctChange(dec(priorRaw), rate) };
    }
  }
  return { rate, pct: null };
}
