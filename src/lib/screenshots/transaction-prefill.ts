import type Decimal from 'decimal.js';

import { dec } from '@/lib/money';
import type { TransactionScreenshotExtraction } from '@/lib/validation';

import {
  normalizeCurrency,
  normalizeDateToISO,
  normalizeMoneyString,
  normalizeTickerCandidate,
  tickerFromBrokerSymbol,
  trimmedOrNull,
} from './normalize';

/**
 * The whole decision layer of the transaction screenshot import: pure,
 * isomorphic, no network, no DOM, no persistence. Every number goes through
 * `dec()` from `@/lib/money`; no value in this file is ever parsed as a
 * float, deliberately, because the one arithmetic step that matters here
 * (a złoty commission divided by the printed conversion rate) lands straight
 * in a `numeric(20,8)` column.
 *
 * What this file will NEVER do:
 *  - resolve an instrument. `symbolQuery` is a string typed into a search box
 *    for the user to act on; symbol, name, exchange and currency still come
 *    only from a `SymbolSearch` pick or manual entry. A picture can no more
 *    mint an instrument than a URL can.
 *  - use the screen's `brokerFxRate` as the transaction's stored FX rate. It
 *    reaches exactly two places, both in this file — `convertFee`, to turn a
 *    złoty commission into the currency the share trades in, and
 *    `priceCurrencyCheck`, as a number to compare against — and it is never
 *    returned in the prefill. `fxRateToBase` still comes only from the
 *    official NBP D-1 lookup in `getFxRate`.
 *  - invent a value. Null in stays null out, and a conversion it cannot do
 *    honestly is reported as impossible rather than approximated.
 */

/** ISIN: two country letters, nine alphanumerics, one check digit. */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/**
 * The PRICE-ONLY widening of `normalizeMoneyString`: a lone comma is read as
 * the decimal point even when three digits follow it, so mBank's `601,505`
 * becomes `601.505` instead of failing as thousands grouping.
 *
 * It lives here, not in `./normalize`, because the evidence for it is local to
 * this screen: mBank groups thousands with a space (`26 354,58`), which is
 * stripped before the comma is looked at, and the screen's own printed
 * arithmetic proves the reading (`26 354,58 ÷ (12 × 601,505) = 3,6512`). The
 * options import has no such evidence, so it keeps the conservative rule and
 * keeps failing loudly on `5,800` rather than quietly turning a 5 800-lot into
 * a 5.8-lot. Do not move this into the shared module.
 *
 * It is applied to EXACTLY TWO fields — `pricePerShare` and `brokerFxRate` —
 * because those are the only ones on either reference screen quoted to
 * sub-cent precision. It must NEVER touch `quantity`, `fees` or `totalValue`:
 * `1,500` shares means one thousand five hundred, and turning it into `1.5`
 * would store a share count a thousand times too small, silently, past the
 * `AMBIGUOUS_GROUPING` guard in `@/lib/validation` that exists to refuse
 * precisely that shape. Those three fields stay on `normalizeMoneyString`, so
 * a comma-grouped figure survives as `1,500` and fails loudly at submit.
 *
 * A value with both separators, or several commas, is still left alone and
 * fails `decimalString` downstream rather than being guessed at.
 */
export function normalizeScreenMoney(value: string): string | null {
  const stripped = value.trim().replace(/\s/g, '');
  if (stripped.length === 0) return null;
  if (
    stripped.includes(',') &&
    !stripped.includes('.') &&
    stripped.indexOf(',') === stripped.lastIndexOf(',')
  ) {
    return normalizeMoneyString(stripped.replace(',', '.'));
  }
  return normalizeMoneyString(stripped);
}

/** How far the currency cross-check may drift before it stops being a match. */
const CONSISTENT_TOLERANCE = dec('0.01');
const RATE_TOLERANCE_FRACTION = dec('0.01');

