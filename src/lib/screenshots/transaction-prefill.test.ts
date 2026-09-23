import { describe, expect, it } from 'vitest';

import {
  transactionExtractionFromWire,
  type TransactionScreenshotExtraction,
  type TransactionScreenshotWire,
} from '@/lib/validation';

import {
  buildTransactionPrefill,
  convertFee,
  currencyMismatch,
  inferPriceCurrency,
  normalizeScreenMoney,
  normalizeTransactionExtraction,
  priceCurrencyCheck,
  resolveSide,
  symbolConflict,
} from './transaction-prefill';

/**
 * The decision layer, tested against two reference fixtures in the shape of
 * two broker screens.
 *
 * The figures are invented; the LAYOUTS are real: an mBank PL "szczegóły
 * transakcji" screen (screenshot A, a META PLATFOR purchase) and a Saxo
 * "Position Details" screen (screenshot B, Alphabet Inc. Class A). Every
 * string below is written the way those screens print it — comma decimals,
 * space-grouped thousands, Polish month abbreviations — because the parsing
 * rules are about the layout. The arithmetic the feature depends on —
 * 12 × 601,505, 59,91 ÷ 3,6512 = 16,41, 20 @ 148,23 — is checked here so it
 * cannot regress without a red test.
 *
 * Everything here is offline and pure: no vision call, no network, no DOM.
 */

function allNull(): TransactionScreenshotExtraction {
  return {
    tickerCandidate: null,
    companyName: null,
    isinCandidate: null,
    exchange: null,
    side: null,
    sideEvidence: null,
    quantity: null,
    pricePerShare: null,
    priceCurrency: null,
    settlementCurrency: null,
    totalValue: null,
    totalValueCurrency: null,
    fees: null,
    feesCurrency: null,
    brokerFxRate: null,
    tradeDate: null,
    settlementDate: null,
    screenKind: null,
    brokerSymbolText: null,
  };
}

/** The mBank screen, exactly as the model would transcribe it. */
function mbankRaw(): TransactionScreenshotExtraction {
  return {
    tickerCandidate: null, // the Polish screen prints no ticker at all
    companyName: 'META PLATFOR',
    isinCandidate: 'US30303M1027',
    exchange: 'NASDAQ',
    side: 'buy',
    sideEvidence: 'kupno',
    quantity: '12',
    pricePerShare: '601,505',
    priceCurrency: 'USD', // from the "NASDAQ USD" header
    settlementCurrency: 'PLN', // from "waluta"
    totalValue: '26 354,58',
    totalValueCurrency: 'PLN',
    fees: '59,91',
    feesCurrency: 'PLN',
    brokerFxRate: '3,6512',
    tradeDate: '02.09.2026', // data wykonania
    settlementDate: '03.09.2026', // data rozliczenia — T+1, never the trade date
    screenKind: 'transaction',
    brokerSymbolText: 'NASDAQ USD - US30303M1027',
  };
}

/** The Saxo position screen, Open column only. */
function saxoRaw(): TransactionScreenshotExtraction {
  return {
    tickerCandidate: 'GOOGL',
    companyName: 'Alphabet Inc. Class A',
    isinCandidate: null,
    exchange: 'NASDAQ',
    side: null, // the screen never says buy or sell
    sideEvidence: null,
    quantity: '20',
    pricePerShare: '148,23',
    priceCurrency: 'USD',
    settlementCurrency: 'PLN',
    totalValue: '-2 964,60', // Market Value, Open column — a purchase costs cash
    totalValueCurrency: 'USD',
    fees: '3,15',
    feesCurrency: 'USD',
    brokerFxRate: '3,68215400', // Conversion USD>PLN, Open column
    tradeDate: '03-sie-2026', // Opened
    settlementDate: '05-sie-2026', // Value Date
    screenKind: 'position',
    brokerSymbolText: 'GOOGL:xnas',
  };
}

