import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Candle } from '@/lib/market-data/provider';

import type { DateRange } from './coverage';

/**
 * Coverage-discipline tests for `syncDailyHistory`, run against a fake IO —
 * the injectable seam exists precisely so this logic is testable without
 * mocking Drizzle chains. The framework boundaries are stubbed out only so
 * the module can be imported at all.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  db: {},
  priceHistoryCoverage: {},
  priceSnapshots: {},
}));
vi.mock('@/lib/market-data/massive', () => ({ massiveProvider: {} }));

import {
  repairMissingOhlc,
  syncDailyHistory,
  type DailyBarRow,
  type OhlcUpdateRow,
  type PriceHistoryIO,
} from './price-history';

const INSTRUMENT = { id: 'inst-1', symbol: 'AAPL', currency: 'USD' };

/**
 * An instant far past every window in these tests (Mon 2026-08-31 has closed),
 * so the completed-session clamp never interferes with the coverage-discipline
 * cases — the clamp has its own describe block below.
 */
const AFTER_ALL_SESSIONS = Date.parse('2026-09-01T00:00:00Z');

/** A daily candle whose bar-start lands on the given NY calendar date. */
function candleOn(dateISO: string, close: string): Candle {
  // 12:00 UTC is 07:00/08:00 ET — safely the same NY calendar date.
  return {
    t: Date.parse(`${dateISO}T12:00:00Z`),
    open: close,
    high: close,
    low: close,
    close,
    volume: '100',
  };
}

/** The bar row candleOn's candle persists as — OHLV rides along the close. */
function barRow(dateISO: string, close: string): DailyBarRow {
  return { asOf: dateISO, close, open: close, high: close, low: close, volume: '100' };
}

/** A pre-OHLV row: close only, the columns null (saved before the migration). */
function legacyRow(dateISO: string, close: string): DailyBarRow {
  return { asOf: dateISO, close, open: null, high: null, low: null, volume: null };
}

