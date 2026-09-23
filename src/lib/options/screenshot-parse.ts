import {
  normalizeCurrency,
  normalizeDateToISO,
  normalizeMoneyString,
  normalizeTickerCandidate,
  tickerFromBrokerSymbol,
  trimmedOrNull,
} from '@/lib/screenshots/normalize';
import type { OptionScreenshotExtraction } from '@/lib/validation';

/**
 * The OPTIONS-specific belt over the vision model's output. Everything
 * generic — the upload contract, the magic-byte sniff, the date/money/ticker
 * normalizers — moved to `@/lib/screenshots/*` when the transaction import
 * shipped and is shared by both paths; only this one function, which knows
 * what an option extraction looks like, stayed behind.
 *
 * Isomorphic, no `server-only`: nothing here reads env or the database.
 */

/**
 * Field by field. Null in stays null out — an all-null extraction survives as
 * all-null; nothing here invents a value.
 */
export function normalizeExtraction(
  raw: OptionScreenshotExtraction,
): OptionScreenshotExtraction {
  const primary = raw.underlyingTickerCandidate === null
    ? null
    : normalizeTickerCandidate(raw.underlyingTickerCandidate);
  const secondary = raw.brokerSymbolText === null
    ? null
    : tickerFromBrokerSymbol(raw.brokerSymbolText);

  return {
    underlyingTickerCandidate: primary ?? secondary,
    companyName: raw.companyName === null ? null : trimmedOrNull(raw.companyName),
    contractType: raw.contractType,
    strikePrice: raw.strikePrice === null ? null : normalizeMoneyString(raw.strikePrice),
    expirationDate:
      raw.expirationDate === null ? null : normalizeDateToISO(raw.expirationDate),
    quantity: raw.quantity === null ? null : normalizeMoneyString(raw.quantity),
    entryPrice: raw.entryPrice === null ? null : normalizeMoneyString(raw.entryPrice),
    tradeDate: raw.tradeDate === null ? null : normalizeDateToISO(raw.tradeDate),
    fees: raw.fees === null ? null : normalizeMoneyString(raw.fees),
    feesCurrency: raw.feesCurrency === null ? null : normalizeCurrency(raw.feesCurrency),
    brokerSymbolText:
      raw.brokerSymbolText === null ? null : trimmedOrNull(raw.brokerSymbolText),
  };
}