describe('mBank “szczegóły transakcji” — the whole screen', () => {
  const extraction = normalizeTransactionExtraction(mbankRaw());

  it('reads twelve shares at 601.505', () => {
    expect(extraction.quantity).toBe('12');
    expect(extraction.pricePerShare).toBe('601.505');
  });

  it('takes the EXECUTION date, not the settlement date one day later', () => {
    expect(extraction.tradeDate).toBe('2026-09-02');
    expect(extraction.settlementDate).toBe('2026-09-03');
  });

  it('keeps the account currency out of the price currency', () => {
    expect(extraction.priceCurrency).toBe('USD');
    expect(extraction.settlementCurrency).toBe('PLN');
  });

  it('states the side from the printed word', () => {
    expect(resolveSide(extraction)).toEqual({ side: 'buy', source: 'stated' });
  });

  it('proves the price is in dollars by cross-multiplying against the total', () => {
    // 26 354,58 ÷ (12 × 601,505) = 3,6512 — the printed conversion rate.
    expect(
      priceCurrencyCheck({
        quantity: extraction.quantity,
        pricePerShare: extraction.pricePerShare,
        totalValue: extraction.totalValue,
        brokerFxRate: extraction.brokerFxRate,
      }),
    ).toBe('converted');
  });

  it('converts the złoty commission into dollars and shows the arithmetic', () => {
    const converted = convertFee({
      fee: extraction.fees,
      feeCurrency: extraction.feesCurrency,
      targetCurrency: extraction.priceCurrency,
      plnPerUnit: extraction.brokerFxRate,
    });
    expect(converted?.amount).toBe('16.41');
    expect(converted?.shown).toEqual({
      from: '59.91',
      fromCurrency: 'PLN',
      rate: '3.6512',
      to: '16.41',
      toCurrency: 'USD',
    });
  });

  it('keeps the ISIN for display and refuses to turn it into a ticker', () => {
    expect(extraction.isinCandidate).toBe('US30303M1027');
    // "NASDAQ USD - US30303M1027" must not yield "NASDAQ" as a ticker.
    expect(extraction.tickerCandidate).toBeNull();
  });

  it('builds a prefill that types the company name into the search box only', () => {
    const prefill = buildTransactionPrefill(extraction);
    expect(prefill.form).toEqual({
      quantity: '12',
      price: '601.505',
      fees: '16.41',
      tradeDate: '2026-09-02',
      side: 'buy',
      symbolQuery: 'META PLATFOR',
    });
    expect(prefill.readFields).toEqual(['quantity', 'price', 'trade date', 'commission']);
    expect(prefill.notes.map((n) => n.kind)).toEqual(['fee-converted']);
  });
});

describe('Saxo “Position Details” — a whole position, not one trade', () => {
  const extraction = normalizeTransactionExtraction(saxoRaw());

  it('reads twenty shares at 148.23 opened on 3 August', () => {
    expect(extraction.quantity).toBe('20');
    expect(extraction.pricePerShare).toBe('148.23');
    expect(extraction.tradeDate).toBe('2026-08-03');
    // NOT the 05-sie value date.
    expect(extraction.settlementDate).toBe('2026-08-05');
  });

  it('takes the ticker off the broker symbol', () => {
    expect(extraction.tickerCandidate).toBe('GOOGL');
  });

  it('treats a negative Market Value as a cash-flow sign, not a currency clue', () => {
    expect(
      priceCurrencyCheck({
        quantity: extraction.quantity,
        pricePerShare: extraction.pricePerShare,
        totalValue: extraction.totalValue,
        brokerFxRate: extraction.brokerFxRate,
      }),
    ).toBe('consistent');
  });

  it('assumes Buy from the open position, and says that it assumed', () => {
    expect(resolveSide(extraction)).toEqual({ side: 'buy', source: 'assumed' });
  });

  it('leaves a dollar commission alone — no conversion, no note', () => {
    const converted = convertFee({
      fee: extraction.fees,
      feeCurrency: extraction.feesCurrency,
      targetCurrency: extraction.priceCurrency,
      plnPerUnit: extraction.brokerFxRate,
    });
    expect(converted).toEqual({ amount: '3.15', shown: null });
  });

  it('warns that the whole position was filled in as one purchase', () => {
    const prefill = buildTransactionPrefill(extraction);
    expect(prefill.form).toEqual({
      quantity: '20',
      price: '148.23',
      fees: '3.15',
      tradeDate: '2026-08-03',
      side: 'buy',
      symbolQuery: 'GOOGL',
    });
    expect(prefill.notes).toEqual([
      { kind: 'position', quantity: '20', pricePerShare: '148.23' },
      { kind: 'side-assumed' },
    ]);
    expect(prefill.screenKind).toBe('position');
  });
});

