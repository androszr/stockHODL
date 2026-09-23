import { describe, expect, it } from 'vitest';

import type { TargetLine } from '@/lib/alerts/target-proximity';
import { watchlistPayloadSchema } from '@/lib/api/contracts/watchlist';
import type { HoldingQuote } from '@/lib/holdings/live-payload';
import { dec, fmtMoney, fmtPct, pctChange } from '@/lib/money';

import {
  composeWatchlistPayload,
  type WatchItemInput,
  type WatchlistInputs,
} from './watchlist-payload';

/**
 * The watchlist composition contract: the same figure semantics the Holdings
 * tiles pin (`quoteFigures` — currency guard, '—' over fake zeros, extended
 * passthrough), applied to a positionless item list.
 */

function item(overrides: Partial<WatchItemInput> = {}): WatchItemInput {
  return { instrumentId: 'i1', symbol: 'AAPL', currency: 'USD', ...overrides };
}

function quote(overrides: Partial<HoldingQuote> = {}): HoldingQuote {
  return {
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
  };
}

function inputs(overrides: Partial<WatchlistInputs> = {}): WatchlistInputs {
  return {
    market: {
      status: 'open',
      nextTransitionAtMs: null,
      nextTransitionKind: null,
      pollingResumesAtMs: null,
    },
    hasPollableSymbols: true,
    targetsByInstrument: new Map(),
    ...overrides,
  };
}

function targetLine(overrides: Partial<TargetLine> = {}): TargetLine {
  return { targetPrice: '190', hitAtMs: null, createdAtMs: 1_757_000_000_000, ...overrides };
}

describe('composeWatchlistPayload — figure composition', () => {
  it('maps a usable quote to formatted price + day percent with direction', () => {
    const payload = composeWatchlistPayload([item()], inputs(), new Map([['AAPL', quote()]]));

    expect(payload.items).toHaveLength(1);
    const i = payload.items[0];
    expect(i.instrumentId).toBe('i1');
    expect(i.price).toBe(fmtMoney(dec('110'), 'USD'));
    expect(i.dayPct?.text).toBe(fmtPct(dec(quote().dayChangePct!)));
    expect(i.dayPct?.direction).toBe('gain');
    expect(i.extended).toBeNull();
  });

  it('nulls every figure for a wrong-currency quote — never the wrong money', () => {
    const payload = composeWatchlistPayload(
      [item({ currency: 'EUR' })],
      inputs(),
      new Map([['AAPL', quote()]]),
    );

    const i = payload.items[0];
    expect(i.price).toBeNull();
    expect(i.dayPct).toBeNull();
    expect(i.extended).toBeNull();
  });

  it('nulls every figure when no quote arrived (tile renders "—")', () => {
    const payload = composeWatchlistPayload([item()], inputs(), new Map());

    const i = payload.items[0];
    expect(i.price).toBeNull();
    expect(i.dayPct).toBeNull();
    expect(i.extended).toBeNull();
  });

  it('passes the extended figure through, endedAtMs included', () => {
    const payload = composeWatchlistPayload(
      [item()],
      inputs(),
      new Map([
        [
          'AAPL',
          quote({
            extendedChangePct: '-1.5',
            extendedKind: 'late',
            extendedEndedAtMs: 1_754_800_000_000,
          }),
        ],
      ]),
    );

    const i = payload.items[0];
    expect(i.extended).not.toBeNull();
    expect(i.extended?.kind).toBe('late');
    expect(i.extended?.endedAtMs).toBe(1_754_800_000_000);
    expect(i.extended?.text).toBe(fmtPct(dec('-1.5')));
    expect(i.extended?.direction).toBe('loss');
  });

  it('an empty item list composes an empty payload, market intact', () => {
    const payload = composeWatchlistPayload([], inputs(), new Map());

    expect(payload.items).toEqual([]);
    expect(payload.market.status).toBe('open');
    expect(typeof payload.market.serverNowMs).toBe('number');
  });

  it('passes hasPollableSymbols through untouched, both ways', () => {
    expect(
      composeWatchlistPayload([], inputs({ hasPollableSymbols: true }), new Map())
        .hasPollableSymbols,
    ).toBe(true);
    expect(
      composeWatchlistPayload([], inputs({ hasPollableSymbols: false }), new Map())
        .hasPollableSymbols,
    ).toBe(false);
  });

  it('keys the quote lookup by symbol, per item', () => {
    const payload = composeWatchlistPayload(
      [item(), item({ instrumentId: 'i2', symbol: 'MSFT' })],
      inputs(),
      new Map([['MSFT', quote({ price: '400', prevClose: '400', dayChangePct: '0' })]]),
    );

    expect(payload.items[0].price).toBeNull(); // AAPL: no quote
    expect(payload.items[1].price).toBe(fmtMoney(dec('400'), 'USD'));
    expect(payload.items[1].dayPct?.direction).toBe('neutral');
  });
});