/* -------------------------------------------------------------------------
 * 1. The belt over the model's own output.
 * ---------------------------------------------------------------------- */

/**
 * Field by field, using the shared screenshot normalizers. Anything that does
 * not fit becomes null — an empty field the user fills in, never a fabricated
 * zero and never a half-parsed number.
 */
export function normalizeTransactionExtraction(
  raw: TransactionScreenshotExtraction,
): TransactionScreenshotExtraction {
  const isin =
    raw.isinCandidate === null
      ? null
      : isinOrNull(raw.isinCandidate);

  const primaryTicker =
    raw.tickerCandidate === null ? null : normalizeTickerCandidate(raw.tickerCandidate);

  // The broker-symbol fallback only applies to text that is actually SYMBOL
  // shaped (`GOOGL:xnas`, `SNOW/15F27C240:xcbf`). mBank's header reads
  // "NASDAQ USD - US30303M1027", whose leading word is an exchange — taking
  // it would hand the user "NASDAQ" as a ticker, which is exactly the class
  // of confident wrong answer this feature must not produce.
  const fallbackTicker =
    raw.brokerSymbolText !== null && /[/:]/.test(raw.brokerSymbolText)
      ? tickerFromBrokerSymbol(raw.brokerSymbolText)
      : null;

  const ticker = primaryTicker ?? fallbackTicker;

  return {
    // A candidate that is really the ISIN is not a ticker.
    tickerCandidate: ticker !== null && ISIN_RE.test(ticker) ? null : ticker,
    companyName: raw.companyName === null ? null : trimmedOrNull(raw.companyName),
    isinCandidate: isin,
    exchange: raw.exchange === null ? null : trimmedOrNull(raw.exchange),
    side: raw.side,
    sideEvidence: raw.sideEvidence === null ? null : trimmedOrNull(raw.sideEvidence),
    // Conservative on purpose: a share count is never quoted to three
    // decimals, so `1,500` here is one thousand five hundred and must fail
    // loudly rather than become `1.5`.
    quantity: raw.quantity === null ? null : normalizeMoneyString(raw.quantity),
    pricePerShare:
      raw.pricePerShare === null ? null : normalizeScreenMoney(raw.pricePerShare),
    priceCurrency: raw.priceCurrency === null ? null : normalizeCurrency(raw.priceCurrency),
    settlementCurrency:
      raw.settlementCurrency === null ? null : normalizeCurrency(raw.settlementCurrency),
    totalValue: raw.totalValue === null ? null : normalizeMoneyString(raw.totalValue),
    totalValueCurrency:
      raw.totalValueCurrency === null ? null : normalizeCurrency(raw.totalValueCurrency),
    fees: raw.fees === null ? null : normalizeMoneyString(raw.fees),
    feesCurrency: raw.feesCurrency === null ? null : normalizeCurrency(raw.feesCurrency),
    brokerFxRate: raw.brokerFxRate === null ? null : normalizeScreenMoney(raw.brokerFxRate),
    tradeDate: raw.tradeDate === null ? null : normalizeDateToISO(raw.tradeDate),
    settlementDate:
      raw.settlementDate === null ? null : normalizeDateToISO(raw.settlementDate),
    screenKind: raw.screenKind,
    brokerSymbolText:
      raw.brokerSymbolText === null ? null : trimmedOrNull(raw.brokerSymbolText),
  };
}

function isinOrNull(value: string): string | null {
  const upper = value.trim().toUpperCase().replace(/\s/g, '');
  return ISIN_RE.test(upper) ? upper : null;
}

/* -------------------------------------------------------------------------
 * 2. Buy or sell — and who decided.
 * ---------------------------------------------------------------------- */

export type SideSource = 'stated' | 'assumed' | 'unknown';

export interface SideDecision {
  side: 'buy' | 'sell' | null;
  source: SideSource;
}