/**
 * Two more Saxo position screens, the shape the import was found broken on —
 * screenshot C (Palo Alto Networks) and screenshot D (CrowdStrike), figures
 * invented. The failure was upstream of everything below (a 400 on
 * the schema, before the image was read), so these run the door's OWN wire
 * shape end to end: empty strings for what the screen never states, a clock
 * time on the Opened cell, verbatim comma decimals.
 */
function saxoPanwWire(): TransactionScreenshotWire {
  return {
    tickerCandidate: 'PANW',
    companyName: 'Palo Alto Networks Inc.',
    isinCandidate: '', // the Saxo screen prints none
    exchange: 'NASDAQ',
    side: '', // "Position 8 @ 182,40" — never the word buy or sell
    sideEvidence: '',
    quantity: '8',
    pricePerShare: '182,40',
    priceCurrency: 'USD', // only the money rows say so; the header is "PANW:xnas"
    settlementCurrency: 'PLN',
    totalValue: '-1 459,20', // Market Value, Open column
    totalValueCurrency: 'USD',
    fees: '2,00', // Commission, Open; Exchange Fee is "–" and stays absent
    feesCurrency: 'USD',
    brokerFxRate: '3,69120455', // Conversion USD>PLN, Open column
    tradeDate: '24-sie-2026 18:41:07', // Opened — date AND time, as printed
    settlementDate: '25-sie-2026', // Value Date
    screenKind: 'position',
    brokerSymbolText: 'PANW:xnas',
  };
}

describe('the two Saxo screens the 400 was found on', () => {
  const extraction = normalizeTransactionExtraction(
    transactionExtractionFromWire(saxoPanwWire()),
  );

  it('reads eight Palo Alto shares at 182.40, opened on 24 August', () => {
    expect(extraction.quantity).toBe('8');
    expect(extraction.pricePerShare).toBe('182.40');
    // The clock time on the Opened cell is dropped, not swallowed whole.
    expect(extraction.tradeDate).toBe('2026-08-24');
    expect(extraction.settlementDate).toBe('2026-08-25');
  });

  it('reports what the screen never stated as absent, not as a guess', () => {
    expect(extraction.isinCandidate).toBeNull();
    expect(extraction.side).toBeNull();
    expect(extraction.sideEvidence).toBeNull();
  });

  it('still proves the price is in dollars against the negative Market Value', () => {
    expect(
      priceCurrencyCheck({
        quantity: extraction.quantity,
        pricePerShare: extraction.pricePerShare,
        totalValue: extraction.totalValue,
        brokerFxRate: extraction.brokerFxRate,
      }),
    ).toBe('consistent');
  });

  it('fills the form and discloses that Buy was this app’s inference', () => {
    const prefill = buildTransactionPrefill(extraction);
    expect(prefill.form).toEqual({
      quantity: '8',
      price: '182.40',
      fees: '2',
      tradeDate: '2026-08-24',
      side: 'buy',
      symbolQuery: 'PANW',
    });
    expect(prefill.notes).toEqual([
      { kind: 'position', quantity: '8', pricePerShare: '182.40' },
      { kind: 'side-assumed' },
    ]);
    expect(prefill.priceCurrency).toBe('USD');
  });

  it('reads the CrowdStrike screen the same way — same layout, other numbers', () => {
    const crwd = normalizeTransactionExtraction(
      transactionExtractionFromWire({
        ...saxoPanwWire(),
        tickerCandidate: 'CRWD',
        companyName: 'CrowdStrike Holdings Inc.',
        pricePerShare: '305,15',
        totalValue: '-2 441,20',
        fees: '1,85',
        brokerFxRate: '3,69133810',
        tradeDate: '24-sie-2026 18:41:29',
        brokerSymbolText: 'CRWD:xnas',
      }),
    );

    expect(buildTransactionPrefill(crwd).form).toEqual({
      quantity: '8',
      price: '305.15',
      fees: '1.85',
      tradeDate: '2026-08-24',
      side: 'buy',
      symbolQuery: 'CRWD',
    });
  });
});