describe('composeWatchlistPayload — target grouping and the server sort', () => {
  // Four stocks, prices chosen so the distances are unambiguous:
  //   NEAR2 at 100 with a 102 line  → 2%   (near)
  //   NEAR1 at 100 with a 101 line  → 1%   (near, closer)
  //   FAR   at 100 with a 120 line  → 20%  (set)
  //   BARE  with no lines           → none
  const four: WatchItemInput[] = [
    { instrumentId: 'bare', symbol: 'BARE', currency: 'USD' },
    { instrumentId: 'near2', symbol: 'NEAR2', currency: 'USD' },
    { instrumentId: 'far', symbol: 'FAR', currency: 'USD' },
    { instrumentId: 'near1', symbol: 'NEAR1', currency: 'USD' },
  ];
  const flat = (symbol: string) =>
    [symbol, quote({ price: '100', prevClose: '100', dayChangePct: '0' })] as const;
  const fourQuotes = new Map([flat('BARE'), flat('NEAR2'), flat('FAR'), flat('NEAR1')]);
  const fourTargets = new Map([
    ['near2', [targetLine({ targetPrice: '102' })]],
    ['near1', [targetLine({ targetPrice: '101' })]],
    ['far', [targetLine({ targetPrice: '120' })]],
  ]);

  it('orders near → set → none, ascending distance inside near', () => {
    const payload = composeWatchlistPayload(
      four,
      inputs({ targetsByInstrument: fourTargets }),
      fourQuotes,
    );

    expect(payload.items.map((i) => i.instrumentId)).toEqual(['near1', 'near2', 'far', 'bare']);
    expect(payload.items.map((i) => i.targetGroup)).toEqual(['near', 'near', 'set', 'none']);
  });

  it('carries the status on grouped items and null on bare ones', () => {
    const payload = composeWatchlistPayload(
      four,
      inputs({ targetsByInstrument: fourTargets }),
      fourQuotes,
    );

    const near1 = payload.items[0];
    expect(near1.target?.text).toBe('1,00%');
    expect(near1.target?.side).toBe('below');
    expect(near1.target?.near).toBe(true);
    expect(payload.items[3].target).toBeNull();
  });

  it('none — including hit-only — keeps insertion order at the bottom', () => {
    const items: WatchItemInput[] = [
      { instrumentId: 'a', symbol: 'A', currency: 'USD' },
      { instrumentId: 'hit', symbol: 'HIT', currency: 'USD' },
      { instrumentId: 'b', symbol: 'B', currency: 'USD' },
      { instrumentId: 'near', symbol: 'NEAR', currency: 'USD' },
    ];
    const payload = composeWatchlistPayload(
      items,
      inputs({
        targetsByInstrument: new Map([
          ['hit', [targetLine({ hitAtMs: 1_757_000_100_000 })]],
          ['near', [targetLine({ targetPrice: '101' })]],
        ]),
      }),
      new Map([flat('A'), flat('HIT'), flat('B'), flat('NEAR')]),
    );

    // NEAR rises; a, hit, b keep today's insertion order in the tail.
    expect(payload.items.map((i) => i.instrumentId)).toEqual(['near', 'a', 'hit', 'b']);
    const hit = payload.items.find((i) => i.instrumentId === 'hit');
    expect(hit?.targetGroup).toBe('none');
    expect(hit?.target?.hitOnly).toBe(true);
    expect(hit?.target?.text).toBe('Hit');
  });

  it('an unpriced item with a waiting line files under set, after the priced ones', () => {
    const items: WatchItemInput[] = [
      { instrumentId: 'unpriced', symbol: 'NOPX', currency: 'USD' },
      { instrumentId: 'far', symbol: 'FAR', currency: 'USD' },
    ];
    const payload = composeWatchlistPayload(
      items,
      inputs({
        targetsByInstrument: new Map([
          ['unpriced', [targetLine()]],
          ['far', [targetLine({ targetPrice: '120' })]],
        ]),
      }),
      new Map([flat('FAR')]), // NOPX has no quote at all
    );

    expect(payload.items.map((i) => i.instrumentId)).toEqual(['far', 'unpriced']);
    expect(payload.items[1].targetGroup).toBe('set');
    expect(payload.items[1].target?.text).toBe('—');
    expect(payload.items[1].target?.side).toBeNull();
  });

  it('a watchlist with no lines at all composes exactly as before — insertion order, no statuses', () => {
    const payload = composeWatchlistPayload(four, inputs(), fourQuotes);

    expect(payload.items.map((i) => i.instrumentId)).toEqual(['bare', 'near2', 'far', 'near1']);
    expect(payload.items.every((i) => i.targetGroup === 'none' && i.target === null)).toBe(true);
  });

  it('round-trips the widened payload through watchlistPayloadSchema', () => {
    const payload = composeWatchlistPayload(
      [
        { instrumentId: '11111111-1111-4111-8111-111111111111', symbol: 'NEAR1', currency: 'USD' },
        { instrumentId: '22222222-2222-4222-8222-222222222222', symbol: 'BARE', currency: 'USD' },
      ],
      inputs({
        targetsByInstrument: new Map([
          ['11111111-1111-4111-8111-111111111111', [targetLine({ targetPrice: '101' })]],
        ]),
      }),
      new Map([flat('NEAR1'), flat('BARE')]),
    );

    const parsed = watchlistPayloadSchema.parse(payload);
    expect(parsed.items[0].targetGroup).toBe('near');
    expect(parsed.items[0].target?.sentence).toContain('below your');
    expect(parsed.items[1].target).toBeNull();
  });
});
