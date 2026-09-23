import { dec, fmtDecimal } from '@/lib/money';
import type { OptionContractRef, OptionExpiry } from '@/lib/market-data/options-types';
import { utcNoonMs } from '@/lib/options/ny-dates';

/**
 * `label`/`strikeLabel` for the mobile contract-chain endpoints
 * (`optionExpirySchema`, `optionContractRefSchema` in
 * `src/lib/api/contracts/options.ts`).
 *
 * The web wizard (`option-add.tsx`, `option-import.tsx`) formats these
 * client-side from the raw `date`/`strikePrice` fields — it has `Intl` and
 * `decimal.js` in the browser bundle already. The Swift client does not carry
 * an equivalent pl-PL formatter, so the mobile contract asks the server for a
 * pre-formatted label instead. This is the one place that label is produced;
 * every mobile route returning a chain entry maps through here so the three
 * of them cannot drift into three different date/strike formats.
 */

const LOCALE = 'pl-PL';

const EXPIRY_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** `18 gru 2026` from a 'YYYY-MM-DD' — UTC noon, the app's calendar idiom. */
export function mobileExpiryLabel(dateISO: string): string {
  return EXPIRY_FORMAT.format(new Date(utcNoonMs(dateISO)));
}

/** Strike display from the decimal string — no trailing zeros, no parsing. */
export function mobileStrikeLabel(strikePrice: string): string {
  return fmtDecimal(dec(strikePrice), 0, 4);
}

export function toMobileExpiry(expiry: OptionExpiry): { expirationDate: string; label: string } {
  return { expirationDate: expiry.date, label: mobileExpiryLabel(expiry.date) };
}

export function toMobileContractRef(
  contract: OptionContractRef,
): OptionContractRef & { strikeLabel: string } {
  return { ...contract, strikeLabel: mobileStrikeLabel(contract.strikePrice) };
}