describe('the edge cases that make the math wrong rather than absent', () => {
  it('refuses to convert a złoty fee with no printed rate', () => {
    expect(
      convertFee({
        fee: '59.91',
        feeCurrency: 'PLN',
        targetCurrency: 'USD',
        plnPerUnit: null,
      }),
    ).toBeNull();
  });

  it('prefills a 0 fee with a warning when the conversion is impossible', () => {
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({
        ...allNull(),
        fees: '59,91',
        feesCurrency: 'PLN',
        priceCurrency: 'USD',
      }),
    );
    expect(prefill.form.fees).toBe('0');
    expect(prefill.notes).toContainEqual({
      kind: 'fee-unconverted',
      feeCurrency: 'PLN',
      reason: 'no-rate',
    });
  });

  it('refuses a pair with no PLN leg rather than chaining two guesses', () => {
    expect(
      convertFee({
        fee: '10',
        feeCurrency: 'EUR',
        targetCurrency: 'USD',
        plnPerUnit: '3.6512',
      }),
    ).toBeNull();
  });

  it('never divides by a zero or missing quantity', () => {
    const base = { pricePerShare: '601.505', totalValue: '26354.58', brokerFxRate: '3.6512' };
    expect(priceCurrencyCheck({ ...base, quantity: '0' })).toBe('unknown');
    expect(priceCurrencyCheck({ ...base, quantity: null })).toBe('unknown');
    expect(
      priceCurrencyCheck({ ...base, quantity: '12', pricePerShare: null }),
    ).toBe('unknown');
  });

  it('calls a total that matches neither 1 nor the rate inconsistent', () => {
    expect(
      priceCurrencyCheck({
        quantity: '12',
        pricePerShare: '601.505',
        totalValue: '999999',
        brokerFxRate: '3.6512',
      }),
    ).toBe('inconsistent');
  });

  it('will not assume Buy on a position screen with no quantity', () => {
    expect(
      resolveSide({ ...allNull(), screenKind: 'position' }),
    ).toEqual({ side: null, source: 'unknown' });
    expect(
      resolveSide({ ...allNull(), screenKind: 'position', quantity: '0' }),
    ).toEqual({ side: null, source: 'unknown' });
  });

  it('still raises the position warning when every other field failed to read', () => {
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...allNull(), screenKind: 'position' }),
    );
    expect(prefill.notes).toContainEqual({
      kind: 'position',
      quantity: null,
      pricePerShare: null,
    });
  });

  it('turns an all-null extraction into an all-null prefill without throwing', () => {
    const prefill = buildTransactionPrefill(normalizeTransactionExtraction(allNull()));
    expect(prefill.form).toEqual({
      quantity: null,
      price: null,
      fees: null,
      tradeDate: null,
      side: null,
      symbolQuery: null,
    });
    expect(prefill.readFields).toEqual([]);
    // Only the "nobody said buy or sell" note, which is the honest thing to say.
    expect(prefill.notes).toEqual([{ kind: 'side-unknown' }]);
  });

  it('nulls a malformed ISIN instead of showing it', () => {
    expect(
      normalizeTransactionExtraction({ ...allNull(), isinCandidate: 'US303' }).isinCandidate,
    ).toBeNull();
  });

  it('does not raise a mismatch at import time — nothing is picked yet', () => {
    // The premise the APP supplies: `buildTransactionPrefill` is called from
    // the import component with no instrument argument at all, because at that
    // moment no stock has been picked. A note raised here could only ever be
    // a comparison against nothing.
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...allNull(), priceCurrency: 'USD' }),
    );
    expect(prefill.notes.map((n) => n.kind)).not.toContain('currency-mismatch');
    expect(prefill.priceCurrency).toBe('USD');
    expect(prefill.priceCurrencyTrusted).toBe(true);
  });
});

