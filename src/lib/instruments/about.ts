import { addDaysIso } from '@/lib/dates';
import { dec, fmtMarketCap, fmtMoney } from '@/lib/money';

/**
 * Pure composition of the instrument About panel. No db, no network — the
 * same split as the mappings: the loader fetches, this file decides what
 * the phone is allowed to see.
 *
 * Market cap is shares × headline price through Decimal, formatted compact
 * in the instrument's trading currency. A currency-mismatched quote dashes
 * the cap and the 52-week marker rather than presenting USD as something
 * else. Employees are a COUNT (the volume precedent) and never pass
 * through `dec()`.
 */

/** One day's extremes as the 52-week fold reads them. */
export interface AboutBar {
  close: string;
  high: string | null;
  low: string | null;
}

export interface AboutProfile {
  description: string | null;
  totalEmployees: number | null;
  homepageUrl: string | null;
  sharesOutstanding: string | null;
}

export interface AboutQuote {
  price: string;
  currency: string;
}

export interface Week52Range {
  low: string;
  high: string;
  lowRaw: string;
  highRaw: string;
  currentRaw: string | null;
}

export interface AboutFigures {
  description: string | null;
  marketCap: string | null;
  employees: string | null;
  website: string | null;
  week52: Week52Range | null;
}

/** Inclusive 52-week window: `to` and 364 calendar days before it. */
export function week52Window(todayISO: string): { from: string; to: string } {
  return { from: addDaysIso(todayISO, -364), to: todayISO };
}

const EMPLOYEE_FORMAT = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });

export function composeAbout(
  profile: AboutProfile,
  quote: AboutQuote | undefined,
  currency: string,
  bars: Map<string, AboutBar>,
): AboutFigures {
  const usable = quote && quote.currency === currency ? quote : undefined;

  let marketCap: string | null = null;
  if (usable && profile.sharesOutstanding !== null) {
    marketCap = fmtMarketCap(dec(profile.sharesOutstanding).times(dec(usable.price)));
  }

  return {
    description: profile.description,
    marketCap,
    employees:
      profile.totalEmployees === null ? null : EMPLOYEE_FORMAT.format(profile.totalEmployees),
    website: profile.homepageUrl,
    week52: foldWeek52(bars, currency, usable?.price ?? null),
  };
}

function foldWeek52(
  bars: Map<string, AboutBar>,
  currency: string,
  currentRaw: string | null,
): Week52Range | null {
  if (bars.size === 0) return null;

  let low: ReturnType<typeof dec> | null = null;
  let high: ReturnType<typeof dec> | null = null;
  for (const bar of bars.values()) {
    const dayLow = dec(bar.low ?? bar.close);
    const dayHigh = dec(bar.high ?? bar.close);
    if (low === null || dayLow.lt(low)) low = dayLow;
    if (high === null || dayHigh.gt(high)) high = dayHigh;
  }
  if (low === null || high === null) return null;

  return {
    low: fmtMoney(low, currency),
    high: fmtMoney(high, currency),
    lowRaw: low.toString(),
    highRaw: high.toString(),
    currentRaw,
  };
}