/** In-memory fake of the IO seam, recording every call. */
function fakeIO(initialCoverage: DateRange | null) {
  let coverage = initialCoverage;
  const stored: DailyBarRow[] = [];
  const fetched: DateRange[] = [];
  const ohlcUpdates: OhlcUpdateRow[] = [];
  let fetchImpl: (symbol: string, range: DateRange) => Promise<Candle[]> = async () => [];

  const io: PriceHistoryIO = {
    readCoverage: async () => coverage,
    writeCoverage: async (_id, range) => {
      coverage = range;
    },
    readBars: async () => stored,
    writeBars: async (_id, rows) => {
      stored.push(...rows);
    },
    updateNullOhlc: async (_id, rows) => {
      // The real IO's semantics: fill OHLV where open IS NULL, never close.
      ohlcUpdates.push(...rows);
      for (const update of rows) {
        const row = stored.find((r) => r.asOf === update.asOf);
        if (row && row.open === null) {
          row.open = update.open;
          row.high = update.high;
          row.low = update.low;
          row.volume = update.volume;
        }
      }
    },
    fetchDailyCandles: (symbol, range) => {
      fetched.push(range);
      return fetchImpl(symbol, range);
    },
  };

  return {
    io,
    get coverage() {
      return coverage;
    },
    stored,
    fetched,
    ohlcUpdates,
    setFetch(impl: typeof fetchImpl) {
      fetchImpl = impl;
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('syncDailyHistory — coverage discipline', () => {
  it('fully covered → zero provider requests', async () => {
    const fake = fakeIO({ from: '2026-07-01', to: '2026-08-10' });
    await syncDailyHistory(fake.io, INSTRUMENT, { from: '2026-07-10', to: '2026-08-01' }, AFTER_ALL_SESSIONS);
    expect(fake.fetched).toEqual([]);
  });

  it('stores fetched bars and extends coverage after a successful hole', async () => {
    const fake = fakeIO(null);
    fake.setFetch(async () => [candleOn('2026-08-10', '231.59'), candleOn('2026-08-11', '233.1')]);

    await syncDailyHistory(fake.io, INSTRUMENT, { from: '2026-08-10', to: '2026-08-11' }, AFTER_ALL_SESSIONS);

    // OHLV persisted ALONGSIDE the close — the bar write carries all five.
    expect(fake.stored).toEqual([barRow('2026-08-10', '231.59'), barRow('2026-08-11', '233.1')]);
    expect(fake.coverage).toEqual({ from: '2026-08-10', to: '2026-08-11' });
  });

  it('a provider failure mid-hole leaves coverage untouched — the next read retries', async () => {
    const fake = fakeIO({ from: '2026-08-01', to: '2026-08-10' });
    fake.setFetch(async () => {
      throw new Error('HTTP 502');
    });

    await syncDailyHistory(fake.io, INSTRUMENT, { from: '2026-07-01', to: '2026-08-10' }, AFTER_ALL_SESSIONS);

    expect(fake.fetched).toEqual([{ from: '2026-07-01', to: '2026-07-31' }]);
    expect(fake.coverage).toEqual({ from: '2026-08-01', to: '2026-08-10' });
    expect(fake.stored).toEqual([]);

    // The retry succeeds and only then does coverage extend.
    fake.setFetch(async () => [candleOn('2026-07-15', '100')]);
    await syncDailyHistory(fake.io, INSTRUMENT, { from: '2026-07-01', to: '2026-08-10' }, AFTER_ALL_SESSIONS);
    expect(fake.coverage).toEqual({ from: '2026-07-01', to: '2026-08-10' });
  });

  it('a store failure also leaves coverage untouched — never extended over unstored days', async () => {
    const fake = fakeIO(null);
    fake.setFetch(async () => [candleOn('2026-08-10', '231.59')]);
    fake.io.writeBars = async () => {
      throw new Error('db write failed');
    };

    await syncDailyHistory(fake.io, INSTRUMENT, { from: '2026-08-10', to: '2026-08-11' }, AFTER_ALL_SESSIONS);
    expect(fake.coverage).toBeNull();
  });

  it('an empty response (non-US instrument) still extends coverage — asked, and there is nothing', async () => {
    const fake = fakeIO(null);
    fake.setFetch(async () => []);

    const wanted = { from: '2026-07-01', to: '2026-08-10' };
    await syncDailyHistory(fake.io, { id: 'i2', symbol: 'CDR.WA', currency: 'USD' }, wanted, AFTER_ALL_SESSIONS);

    expect(fake.fetched).toEqual([wanted]);
    expect(fake.coverage).toEqual(wanted);

    // Second entry over the same window: zero provider requests.
    fake.fetched.length = 0;
    await syncDailyHistory(fake.io, { id: 'i2', symbol: 'CDR.WA', currency: 'USD' }, wanted, AFTER_ALL_SESSIONS);
    expect(fake.fetched).toEqual([]);
  });

  it('fills a two-sided want with one request per hole', async () => {
    const fake = fakeIO({ from: '2026-07-01', to: '2026-08-01' });
    fake.setFetch(async () => [candleOn('2026-06-15', '90')]);

    await syncDailyHistory(fake.io, INSTRUMENT, { from: '2026-06-01', to: '2026-08-10' }, AFTER_ALL_SESSIONS);

    expect(fake.fetched).toEqual([
      { from: '2026-06-01', to: '2026-06-30' },
      { from: '2026-08-02', to: '2026-08-10' },
    ]);
    expect(fake.coverage).toEqual({ from: '2026-06-01', to: '2026-08-10' });
  });
});

describe('syncDailyHistory — completed-session clamp', () => {
  // Tue 2026-08-11, 11:00 ET — the regular session is RUNNING.
  const MID_SESSION = Date.parse('2026-08-11T15:00:00Z');
  // Tue 2026-08-11, 17:00 ET — the session has closed.
  const AFTER_CLOSE = Date.parse('2026-08-11T21:00:00Z');

  it('a window ending today mid-session covers only through the last completed session, and the next call after the close pulls the missing day', async () => {
    const fake = fakeIO({ from: '2026-08-03', to: '2026-08-07' });
    fake.setFetch(async () => [candleOn('2026-08-10', '100')]);

    const wanted = { from: '2026-08-03', to: '2026-08-11' };
    await syncDailyHistory(fake.io, INSTRUMENT, wanted, MID_SESSION);

    // Asked only through Monday the 10th — Tuesday's close does not exist yet,
    // and coverage NEVER claims a day whose session has not completed.
    expect(fake.fetched).toEqual([{ from: '2026-08-08', to: '2026-08-10' }]);
    expect(fake.coverage).toEqual({ from: '2026-08-03', to: '2026-08-10' });

    // After the bell, the SAME window fetches exactly the day that was held back.
    fake.fetched.length = 0;
    fake.setFetch(async () => [candleOn('2026-08-11', '101')]);
    await syncDailyHistory(fake.io, INSTRUMENT, wanted, AFTER_CLOSE);
    expect(fake.fetched).toEqual([{ from: '2026-08-11', to: '2026-08-11' }]);
    expect(fake.coverage).toEqual({ from: '2026-08-03', to: '2026-08-11' });
    expect(fake.stored).toContainEqual(barRow('2026-08-11', '101'));
  });

  it('a gap entirely past the last completed session is not asked at all', async () => {
    const fake = fakeIO({ from: '2026-08-03', to: '2026-08-10' });
    await syncDailyHistory(
      fake.io,
      INSTRUMENT,
      { from: '2026-08-03', to: '2026-08-11' },
      MID_SESSION,
    );
    expect(fake.fetched).toEqual([]);
    expect(fake.coverage).toEqual({ from: '2026-08-03', to: '2026-08-10' });
  });

  it('never persists an in-progress bar the vendor tacked past the clamp', async () => {
    const fake = fakeIO(null);
    fake.setFetch(async () => [candleOn('2026-08-10', '100'), candleOn('2026-08-11', '99.5')]);

    await syncDailyHistory(
      fake.io,
      INSTRUMENT,
      { from: '2026-08-10', to: '2026-08-11' },
      MID_SESSION,
    );

    // The still-appending Tuesday bar is filtered — freezing it would make the
    // eventual FINAL close an onConflictDoNothing no-op forever.
    expect(fake.stored).toEqual([barRow('2026-08-10', '100')]);
    expect(fake.coverage).toEqual({ from: '2026-08-10', to: '2026-08-10' });
  });

  it('a weekend now clamps to Friday — the empty-answer rule is unaffected', async () => {
    // Sat 2026-08-15, 12:00 UTC.
    const SATURDAY = Date.parse('2026-08-15T12:00:00Z');
    const fake = fakeIO(null);
    fake.setFetch(async () => []);

    await syncDailyHistory(
      fake.io,
      INSTRUMENT,
      { from: '2026-08-10', to: '2026-08-15' },
      SATURDAY,
    );

    expect(fake.fetched).toEqual([{ from: '2026-08-10', to: '2026-08-14' }]);
    expect(fake.coverage).toEqual({ from: '2026-08-10', to: '2026-08-14' });
  });
});

describe('repairMissingOhlc — the one-off OHLV top-up', () => {
  const RANGE = { from: '2026-08-01', to: '2026-08-12' };

  it('fills OHLV on null rows only, never touching close or coverage', async () => {
    const fake = fakeIO({ from: '2026-08-01', to: '2026-08-12' });
    // Two legacy rows (pre-migration) around one already-full row.
    fake.stored.push(
      legacyRow('2026-08-10', '231.59'),
      barRow('2026-08-11', '233.1'),
      legacyRow('2026-08-12', '235'),
    );
    // The vendor re-serves the span — with a DIFFERENT close for the 10th,
    // which must NOT overwrite the stored one (immutability doctrine).
    fake.setFetch(async () => [
      candleOn('2026-08-10', '231.60'),
      candleOn('2026-08-11', '233.1'),
      candleOn('2026-08-12', '235'),
    ]);

    const repaired = await repairMissingOhlc(fake.io, INSTRUMENT, RANGE);

    expect(repaired).toBe(2);
    // ONE fetch spanning exactly the null rows.
    expect(fake.fetched).toEqual([{ from: '2026-08-10', to: '2026-08-12' }]);
    // Updates were issued ONLY for the two null rows — the full row was
    // never in the update set (the WHERE open IS NULL guard's test half).
    expect(fake.ohlcUpdates.map((u) => u.asOf)).toEqual(['2026-08-10', '2026-08-12']);
    // The stored close survives verbatim; OHLV filled from the fresh candle.
    const repairedRow = fake.stored.find((r) => r.asOf === '2026-08-10')!;
    expect(repairedRow.close).toBe('231.59');
    expect(repairedRow.open).toBe('231.60');
    // Coverage untouched — the repair never extends or shrinks it.
    expect(fake.coverage).toEqual({ from: '2026-08-01', to: '2026-08-12' });
  });

  it('no null rows → zero fetches, zero updates', async () => {
    const fake = fakeIO(RANGE);
    fake.stored.push(barRow('2026-08-10', '231.59'));

    expect(await repairMissingOhlc(fake.io, INSTRUMENT, RANGE)).toBe(0);
    expect(fake.fetched).toEqual([]);
    expect(fake.ohlcUpdates).toEqual([]);
  });

  it('a provider failure degrades to 0 — never a throw, coverage untouched', async () => {
    const fake = fakeIO(RANGE);
    fake.stored.push(legacyRow('2026-08-10', '231.59'));
    fake.setFetch(async () => {
      throw new Error('HTTP 502');
    });

    expect(await repairMissingOhlc(fake.io, INSTRUMENT, RANGE)).toBe(0);
    expect(fake.stored[0]).toEqual(legacyRow('2026-08-10', '231.59'));
    expect(fake.coverage).toEqual(RANGE);
  });
});