describe('the currency mismatch, answered against the stock actually picked', () => {
  const prefill = buildTransactionPrefill(
    normalizeTransactionExtraction({ ...allNull(), priceCurrency: 'USD' }),
  );

  it('says nothing until an instrument exists', () => {
    // What the form reports before any pick: null, not 'PLN'.
    expect(currencyMismatch(prefill, null)).toBe(false);
  });

  it('fires the moment a PLN-listed stock is picked against a USD screen', () => {
    expect(currencyMismatch(prefill, 'PLN')).toBe(true);
  });

  it('stays quiet when the picked stock matches the screen', () => {
    expect(currencyMismatch(prefill, 'USD')).toBe(false);
  });

  it('never compares a price currency the screen itself disproved', () => {
    // The mBank shape with the model's classic mistake: `waluta: PLN` read as
    // the trading currency. That already has its own warning; comparing it
    // against the picked stock would only add a second, differently-worded
    // one about a value known to be junk.
    const disproven = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...mbankRaw(), priceCurrency: 'PLN' }),
    );
    expect(disproven.priceCurrencyTrusted).toBe(false);
    expect(currencyMismatch(disproven, 'USD')).toBe(false);
  });

  it('never fires on a screen that quoted no currency at all', () => {
    const noCurrency = buildTransactionPrefill(normalizeTransactionExtraction(allNull()));
    expect(currencyMismatch(noCurrency, 'USD')).toBe(false);
  });
});

/**
 * Screenshot D — Saxo "Position Details", CrowdStrike (figures invented). The
 * layout that exposed this: its header is bare (`CRWD:xnas`), so the model
 * returned NO price currency, and a legible `Commission 1,85 USD` was landing
 * in the form as `0` because nothing had proved what currency to convert into.
 * Everything below is written the way that screen prints it.
 */
function saxoCrwdUnlabelledWire(): TransactionScreenshotWire {
  return {
    tickerCandidate: 'CRWD',
    companyName: 'CrowdStrike Holdings Inc.',
    isinCandidate: '',
    exchange: 'NASDAQ',
    side: '',
    sideEvidence: '',
    quantity: '8',
    pricePerShare: '305,15',
    priceCurrency: '', // the failure being fixed: the header names none
    settlementCurrency: 'PLN',
    totalValue: '-2 441,20', // Market Value, Open column
    totalValueCurrency: 'USD',
    fees: '1,85', // Commission, Open column
    feesCurrency: 'USD',
    brokerFxRate: '3,69133810', // Conversion USD>PLN, Open column
    tradeDate: '24-sie-2026 18:41:29',
    settlementDate: '25-sie-2026',
    screenKind: 'position',
    brokerSymbolText: 'CRWD:xnas',
  };
}

describe('a price currency the screen never printed, proved by its own total', () => {
  const extraction = normalizeTransactionExtraction(
    transactionExtractionFromWire(saxoCrwdUnlabelledWire()),
  );

  it('reads no price currency off the bare CRWD:xnas header', () => {
    expect(extraction.priceCurrency).toBeNull();
  });

  it('takes the total’s currency once the arithmetic proves they are the same', () => {
    // 2 441,20 ÷ (8 × 305,15) = 1,000 — total and price are one currency.
    expect(
      priceCurrencyCheck({
        quantity: extraction.quantity,
        pricePerShare: extraction.pricePerShare,
        totalValue: extraction.totalValue,
        brokerFxRate: extraction.brokerFxRate,
      }),
    ).toBe('consistent');
    expect(inferPriceCurrency(extraction, 'consistent')).toBe('USD');
  });

  it('keeps the dollar commission instead of zeroing it, and says why', () => {
    const prefill = buildTransactionPrefill(extraction);
    expect(prefill.form.fees).toBe('1.85');
    expect(prefill.priceCurrency).toBe('USD');
    expect(prefill.priceCurrencyTrusted).toBe(true);
    expect(prefill.notes).toContainEqual({
      kind: 'price-currency-inferred',
      currency: 'USD',
    });
    // Nothing was converted, so no conversion is claimed.
    expect(prefill.notes.map((n) => n.kind)).not.toContain('fee-converted');
    expect(prefill.notes.map((n) => n.kind)).not.toContain('fee-unconverted');
  });

  it('now catches a złoty stock picked against this dollar screen', () => {
    const prefill = buildTransactionPrefill(extraction);
    expect(currencyMismatch(prefill, 'PLN')).toBe(true);
    expect(currencyMismatch(prefill, 'USD')).toBe(false);
  });

  it('never overrides a currency the screen DID print', () => {
    // The printed value wins even when the total disagrees — it has its own
    // disproof path, and this is a fallback, not a second opinion.
    expect(inferPriceCurrency({ priceCurrency: 'USD', totalValueCurrency: 'PLN' }, 'consistent'))
      .toBeNull();
  });

  it('infers nothing when the arithmetic proves nothing', () => {
    const unlabelled = { priceCurrency: null, totalValueCurrency: 'PLN' };
    // `converted` means the total is in the SETTLEMENT currency and the price
    // is not — the mBank shape, where taking the total's PLN would put złoty
    // in a dollar field. That is the exact bug this feature exists to prevent.
    expect(inferPriceCurrency(unlabelled, 'converted')).toBeNull();
    expect(inferPriceCurrency(unlabelled, 'inconsistent')).toBeNull();
    expect(inferPriceCurrency(unlabelled, 'unknown')).toBeNull();
  });

  it('leaves the mBank screen’s fee refusal exactly as it was', () => {
    // Same missing field, `converted` instead of `consistent` — so the fee
    // still fails closed rather than picking up the total's currency.
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...mbankRaw(), priceCurrency: null }),
    );
    expect(prefill.form.fees).toBe('0');
    expect(prefill.priceCurrency).toBeNull();
    expect(prefill.notes.map((n) => n.kind)).not.toContain('price-currency-inferred');
  });
});

