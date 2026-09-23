import Decimal from 'decimal.js';

/**
 * Every money and quantity value in this app flows through here.
 *
 * Postgres `numeric` arrives from Drizzle as a string; it must go straight into
 * Decimal without touching a JS number. `parseFloat`/`Number()` on a price or
 * quantity is a bug, and the ship preflight greps for exactly that.
 */

// 8 decimal places matches numeric(20,8) in the schema; ROUND_HALF_UP is what a
// broker statement does.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;

export function dec(value: string | number | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export const ZERO = new Decimal(0);

/** Serialize back to the string form Postgres numeric expects. */
export function toNumeric(value: Decimal, scale = 8): string {
  return value.toFixed(scale);
}

/**
 * Percentage change from `from` to `to`, as a Decimal percentage (not a ratio).
 * Returns null when `from` is zero — an undefined percentage must not silently
 * render as 0.00%, which would read as "flat" instead of "unknown".
 */
export function pctChange(from: Decimal, to: Decimal): Decimal | null {
  if (from.isZero()) return null;
  return to.minus(from).dividedBy(from).times(100);
}

const LOCALE = 'pl-PL';

/**
 * Polish CLDR sets `minimumGroupingDigits: 2`, so the default `useGrouping:
 * 'auto'` leaves four-digit values ungrouped: "4550,59 zł" next to
 * "45 500,59 zł". On a Holdings screen those sit in one column and the
 * inconsistency reads as a rendering bug, so every formatter here groups
 * unconditionally.
 */
const GROUPING = 'always' as const;

/**
 * `fractionDigits` exists for chart axes, where cents are noise on a scale of
 * hundreds of thousands and the extra glyphs push the currency symbol out of
 * the gutter. Every other caller wants the default: a money figure you might
 * reconcile against a broker statement shows its cents.
 */
export function fmtMoney(value: Decimal, currency: string, fractionDigits: 0 | 2 = 2): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: GROUPING,
  }).format(value.toNumber()); // display only — never fed back into math
}

/**
 * Splits a `fmtMoney` output into the number and its currency token, so a
 * caller can typeset the two differently — a Dashboard tile wants "231,10"
 * loud and "USD" quiet, because on a grid of tiles the repeated currency is
 * the least informative glyph on screen.
 *
 * This is string typesetting, never arithmetic: the amount is passed through
 * verbatim and NEVER parsed back (non-negotiable #1). The split is safe for
 * this app's single locale — pl-PL always puts the currency last, separated
 * from the amount by U+00A0, which is also the group separator; taking the
 * LAST whitespace is therefore exactly the amount/currency boundary. A string
 * with no separator at all (an em dash, an empty figure) comes back whole,
 * with an empty currency, so callers never have to special-case "—".
 */
export function splitMoney(formatted: string): { amount: string; currency: string } {
  // The LAST whitespace run, matched by class rather than by a literal — the
  // separator Intl emits here is U+00A0, and an invisible character sitting in
  // source is exactly the kind of thing that silently rots.
  const at = formatted.search(/\s(?=\S*$)/);
  if (at === -1) return { amount: formatted, currency: '' };
  return { amount: formatted.slice(0, at), currency: formatted.slice(at + 1) };
}

/**
 * Locale-formatted plain number for unitless figures (greeks, ratios) that
 * sit beside pl-PL money strings — same locale, same grouping, so mixed
 * separators never read as a rendering bug. Display only, like every
 * formatter here: the float never feeds back into arithmetic.
 */
export function fmtDecimal(
  value: Decimal,
  minFractionDigits: number,
  maxFractionDigits: number,
): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
    useGrouping: GROUPING,
  }).format(value.toNumber()); // display only — never fed back into math
}

export function fmtQuantity(value: Decimal): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
    useGrouping: GROUPING,
  }).format(value.toNumber());
}

/**
 * Locale-formatted percentage. Goes through Intl for the same reason fmtMoney
 * does: on a Holdings card the percent sits directly beside a pl-PL money
 * string, and `toFixed` would print "+20,46 zł (+51150.00%)" — comma and period
 * as decimal separators on one line, which reads as a rendering bug.
 *
 * `signDisplay: 'exceptZero'` reproduces the previous contract exactly: '+' on
 * positives, '-' on negatives, bare on zero. Null stays "—" (see pctChange).
 */
export function fmtPct(value: Decimal | null): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
    useGrouping: GROUPING,
  }).format(value.toNumber())}%`; // display only — never fed back into math
}

/**
 * Locale-formatted percentage DISTANCE — same Intl config as `fmtPct`, but
 * `signDisplay: 'never'`: a distance to a target line has no sign, and the
 * `+3,21%` `fmtPct` would print reads as a day move on a tile. Null stays "—"
 * (see pctChange).
 */
export function fmtPctUnsigned(value: Decimal | null): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'never',
    useGrouping: GROUPING,
  }).format(value.toNumber())}%`; // display only — never fed back into math
}

/**
 * Compact market-cap figure in the trading currency, no currency token
 * (the panel row label carries that, Yahoo-style). Thresholds and division
 * stay on Decimal; Intl is display-only, like every formatter here.
 *
 * ≥10¹² → T, ≥10⁹ → B, ≥10⁶ → M, below that a grouped integer. Two decimals
 * under 100 of the scaled unit, one at 100+.
 */
export function fmtMarketCap(value: Decimal): string {
  const million = dec('1e6');
  const billion = dec('1e9');
  const trillion = dec('1e12');
  const thousand = dec('1000');

  if (value.lt(million)) {
    return new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
      useGrouping: GROUPING,
    }).format(value.toNumber()); // display only — never fed back into math
  }

  let divisor = value.gte(trillion) ? trillion : value.gte(billion) ? billion : million;
  let suffix = divisor.eq(trillion) ? 'T' : divisor.eq(billion) ? 'B' : 'M';

  // Round on Decimal first. Intl rounding 999,95B would print "1 000,0B"
  // instead of bumping to "1,00T"; same cliff at M and at T.
  for (;;) {
    const scaled = value.dividedBy(divisor);
    const fractionDigits = scaled.abs().gte(100) ? 1 : 2;
    const rounded = scaled.toDecimalPlaces(fractionDigits);
    if (rounded.abs().gte(thousand) && suffix !== 'T') {
      if (suffix === 'M') {
        suffix = 'B';
        divisor = billion;
      } else {
        suffix = 'T';
        divisor = trillion;
      }
      continue;
    }
    return `${new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      useGrouping: GROUPING,
    }).format(rounded.toNumber())}${suffix}`; // display only — never fed back into math
  }
}

/** Direction of a change, for token selection. Never infer color from a number. */
export type Direction = 'gain' | 'loss' | 'neutral';

export function directionOf(value: Decimal | null): Direction {
  if (value === null || value.isZero()) return 'neutral';
  return value.isPositive() ? 'gain' : 'loss';
}