/**
 * `stated` — the screen said so, in words (`kupno`).
 * `assumed` — a POSITION screen showing a positive quantity: you are long, and
 * getting long is a purchase. That inference is made HERE, by this app, in
 * code you can read, and it is disclosed in the note above the form — it is
 * never something the model was allowed to guess.
 * `unknown` — nobody knows, so both radios stay unchecked and the form's own
 * `side` validation is what stops a silent Buy.
 */
export function resolveSide(extraction: TransactionScreenshotExtraction): SideDecision {
  if (extraction.side !== null) return { side: extraction.side, source: 'stated' };

  if (extraction.screenKind === 'position' && extraction.quantity !== null) {
    const quantity = decOrNull(extraction.quantity);
    if (quantity !== null && quantity.greaterThan(0)) {
      return { side: 'buy', source: 'assumed' };
    }
  }

  return { side: null, source: 'unknown' };
}

/* -------------------------------------------------------------------------
 * 3. Which currency is the price really in?
 * ---------------------------------------------------------------------- */

export type PriceCurrencyCheck = 'consistent' | 'converted' | 'inconsistent' | 'unknown';

/**
 * mBank prints `waluta: PLN` beside a price of `601,505` that is in DOLLARS,
 * and a `wartość` of `26 354,58 PLN`. Reading the account currency as the
 * instrument currency would store złoty in a dollar column — silent cost-basis
 * corruption. So the screen is asked to prove itself:
 *
 *   r = |totalValue| ÷ (quantity × pricePerShare)
 *
 * `r ≈ 1` means the total and the price share a currency (`consistent` — the
 * Saxo shape, where Market Value is negative because a purchase costs cash;
 * the sign is a cash-flow convention, not a currency fact, hence the absolute
 * value). `r ≈ brokerFxRate` means the total is in the settlement currency
 * while the price is in the instrument's (`converted` — the mBank shape:
 * 26 354,58 ÷ (12 × 601,505) = 3,6512). Anything else is `inconsistent` and
 * the user is told to check the price. A missing or zero input is `unknown`,
 * never a division by zero. All Decimal, never float comparison.
 */
export function priceCurrencyCheck(input: {
  quantity: string | null;
  pricePerShare: string | null;
  totalValue: string | null;
  brokerFxRate: string | null;
}): PriceCurrencyCheck {
  const quantity = decOrNull(input.quantity);
  const price = decOrNull(input.pricePerShare);
  const total = decOrNull(input.totalValue);
  if (quantity === null || price === null || total === null) return 'unknown';

  const gross = quantity.times(price);
  if (gross.isZero()) return 'unknown';

  const ratio = total.abs().dividedBy(gross.abs());
  if (ratio.minus(1).abs().lessThanOrEqualTo(CONSISTENT_TOLERANCE)) return 'consistent';

  const rate = decOrNull(input.brokerFxRate);
  if (rate !== null && !rate.isZero()) {
    if (ratio.minus(rate).abs().lessThanOrEqualTo(rate.abs().times(RATE_TOLERANCE_FRACTION))) {
      return 'converted';
    }
  }

  return 'inconsistent';
}

/**
 * The price currency the screen did not print, recovered from the one it did.
 *
 * A Saxo "Position Details" header is just `CRWD:xnas` — no currency anywhere
 * near the `8 @ 305,15` row — so `priceCurrency` is regularly the one field
 * that fails to read. But `consistent` MEANS `totalValue ≈ quantity × price`,
 * and two figures that multiply out to each other are in the same currency by
 * definition. So a labelled total (`Market Value -2 441,20 USD`) is a proof
 * of the price's currency, not a guess about it — the same cross-multiplying
 * evidence `priceCurrencyCheck` already trusts to DISPROVE a currency, read
 * in the other direction.
 *
 * Deliberately narrow:
 *  - only when nothing was read. A currency the model DID print is never
 *    overridden — it has its own disproof path, and this is a fallback, not
 *    a second opinion.
 *  - only on `consistent`. On `converted` the total is in the SETTLEMENT
 *    currency and the price is in a different one, so the total says nothing
 *    about the price; on `inconsistent`/`unknown` the arithmetic proves
 *    nothing at all. Those all stay null, and the fee still fails closed.
 *
 * Without this the commission is the casualty: `convertFee` refuses a fee
 * whose target currency is unknown, so a legible `Commission 1,85 USD` landed
 * in the form as `0` even though the same screen proved the trade was in
 * dollars twice over.
 */