describe('a fee may never reach the trading-currency field unproven', () => {
  it('refuses a fee whose currency is known and whose target is not', () => {
    // The one INFERRED field failed: `priceCurrency` was never read off the
    // `NASDAQ USD` header. 59,91 is złoty; the Fees field will be labelled in
    // whatever the user picks. Passing it through would store 59.91 USD.
    expect(
      convertFee({
        fee: '59.91',
        feeCurrency: 'PLN',
        targetCurrency: null,
        plnPerUnit: '3.6512',
      }),
    ).toBeNull();
  });

  it('refuses a fee with no currency against a known target', () => {
    expect(
      convertFee({
        fee: '59.91',
        feeCurrency: null,
        targetCurrency: 'USD',
        plnPerUnit: '3.6512',
      }),
    ).toBeNull();
  });

  it('passes a bare figure through when NOTHING is known about either side', () => {
    expect(
      convertFee({ fee: '3.15', feeCurrency: null, targetCurrency: null, plnPerUnit: null }),
    ).toEqual({ amount: '3.15', shown: null });
  });

  it('passes a zero through whatever the currencies say — zero costs nothing', () => {
    expect(
      convertFee({ fee: '0', feeCurrency: 'PLN', targetCurrency: null, plnPerUnit: null }),
    ).toEqual({ amount: '0', shown: null });
  });

  it('zeroes the fee and warns when the trading currency was not read', () => {
    // End to end on the real mBank figures, minus the one inferred field.
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...mbankRaw(), priceCurrency: null }),
    );
    expect(prefill.form.fees).toBe('0');
    expect(prefill.notes).toContainEqual({
      kind: 'fee-unconverted',
      feeCurrency: 'PLN',
      reason: 'no-rate',
    });
  });

  it('zeroes the fee and warns when the screen disproves its own price currency', () => {
    // `waluta: PLN` read as the trading currency: 26 354,58 ÷ (12 × 601,505)
    // is the printed FX rate, which means the price is NOT in the total's
    // currency — so a priceCurrency equal to it is contradicted on its face.
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...mbankRaw(), priceCurrency: 'PLN' }),
    );
    expect(prefill.form.fees).toBe('0');
    expect(prefill.notes).toContainEqual({
      kind: 'currency-mismatch',
      screenCurrency: 'PLN',
    });
  });

  it('does not claim "no rate" when a rate was read and disproved the target', () => {
    // A rate IS printed on this screen — it is exactly what contradicted the
    // price currency. Telling the user the screenshot carries no rate would be
    // false on the picture in front of them.
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...mbankRaw(), priceCurrency: 'PLN' }),
    );
    expect(prefill.notes).toContainEqual({
      kind: 'fee-unconverted',
      feeCurrency: 'PLN',
      reason: 'unknown-target',
    });
  });
});

