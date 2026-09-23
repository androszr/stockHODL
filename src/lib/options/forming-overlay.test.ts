import { describe, expect, it } from 'vitest';

import {
  everyTickerHasToday,
  optionCardOverlayPrice,
  optionOverlayRows,
} from './forming-overlay';

const TODAY = '2026-08-12';
const A = 'O:AAA270115C00100000';
const B = 'O:BBB270115C00050000';

describe('optionOverlayRows', () => {
  it('emits decimal-string prices via dec() and no invented tickers', () => {
    const rows = optionOverlayRows({
      todayISO: TODAY,
      liveByTicker: new Map([
        [A, '1.25000000'],
        [B, '0.40'],
      ]),
      existingAsOf: [{ ticker: A, asOf: '2026-08-11' }],
    });
    expect(rows).toEqual([
      { ticker: A, asOf: TODAY, price: '1.25' },
      { ticker: B, asOf: TODAY, price: '0.4' },
    ]);
    for (const row of rows) expect(typeof row.price).toBe('string');
  });

  it('omits a ticker that already has today in marks or closes', () => {
    const rows = optionOverlayRows({
      todayISO: TODAY,
      liveByTicker: new Map([
        [A, '1.25'],
        [B, '0.40'],
      ]),
      existingAsOf: [
        { ticker: A, asOf: TODAY },
        { ticker: B, asOf: '2026-08-11' },
      ],
    });
    expect(rows).toEqual([{ ticker: B, asOf: TODAY, price: '0.4' }]);
  });

  it('returns no rows from an empty live map', () => {
    expect(
      optionOverlayRows({
        todayISO: TODAY,
        liveByTicker: new Map(),
        existingAsOf: [{ ticker: A, asOf: '2026-08-11' }],
      }),
    ).toEqual([]);
  });

  it('does not invent a ticker that was not in the live map', () => {
    const rows = optionOverlayRows({
      todayISO: TODAY,
      liveByTicker: new Map([[A, '1.25']]),
      existingAsOf: [{ ticker: B, asOf: '2026-08-11' }],
    });
    expect(rows.map((r) => r.ticker)).toEqual([A]);
  });
});

describe('everyTickerHasToday', () => {
  it('is false when only some tickers already have today', () => {
    expect(
      everyTickerHasToday(
        [A, B],
        [
          { ticker: A, asOf: TODAY },
          { ticker: B, asOf: '2026-08-11' },
        ],
        TODAY,
      ),
    ).toBe(false);
  });

  it('is true only when every ticker already has today', () => {
    expect(
      everyTickerHasToday(
        [A, B],
        [
          { ticker: A, asOf: TODAY },
          { ticker: B, asOf: TODAY },
          { ticker: A, asOf: '2026-08-11' },
        ],
        TODAY,
      ),
    ).toBe(true);
  });
});

describe('optionCardOverlayPrice', () => {
  it('prefers the model mark over a snapshot last', () => {
    expect(
      optionCardOverlayPrice({
        mark: '1.25000000',
        snapshotPrice: '0.40',
        snapshotPrevClose: '0.40',
      }),
    ).toBe('1.25');
  });

  it('uses a non-degenerate snapshot last when there is no mark', () => {
    expect(
      optionCardOverlayPrice({
        snapshotPrice: '0.45000000',
        snapshotPrevClose: '0.33',
      }),
    ).toBe('0.45');
  });

  it('uses a snapshot last when prevClose is unknown', () => {
    expect(
      optionCardOverlayPrice({
        snapshotPrice: '0.40',
        snapshotPrevClose: null,
      }),
    ).toBe('0.4');
  });

  it('refuses a degenerate snapshot the cards would not take as a forming print', () => {
    expect(
      optionCardOverlayPrice({
        snapshotPrice: '13.07',
        snapshotPrevClose: '13.07000000',
      }),
    ).toBeNull();
  });

  it('returns null with neither a mark nor a snapshot', () => {
    expect(optionCardOverlayPrice({})).toBeNull();
  });
});
