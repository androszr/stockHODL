import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate LADDER, which is the only thing in this module worth testing:
 * the field mapping is `validation.ts`'s and the normalizers have their own
 * suites. What is asserted here is the ORDER, because the order is the
 * security and the cost story — a paid vendor call must not be reachable by
 * a payload that failed a free local check, and the shared rate-limit budget
 * must not be spent by one that never leaves the building.
 */

const state = vi.hoisted(() => ({
  rateLimited: false,
  rateLimitCalls: 0,
  extractCalls: 0,
  extractOutcome: null as unknown,
}));

vi.mock('server-only', () => ({}));

vi.mock('@/lib/screenshots/vision-rate-limit', () => ({
  visionRateLimited: () => {
    state.rateLimitCalls += 1;
    return state.rateLimited;
  },
}));

vi.mock('@/lib/ai/vision-extract', () => ({
  extractTransactionScreenshot: async () => {
    state.extractCalls += 1;
    return state.extractOutcome;
  },
  extractOptionScreenshot: async () => {
    state.extractCalls += 1;
    return state.extractOutcome;
  },
}));

const { parseTransactionScreenshotImage } = await import('./parse');

/** A one-pixel PNG, base64 — real magic bytes, so the sniff passes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Every field of the transaction extraction, all null — the honest shape of
 *  a screenshot the model could read but found nothing in. */
function emptyExtraction() {
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

beforeEach(() => {
  state.rateLimited = false;
  state.rateLimitCalls = 0;
  state.extractCalls = 0;
  state.extractOutcome = { ok: true, extraction: emptyExtraction() };
});

describe('parseTransactionScreenshotImage', () => {
  it('reads a valid screenshot', async () => {
    const outcome = await parseTransactionScreenshotImage({ imageBase64: PNG_BASE64 });

    expect(outcome.ok).toBe(true);
    expect(state.extractCalls).toBe(1);
  });

  it('spends no budget on a payload that never reaches the vendor', async () => {
    // Valid base64, but not an image — the magic-byte sniff refuses it.
    const outcome = await parseTransactionScreenshotImage({ imageBase64: 'aGVsbG8=' });

    expect(outcome).toEqual({ ok: false, reason: 'invalid_image' });
    // The budget is ONE in-process allowance shared by both importers and
    // both surfaces. Charging it here would let a malformed upload on one
    // screen lock the other three out for ten minutes.
    expect(state.rateLimitCalls).toBe(0);
    expect(state.extractCalls).toBe(0);
  });

  it('refuses junk that is not base64 at all, indistinguishably', async () => {
    const outcome = await parseTransactionScreenshotImage({ imageBase64: 'not base64!!' });

    // Same single reason as every other pre-vendor rejection: a probe must
    // not learn WHICH gate it tripped.
    expect(outcome).toEqual({ ok: false, reason: 'invalid_image' });
    expect(state.extractCalls).toBe(0);
  });

  it('refuses a missing body without touching the vendor', async () => {
    expect(await parseTransactionScreenshotImage({})).toEqual({
      ok: false,
      reason: 'invalid_image',
    });
    expect(await parseTransactionScreenshotImage(null)).toEqual({
      ok: false,
      reason: 'invalid_image',
    });
    expect(state.extractCalls).toBe(0);
  });

  it('stops at the rate limit, before the money is spent', async () => {
    state.rateLimited = true;

    const outcome = await parseTransactionScreenshotImage({ imageBase64: PNG_BASE64 });

    expect(outcome).toEqual({ ok: false, reason: 'rate_limited' });
    expect(state.extractCalls).toBe(0);
  });

  it('reports a vendor error as unavailable, not as a bad screenshot', async () => {
    state.extractOutcome = { ok: false, reason: 'error' };

    // `error` is a state of the world; every other failure names itself. The
    // difference decides whether the UI says "try again" or "try another
    // picture", and the user should not be sent hunting for a better
    // screenshot when the reader is simply down.
    expect(await parseTransactionScreenshotImage({ imageBase64: PNG_BASE64 })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('passes a refusal through under its own name', async () => {
    state.extractOutcome = { ok: false, reason: 'refused' };

    expect(await parseTransactionScreenshotImage({ imageBase64: PNG_BASE64 })).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('treats a model answer of the wrong shape as unparseable, never a crash', async () => {
    state.extractOutcome = { ok: true, extraction: { tickerCandidate: 42 } };

    expect(await parseTransactionScreenshotImage({ imageBase64: PNG_BASE64 })).toEqual({
      ok: false,
      reason: 'unparseable',
    });
  });
});