describe('normalizeScreenMoney — the widening that stays on this screen', () => {
  it('reads mBank’s three-decimal price: 601,505 → 601.505', () => {
    expect(normalizeScreenMoney('601,505')).toBe('601.505');
  });

  it('still strips space grouping and keeps a negative negative', () => {
    expect(normalizeScreenMoney('26 354,58')).toBe('26354.58');
    expect(normalizeScreenMoney('-2 964,60')).toBe('-2964.60');
    expect(normalizeScreenMoney('   ')).toBeNull();
  });

  it('leaves a mixed-separator value alone rather than guessing', () => {
    expect(normalizeScreenMoney('1.234,5')).toBe('1.234,5');
    expect(normalizeScreenMoney('1,2,3')).toBe('1,2,3');
  });

  it('is applied to the price and the rate, and to nothing else', () => {
    // The widening reads a lone comma as a decimal point. On a PRICE that is
    // the mBank evidence (601,505). On a SHARE COUNT it would be a silent
    // 1000× error: `1,500` shares is fifteen hundred, not one and a half.
    const extraction = normalizeTransactionExtraction({
      ...allNull(),
      quantity: '1,500',
      pricePerShare: '601,505',
      fees: '2,500',
      totalValue: '1,000',
      brokerFxRate: '3,6512',
    });
    // Left as printed ⇒ `decimalString` refuses it at submit, loudly.
    expect(extraction.quantity).toBe('1,500');
    expect(extraction.quantity).not.toBe('1.5');
    expect(extraction.fees).toBe('2,500');
    expect(extraction.totalValue).toBe('1,000');
    // The two fields the evidence actually covers.
    expect(extraction.pricePerShare).toBe('601.505');
    expect(extraction.brokerFxRate).toBe('3.6512');
  });

  it('still reads both reference screens unchanged', () => {
    const mbank = normalizeTransactionExtraction(mbankRaw());
    expect(mbank.quantity).toBe('12');
    expect(mbank.fees).toBe('59.91');
    expect(mbank.totalValue).toBe('26354.58');
    const saxo = normalizeTransactionExtraction(saxoRaw());
    expect(saxo.quantity).toBe('20');
    expect(saxo.fees).toBe('3.15');
    expect(saxo.totalValue).toBe('-2964.60');
  });
});

describe('a total that does not add up is not a currency problem', () => {
  it('reports total-mismatch, not currency-mismatch, when the arithmetic fails', () => {
    // A position screen showing today's market value rather than the cost:
    // 20 × 148,23 = 2 964,60, but the screen says 3 200. Nothing here says
    // anything about a currency, and no stock has been picked yet.
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({
        ...saxoRaw(),
        totalValue: '-3 200,00',
      }),
    );
    const kinds = prefill.notes.map((n) => n.kind);
    expect(kinds).toContain('total-mismatch');
    expect(kinds).not.toContain('currency-mismatch');
  });

  it('keeps currency-mismatch for the currency the screen disproved', () => {
    const prefill = buildTransactionPrefill(
      normalizeTransactionExtraction({ ...mbankRaw(), priceCurrency: 'PLN' }),
    );
    const kinds = prefill.notes.map((n) => n.kind);
    expect(kinds).toContain('currency-mismatch');
    expect(kinds).not.toContain('total-mismatch');
  });

  it('says neither on the two reference screens', () => {
    for (const raw of [mbankRaw(), saxoRaw()]) {
      const kinds = buildTransactionPrefill(normalizeTransactionExtraction(raw)).notes.map(
        (n) => n.kind,
      );
      expect(kinds).not.toContain('total-mismatch');
      expect(kinds).not.toContain('currency-mismatch');
    }
  });
});

describe('a screenshot landing on an already-picked stock', () => {
  it('names the clash when the deep-linked symbol is still selected', () => {
    // `/holdings/GOOGL` → Add transaction → import the Meta screenshot. Both
    // trade in USD, so the currency warning can never catch this.
    expect(symbolConflict('GOOGL', 'GOOGL')).toBe('GOOGL');
  });

  it('falls silent once the user picks a different stock', () => {
    expect(symbolConflict('GOOGL', 'META')).toBeNull();
    expect(symbolConflict('GOOGL', null)).toBeNull();
  });

  it('says nothing when no stock was picked before the import', () => {
    expect(symbolConflict(null, 'META')).toBeNull();
    expect(symbolConflict(null, null)).toBeNull();
  });
});