export function inferPriceCurrency(
  extraction: Pick<TransactionScreenshotExtraction, 'priceCurrency' | 'totalValueCurrency'>,
  check: PriceCurrencyCheck,
): string | null {
  if (extraction.priceCurrency !== null) return null;
  if (check !== 'consistent') return null;
  return extraction.totalValueCurrency;
}

/* -------------------------------------------------------------------------
 * 4. The commission, in the currency the share trades in.
 * ---------------------------------------------------------------------- */

export interface FeeConversion {
  /** Dot-decimal, two places — what goes into the Fees field. */
  amount: string;
  /** The arithmetic to show the user, or null when nothing was converted. */
  shown: {
    from: string;
    fromCurrency: string;
    rate: string;
    to: string;
    toCurrency: string;
  } | null;
}

/**
 * `fees` is stored in the instrument's trading currency (the form's label
 * reads `Fees ({currency})`), but mBank charges commission in złoty. The
 * screen prints its own conversion rate, so the arithmetic is done here and
 * SHOWN: 59,91 ÷ 3,6512 = 16,41.
 *
 * `plnPerUnit` is the broker's printed rate, PLN per one foreign unit, and it
 * is used for THIS and nothing else — the transaction's stored `fxRateToBase`
 * still comes only from the official NBP D-1 lookup.
 *
 * Returns null when the conversion cannot be done honestly: no rate, a pair
 * with no PLN leg, or a pair only one half of which is known. The caller then
 * prefills `'0'` with a visible warning (the options-import precedent),
 * because a wrong number in a money field is worse than an empty one, and an
 * invented rate is worse than both.
 */
export function convertFee(input: {
  fee: string | null;
  feeCurrency: string | null;
  targetCurrency: string | null;
  plnPerUnit: string | null;
}): FeeConversion | null {
  const fee = decOrNull(input.fee);
  if (fee === null) return null;

  // Zero costs nothing in every currency there is.
  if (fee.isZero()) return { amount: '0', shown: null };

  // Pass the figure through at face value ONLY when it is provably already in
  // the right unit: the two currencies are equal, or NOTHING is known about
  // either of them (a bare number with no currency anywhere on the screen —
  // there is nothing to convert and nothing to warn about).
  const bothUnknown = input.feeCurrency === null && input.targetCurrency === null;
  const sameCurrency =
    input.feeCurrency !== null && input.feeCurrency === input.targetCurrency;
  if (bothUnknown || sameCurrency) {
    // Nothing was converted, so nothing is rounded either: the figure is
    // passed through exactly as the screen printed it.
    return { amount: fee.toString(), shown: null };
  }

  // Exactly ONE side is known. That is the dangerous shape: `59,91 PLN` with
  // an unread trading currency looks identical, at this point, to a figure
  // already in the trading currency — and once the user picks the stock the
  // field's label will claim it is that currency. Refuse; the caller turns
  // this into `'0'` plus a visible warning. Failing closed is always right
  // here, because nothing downstream ever verifies a fee.
  if (input.feeCurrency === null || input.targetCurrency === null) return null;

  const rate = decOrNull(input.plnPerUnit);
  if (rate === null || !rate.greaterThan(0)) return null;

  let converted: Decimal;
  if (input.feeCurrency === 'PLN') {
    converted = fee.dividedBy(rate);
  } else if (input.targetCurrency === 'PLN') {
    converted = fee.times(rate);
  } else {
    // Neither side is złoty, so the printed PLN rate says nothing about this
    // pair. Refuse rather than chain two guesses together.
    return null;
  }

  const amount = round2(converted);
  return {
    amount,
    shown: {
      from: round2(fee),
      fromCurrency: input.feeCurrency,
      rate: rate.toString(),
      to: amount,
      toCurrency: input.targetCurrency,
    },
  };
}

