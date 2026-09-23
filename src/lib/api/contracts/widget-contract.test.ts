import { describe, expect, it } from 'vitest';

import {
  composeLivePayload,
  type HoldingQuote,
  type HoldingsInputs,
  type ScopedEngineTransaction,
} from '@/lib/holdings/live-payload';
import { dec, pctChange } from '@/lib/money';

import { widgetSummaryResponseSchema } from './widget';

const summary = {
  totalValue: '148 250,00 zł',
  dayChange: { text: '+1 240,00 zł (+0,84%)', direction: 'gain' as const },
  totalChange: { text: '+18 400,00 zł (+14,20%)', direction: 'gain' as const },
  dayChangePct: '+0,84%',
  totalChangePct: '+14,20%',
  excludedSymbols: [] as string[],
  partialDayChange: false,
};

const market = {
  status: 'open' as const,
  nextTransitionAtMs: null,
  nextTransitionKind: null,
  pollingResumesAtMs: null,
  serverNowMs: 1_754_800_000_000,
};

const base = {
  holdings: summary,
  options: { ...summary, totalValue: '$3 772.00' },
  market,
};

describe('widgetSummaryResponseSchema', () => {
  it('accepts a payload with dayLines absent', () => {
    expect(widgetSummaryResponseSchema.parse(base).dayLines).toBeUndefined();
  });

  it('accepts optional dayLines with decimal-string percents', () => {
    const parsed = widgetSummaryResponseSchema.parse({
      ...base,
      dayLines: {
        sessionOpenMs: 1,
        sessionCloseMs: 2,
        holdings: [{ t: 1, p: '-1.43' }],
        options: [{ t: 1, p: '-8.92' }],
      },
    });
    expect(parsed.dayLines?.holdings[0]?.p).toBe('-1.43');
  });

  it('refuses a numeric p', () => {
    const result = widgetSummaryResponseSchema.safeParse({
      ...base,
      dayLines: {
        sessionOpenMs: 1,
        sessionCloseMs: 2,
        holdings: [{ t: 1, p: -1.43 }],
        options: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts real composer summaries with dayLines absent', () => {
    const buy = (overrides: Partial<ScopedEngineTransaction> = {}): ScopedEngineTransaction => ({
      id: 't1',
      instrumentId: '11111111-1111-4111-8111-111111111111',
      symbol: 'AAPL',
      displayName: 'Apple Inc.',
      currency: 'USD',
      side: 'buy',
      quantity: '10',
      price: '100',
      fees: '0',
      fxRateToBase: '4.00000000',
      tradeDate: '2026-01-05',
      createdAt: new Date('2026-01-05T12:00:00Z'),
      ...overrides,
    });
    const quote = (overrides: Partial<HoldingQuote> = {}): HoldingQuote => ({
      price: '110',
      currency: 'USD',
      prevClose: '105',
      dayChangeAmt: dec('110').minus(dec('105')).toString(),
      dayChangePct: pctChange(dec('105'), dec('110'))!.toString(),
      extendedChangePct: null,
      extendedKind: null,
      extendedEndedAtMs: null,
      extendedLive: false,
      ...overrides,
    });
    const inputs: HoldingsInputs = {
      engineTxs: [buy()],
      fxRates: new Map([['USD', '4.00']]),
      market: {
        status: 'open',
        nextTransitionAtMs: null,
        nextTransitionKind: null,
        pollingResumesAtMs: null,
      },
      hasPollableSymbols: true,
    };
    const live = composeLivePayload(inputs, new Map([['AAPL', quote()]]));
    const parsed = widgetSummaryResponseSchema.parse({
      holdings: live.summary,
      options: live.summary,
      market: live.market,
    });
    expect(parsed.dayLines).toBeUndefined();
    expect(parsed.holdings.totalValue).toBeTruthy();
  });
});
