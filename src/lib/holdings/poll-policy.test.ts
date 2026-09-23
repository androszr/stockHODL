import { describe, expect, it } from 'vitest';

import type { Quote, QuoteOutcome } from '@/lib/market-data/provider';

import { hasPollableSymbols, isActiveStatus, shouldPollQuotes } from './poll-policy';

/**
 * Regression proof for the structural/transient split. The bug this pins:
 * gating the 10 s interval on "did any price come back?" meant ONE transient
 * wholesale quote failure (Massive timeout/500 → every price null in the next
 * payload) permanently tore the interval down for the rest of the session.
 * The gate must consume only the server's structural verdict — derived from
 * the symbol set sent to the vendor and its per-symbol reasons, never from
 * this round's prices.
 */

const okOutcome = (symbol: string): QuoteOutcome => ({
  ok: true,
  quote: {
    symbol,
    price: '101.25',
    prevClose: '100',
    asOf: new Date('2026-08-10T15:00:00Z'),
    asOfSource: 'trade',
    delaySeconds: 900,
    marketStatus: 'open',
    dayChangeAmt: '1.25',
    dayChangePct: '1.25',
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    dayVolume: null,
    vwap: null,
    extendedChangeAmt: null,
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    source: 'massive',
  },
});

const failed = (symbol: string, reason: 'not_found' | 'unsupported' | 'error'): QuoteOutcome => ({
  ok: false,
  symbol,
  reason,
});

describe('hasPollableSymbols — structural verdict from per-symbol reasons', () => {
  it('only structural rejections (not_found / unsupported) → nothing to poll', () => {
    expect(hasPollableSymbols([failed('CDR.WA', 'not_found')])).toBe(false);
    expect(hasPollableSymbols([failed('CDR.WA', 'not_found'), failed('X.WA', 'unsupported')])).toBe(
      false,
    );
  });

  it('an empty symbol set is structural absence', () => {
    expect(hasPollableSymbols([])).toBe(false);
  });

  it('any ok outcome → pollable, even next to structural rejections', () => {
    expect(hasPollableSymbols([failed('CDR.WA', 'not_found'), okOutcome('NKE')])).toBe(true);
  });

  it('a wholesale transient failure (every outcome an error) is STILL pollable', () => {
    // This is exactly what a Massive timeout/500 produces: the adapter turns
    // the failed chunk into per-symbol `error` outcomes. Transient, not
    // structural — the verdict must stay true so the view can self-heal.
    expect(hasPollableSymbols([failed('NKE', 'error'), failed('SPY', 'error')])).toBe(true);
  });
});

describe('shouldPollQuotes — the interval gate', () => {
  it('polling SURVIVES a payload in which every price is null while the market is active', () => {
    // Simulate the transient blip end to end: the vendor failed wholesale,
    // so the payload's holdings all carry price: null…
    const holdings = [
      { instrumentId: 'a', price: null },
      { instrumentId: 'b', price: null },
    ];
    expect(holdings.every((h) => h.price === null)).toBe(true);

    // …but the structural verdict (computed from the error outcomes, not the
    // prices) stays true — and the gate keeps the cadence running.
    const verdict = hasPollableSymbols([failed('NKE', 'error'), failed('SPY', 'error')]);
    expect(verdict).toBe(true);
    expect(shouldPollQuotes('open', verdict)).toBe(true);
    expect(shouldPollQuotes('early_trading', verdict)).toBe(true);
    expect(shouldPollQuotes('late_trading', verdict)).toBe(true);
  });

  it('structurally unpollable portfolio (only CDR.WA) → no cadence even while open', () => {
    const verdict = hasPollableSymbols([failed('CDR.WA', 'not_found')]);
    expect(verdict).toBe(false);
    expect(shouldPollQuotes('open', verdict)).toBe(false);
  });

  it('fully closed market → no cadence regardless of pollability', () => {
    expect(shouldPollQuotes('closed', true)).toBe(false);
    expect(shouldPollQuotes('unknown', true)).toBe(false);
  });
});

describe('isActiveStatus', () => {
  it('regular and both extended sessions are active; closed/unknown are not', () => {
    const cases: Array<[Quote['marketStatus'], boolean]> = [
      ['open', true],
      ['early_trading', true],
      ['late_trading', true],
      ['closed', false],
      ['unknown', false],
    ];
    for (const [status, expected] of cases) expect(isActiveStatus(status)).toBe(expected);
  });
});