/** Broker statements round commission to the cent; `numeric(20,8)` swallows
 *  that with room to spare. */
function round2(value: Decimal): string {
  // The rounding mode is ROUND_HALF_UP — set once, globally, by `@/lib/money`
  // (which this module imports), exactly as a broker statement rounds.
  return value.toDecimalPlaces(2).toString();
}

/* -------------------------------------------------------------------------
 * 5. Composition — what the form and the note consume.
 * ---------------------------------------------------------------------- */

/** Exactly the fields the Add-transaction form will accept from a picture.
 *  Note what is NOT here: symbol, displayName, exchange, currency. */
export interface TransactionFormPrefill {
  quantity: string | null;
  price: string | null;
  fees: string | null;
  tradeDate: string | null;
  side: 'buy' | 'sell' | null;
  /** Typed into the symbol search box for the user to act on. Never a pick. */
  symbolQuery: string | null;
}

export type PrefillNote =
  | { kind: 'position'; quantity: string | null; pricePerShare: string | null }
  | { kind: 'side-assumed' }
  | { kind: 'side-unknown' }
  | { kind: 'fee-converted'; shown: NonNullable<FeeConversion['shown']> }
  /**
   * `no-rate` — the screen shows a cost in another currency and no rate that
   * could convert it. `unknown-target` — a rate WAS printed and is exactly
   * what disproved the currency the screen claimed for the price, so there is
   * no currency to convert INTO. The two reasons must not share a sentence:
   * telling the user "no rate" while a rate is printed in front of them is a
   * confidently false explanation.
   */
  | { kind: 'fee-unconverted'; feeCurrency: string | null; reason: 'no-rate' | 'unknown-target' }
  /**
   * The screen never labelled the price, and this app worked the currency out
   * from the total (see `inferPriceCurrency`). Disclosed like every other
   * inference in this file: it decides which currency the commission is
   * treated as, so the user has to be able to see it and disagree.
   */
  | { kind: 'price-currency-inferred'; currency: string }
  /** The screen's own arithmetic contradicts the currency it printed for the
   *  price — a currency problem. */
  | { kind: 'currency-mismatch'; screenCurrency: string | null }
  /**
   * `totalValue ≠ quantity × price`, and not by the printed FX rate either.
   * That is an ARITHMETIC disagreement, not a currency one: a Market Value
   * read at today's price, a partial fill, a fee-inclusive total. Saying
   * "currency" here would be a confident wrong diagnosis, and it would render
   * before any stock is picked — when "the currency this stock trades in"
   * names nothing at all.
   */
  | { kind: 'total-mismatch' };

export interface TransactionPrefill {
  form: TransactionFormPrefill;
  /** Field labels that were READ off the picture, for the honesty list. */
  readFields: string[];
  notes: PrefillNote[];
  companyName: string | null;
  isin: string | null;
  screenKind: 'transaction' | 'position' | null;
  /** The currency the PRICE is in: as the screen printed it, or — when it
   *  printed none — as `inferPriceCurrency` proved it from the total. Display
   *  and the live comparison in `currencyMismatch` only, never a form value. */
  priceCurrency: string | null;
  /**
   * False when the screen's own arithmetic CONTRADICTS `priceCurrency` (see
   * the `converted` case below). A disproven currency has already raised its
   * own warning here and must not be compared against the picked instrument
   * afterwards, because it is not evidence of anything.
   */
  priceCurrencyTrusted: boolean;
}

