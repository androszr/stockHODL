import type { OptionContractRef } from '@/lib/market-data/options-types';
import { dec } from '@/lib/money';
import { calendarDaysBetween } from './ny-dates';

/**
 * Pure contract matching for the screenshot-import verification gate —
 * isomorphic, no network. The server-produced contract list is the ground
 * truth; these helpers only decide which of its rows is the parsed contract
 * (exact) or the closest real alternatives (near miss).
 *
 * Money discipline: strikes are compared as Decimal, NEVER by string
 * equality (`370` vs `370.00` are the same strike) and never as floats.
 * The only plain numbers are calendar-day counts.
 */

/** Default bound on the near-miss suggestion list. */
const DEFAULT_ALTERNATIVES_LIMIT = 6;

/** 'YYYY-MM-DD' → epoch ms at UTC NOON — calendar math immune to DST edges.
 *  Date components are counts, not money; parseInt is sanctioned here. */


/**
 * The exact-strike hit within one already-confirmed (underlying, expiry,
 * type) cell — Decimal equality. Null when the strike is a near miss.
 */
export function matchExact(
  contracts: readonly OptionContractRef[],
  strike: string,
): OptionContractRef | null {
  const target = dec(strike);
  for (const contract of contracts) {
    if (dec(contract.strikePrice).equals(target)) return contract;
  }
  return null;
}

/**
 * Nearest real alternatives to a parsed (strike, expiry) pair, closest
 * first: expiry distance in calendar days dominates, strike distance
 * (Decimal `.minus().abs()`) breaks ties within an expiry, and remaining
 * ties order by strike ascending — fully deterministic. Bounded to `limit`.
 */
export function rankAlternatives(
  contracts: readonly OptionContractRef[],
  targetStrike: string,
  targetExpiryISO: string,
  limit: number = DEFAULT_ALTERNATIVES_LIMIT,
): OptionContractRef[] {
  const target = dec(targetStrike);

  const ranked = contracts
    .map((contract) => ({
      contract,
      expiryDelta: calendarDaysBetween(contract.expirationDate, targetExpiryISO),
      strikeDelta: dec(contract.strikePrice).minus(target).abs(),
      strike: dec(contract.strikePrice),
    }))
    .sort((a, b) => {
      if (a.expiryDelta !== b.expiryDelta) return a.expiryDelta - b.expiryDelta;
      const byStrikeDelta = a.strikeDelta.comparedTo(b.strikeDelta);
      if (byStrikeDelta !== 0) return byStrikeDelta;
      return a.strike.comparedTo(b.strike);
    });

  return ranked.slice(0, Math.max(0, limit)).map((r) => r.contract);
}
