import type Decimal from 'decimal.js';

import { dec, pctChange, ZERO } from '@/lib/money';
import { aggregateOptionLots } from '@/lib/options/aggregate-lots';
import {
  dayReportOptionLabel,
  type OptionLotContribution,
  type OptionPositionRow,
} from '@/lib/options/options-payload';

import type { DayReportFigures } from './figures';

export interface OptionDayGroup {
  groupKey: string;
  label: string;
  contributionPLN: Decimal;
  valuePLN: Decimal;
  pricePct: Decimal | null;
}

export interface OptionsDayFigures {
  groups: OptionDayGroup[];
  dayChangePLN: Decimal | null;
  dayChangeUSD: Decimal | null;
  dayChangePct: Decimal | null;
  valueAtClosePLN: Decimal | null;
  partial: boolean;
  excludedLabels: string[];
  nearestExpiry: string | null;
}

export function activeOptionLots(
  rows: readonly OptionPositionRow[],
  dayISO: string,
): OptionPositionRow[] {
  return rows.filter((row) => row.tradeDate <= dayISO && row.expirationDate >= dayISO);
}

export function computeOptionsDayFigures(input: {
  lots: readonly OptionPositionRow[];
  valuationsByTickerDate: ReadonlyMap<string, string>;
  prevSession: string;
  dayISO: string;
  fxUsd: string;
}): OptionsDayFigures {
  const active = activeOptionLots(input.lots, input.dayISO);
  const groups: OptionDayGroup[] = [];
  const excludedLabels: string[] = [];
  let value = ZERO;
  let changeUsd = ZERO;
  const fx = dec(input.fxUsd);

  for (const lot of aggregateOptionLots(active)) {
    const currentRaw = input.valuationsByTickerDate.get(`${lot.ticker}|${input.dayISO}`);
    const previousRaw = input.valuationsByTickerDate.get(`${lot.ticker}|${input.prevSession}`);
    const label = dayReportOptionLabel(lot);
    if (currentRaw === undefined || previousRaw === undefined) {
      excludedLabels.push(label);
      continue;
    }
    const current = dec(currentRaw);
    const previous = dec(previousRaw);
    const multiplier = dec(lot.quantity).times(dec(lot.sharesPerContract));
    const valuePLN = current.times(multiplier).times(fx);
    const contributionUSD = current.minus(previous).times(multiplier);
    const contributionPLN = contributionUSD.times(fx);
    value = value.plus(valuePLN);
    changeUsd = changeUsd.plus(contributionUSD);
    groups.push({
      groupKey: lot.key,
      label,
      contributionPLN,
      valuePLN,
      pricePct: pctChange(previous, current),
    });
  }

  groups.sort((a, b) => b.contributionPLN.abs().comparedTo(a.contributionPLN.abs()));
  const covered = groups.length > 0;
  const changePLN = changeUsd.times(fx);
  return {
    groups,
    dayChangePLN: covered ? changePLN : null,
    dayChangeUSD: covered ? changeUsd : null,
    dayChangePct: covered ? pctChange(value.minus(changePLN), value) : null,
    valueAtClosePLN: covered ? value : null,
    partial: excludedLabels.length > 0,
    excludedLabels,
    nearestExpiry: active.map((row) => row.expirationDate).sort()[0] ?? null,
  };
}

export function liveOptionsDayFigures(
  contributions: readonly OptionLotContribution[],
  fxUsd: string,
): OptionsDayFigures {
  const fx = dec(fxUsd);
  const active = contributions.filter((row) => !row.expired);
  const excludedLabels: string[] = [];
  const groups = new Map<string, OptionDayGroup>();
  let valueUsd = ZERO;
  let changeUsd = ZERO;
  let covered = 0;

  for (const row of active) {
    if (row.valueDec === null || row.dayAmtDec === null) {
      excludedLabels.push(row.label);
      continue;
    }
    valueUsd = valueUsd.plus(row.valueDec);
    changeUsd = changeUsd.plus(row.dayAmtDec);
    covered++;
    const existing = groups.get(row.groupKey);
    const contributionPLN = row.dayAmtDec.times(fx);
    const valuePLN = row.valueDec.times(fx);
    if (existing) {
      existing.contributionPLN = existing.contributionPLN.plus(contributionPLN);
      existing.valuePLN = existing.valuePLN.plus(valuePLN);
    } else {
      groups.set(row.groupKey, {
        groupKey: row.groupKey,
        label: row.label,
        contributionPLN,
        valuePLN,
        pricePct:
          row.dayBaseValueDec === null
            ? null
            : pctChange(row.dayBaseValueDec, row.dayBaseValueDec.plus(row.dayAmtDec)),
      });
    }
  }

  const dayChangePLN = changeUsd.times(fx);
  const valuePLN = valueUsd.times(fx);
  return {
    groups: [...groups.values()].sort((a, b) =>
      b.contributionPLN.abs().comparedTo(a.contributionPLN.abs()),
    ),
    dayChangePLN: covered === 0 ? null : dayChangePLN,
    dayChangeUSD: covered === 0 ? null : changeUsd,
    dayChangePct: covered === 0 ? null : pctChange(valuePLN.minus(dayChangePLN), valuePLN),
    valueAtClosePLN: covered === 0 ? null : valuePLN,
    partial: excludedLabels.length > 0,
    excludedLabels,
    nearestExpiry: active.map((row) => row.expirationDate).sort()[0] ?? null,
  };
}

export type OptionsRelation = 'amplified' | 'cushioned' | 'flat' | null;

export function combineDayFigures(
  holdings: DayReportFigures,
  options: OptionsDayFigures | null,
): {
  dayChangePLN: Decimal | null;
  dayChangePct: Decimal | null;
  valueAtClosePLN: Decimal | null;
  partial: boolean;
  optionsRelation: OptionsRelation;
} {
  const holdingChange = holdings.dayChangePLN;
  const optionChange = options?.dayChangePLN ?? null;
  const changes = [holdingChange, optionChange].filter((value): value is Decimal => value !== null);
  const values = [holdings.valueAtClosePLN, options?.valueAtClosePLN ?? null].filter(
    (value): value is Decimal => value !== null,
  );
  const dayChangePLN = changes.length === 0 ? null : changes.reduce((sum, value) => sum.plus(value), ZERO);
  const valueAtClosePLN = values.length === 0 ? null : values.reduce((sum, value) => sum.plus(value), ZERO);
  const dayChangePct =
    dayChangePLN === null || valueAtClosePLN === null
      ? null
      : pctChange(valueAtClosePLN.minus(dayChangePLN), valueAtClosePLN);

  let optionsRelation: OptionsRelation = null;
  if (holdingChange !== null && optionChange !== null) {
    if (optionChange.isZero()) optionsRelation = 'flat';
    else if (holdingChange.isZero()) optionsRelation = 'amplified';
    else optionsRelation = holdingChange.isPositive() === optionChange.isPositive() ? 'amplified' : 'cushioned';
  }
  return {
    dayChangePLN,
    dayChangePct,
    valueAtClosePLN,
    partial:
      holdings.partialSymbols.length > 0 || holdings.excludedSymbols.length > 0 || Boolean(options?.partial),
    optionsRelation,
  };
}