/**
 * Composes the four decisions above into the shape the UI consumes. An
 * all-null extraction produces an all-null prefill with no notes and no
 * throw — the honest answer to a picture nothing could be read from.
 *
 * It takes NO instrument currency: at the moment a picture is read no stock
 * has been picked yet (the import is normally the first action on a blank
 * form), so a comparison made here could only ever be against `null`. The
 * comparison against the instrument the user actually picks belongs to the
 * live form and is done by `currencyMismatch` below.
 */
export function buildTransactionPrefill(
  extraction: TransactionScreenshotExtraction,
): TransactionPrefill {
  const side = resolveSide(extraction);
  const check = priceCurrencyCheck({
    quantity: extraction.quantity,
    pricePerShare: extraction.pricePerShare,
    totalValue: extraction.totalValue,
    brokerFxRate: extraction.brokerFxRate,
  });

  // (B) The disproof of `priceCurrency`, USED rather than computed and
  // discarded. `converted` means the total is in the settlement currency and
  // the price is in a DIFFERENT one — so a `priceCurrency` equal to the
  // total's or to the settlement currency contradicts the arithmetic printed
  // on the same screen. The likeliest cause is the model reading mBank's
  // `waluta: PLN` as the trading currency, which is the exact failure this
  // feature was built to survive. Treat the field as unproven: it may not be
  // used as the fee's target currency, and it earns a warning.
  const priceCurrencyDisproven =
    check === 'converted' &&
    extraction.priceCurrency !== null &&
    (extraction.priceCurrency === extraction.totalValueCurrency ||
      extraction.priceCurrency === extraction.settlementCurrency);

  // (C) The recovery of a price currency the screen never labelled — null
  // unless the screen's own arithmetic proves it (see `inferPriceCurrency`).
  // It can never collide with the disproof above: that one needs `converted`,
  // this one only fires on `consistent`.
  const inferredPriceCurrency = inferPriceCurrency(extraction, check);
  const priceCurrency = extraction.priceCurrency ?? inferredPriceCurrency;

  const fee = convertFee({
    fee: extraction.fees,
    feeCurrency: extraction.feesCurrency,
    // Unproven ⇒ null ⇒ `convertFee` refuses, and the fee falls to `'0'` plus
    // a visible warning rather than a złoty figure sitting in a dollar field.
    targetCurrency: priceCurrencyDisproven ? null : priceCurrency,
    plnPerUnit: extraction.brokerFxRate,
  });

  const notes: PrefillNote[] = [];
  const readFields: string[] = [];
  if (extraction.quantity !== null) readFields.push('quantity');
  if (extraction.pricePerShare !== null) readFields.push('price');
  if (extraction.tradeDate !== null) readFields.push('trade date');
  if (extraction.fees !== null) readFields.push('commission');

  // (E) The position warning is the ENTIRE mitigation for a screen that
  // collapses several fills into one line, so it renders whenever the screen
  // is a position screen — including when every other field failed to read.
  if (extraction.screenKind === 'position') {
    notes.push({
      kind: 'position',
      quantity: extraction.quantity,
      pricePerShare: extraction.pricePerShare,
    });
  }
  if (side.source === 'assumed') notes.push({ kind: 'side-assumed' });
  if (side.source === 'unknown') notes.push({ kind: 'side-unknown' });

  // Before the fee sentence, because it is the reason the fee sentence reads
  // the way it does.
  if (inferredPriceCurrency !== null) {
    notes.push({ kind: 'price-currency-inferred', currency: inferredPriceCurrency });
  }

  let fees: string | null;
  if (extraction.fees === null) {
    fees = null;
  } else if (fee === null) {
    // The options precedent: a cost in a currency we cannot convert becomes a
    // visible 0, never a złoty figure sitting in a dollar field.
    fees = '0';
    notes.push({
      kind: 'fee-unconverted',
      feeCurrency: extraction.feesCurrency,
      // A rate was read and used to disprove the price currency, so "no rate"
      // would be false on the screen the user is looking at.
      reason: priceCurrencyDisproven ? 'unknown-target' : 'no-rate',
    });
  } else {
    fees = fee.amount;
    if (fee.shown !== null) notes.push({ kind: 'fee-converted', shown: fee.shown });
  }

  // Two different faults, two different sentences.
  if (priceCurrencyDisproven) {
    notes.push({ kind: 'currency-mismatch', screenCurrency: extraction.priceCurrency });
  } else if (check === 'inconsistent') {
    notes.push({ kind: 'total-mismatch' });
  }

  return {
    form: {
      quantity: extraction.quantity,
      price: extraction.pricePerShare,
      fees,
      tradeDate: extraction.tradeDate,
      side: side.side,
      // Ticker first (it hits the exact-symbol bucket in the ranker), else the
      // company name as printed (`META PLATFOR` substring-matches
      // `Meta Platforms, Inc.`). The ISIN is deliberately never used: there is
      // no ISIN→ticker source in this app, so searching for one returns
      // nothing and would only look broken.
      symbolQuery: extraction.tickerCandidate ?? extraction.companyName,
    },
    readFields,
    notes,
    companyName: extraction.companyName,
    isin: extraction.isinCandidate,
    screenKind: extraction.screenKind,
    // Read, or — when the screen printed none — proved by its own arithmetic.
    // An inferred currency is trusted BECAUSE the proof is the same
    // cross-multiplication that disproves a misread one, so it takes part in
    // the live `currencyMismatch` comparison exactly like a printed one.
    priceCurrency,
    priceCurrencyTrusted: !priceCurrencyDisproven,
  };
}

/**
 * Does the screen's price currency contradict the stock the user actually
 * PICKED? Answered live, against the form's current currency, because that
 * currency does not exist yet when the picture is read — the import is
 * normally the first action on a blank form, so a comparison made at build
 * time is a comparison against nothing, and the warning would never fire.
 *
 * `instrumentCurrency` is null until an instrument is picked or typed in;
 * null means "no claim yet", never a mismatch. A `priceCurrency` the screen's
 * own arithmetic already disproved is not compared at all — it has its own
 * warning and is not evidence about the instrument.
 */
export function currencyMismatch(
  prefill: TransactionPrefill,
  instrumentCurrency: string | null,
): boolean {
  return (
    prefill.priceCurrencyTrusted &&
    prefill.priceCurrency !== null &&
    instrumentCurrency !== null &&
    prefill.priceCurrency !== instrumentCurrency
  );
}

/**
 * Did the picture land on a stock that was ALREADY chosen — a `?symbol=` deep
 * link from `/holdings/GOOGL`, say — and has the user not touched it since?
 * Returns that symbol, so the note can name both it and the company the screen
 * names; null when there is nothing to raise.
 *
 * The structural guarantee this feature rests on is that the PICTURE never
 * writes a symbol. It does not cover a symbol that was there first: Meta's
 * quantity, price, date and fee under GOOGL is exactly the wrong-instrument
 * outcome the design exists to prevent, and no currency check catches it when
 * both trade in USD. The deep link is not discarded — silently dropping the
 * user's own context is its own surprise — the clash is made visible, and it
 * resolves itself when they pick a different stock (or clear the import).
 */
export function symbolConflict(
  symbolAtImport: string | null,
  instrumentSymbol: string | null,
): string | null {
  if (symbolAtImport === null || instrumentSymbol === null) return null;
  return instrumentSymbol === symbolAtImport ? symbolAtImport : null;
}

/** A decimal string → Decimal, or null. Guards against the model returning
 *  something `dec()` would throw on; never a float parse. */
function decOrNull(value: string | null): Decimal | null {
  if (value === null || value.trim().length === 0) return null;
  try {
    const d = dec(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}
