import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The targets store's three load-bearing rules, over a mocked db (the
 * `portfolios/mutations.test.ts` arrangement — nothing here touches Neon):
 *
 *  1. ownership FIRST, and a foreign portfolio writes NOTHING;
 *  2. the rewrite is ONE `db.batch`, delete + inserts, never sequential
 *     awaits — a delete that landed alone would wipe every target;
 *  3. a save invalidates the analytics memo, or the drift card serves
 *     pre-save figures for the memo's whole TTL.
 */

const h = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  selectCalls: [] as string[],
  batch: vi.fn(),
  insertValues: vi.fn(),
  deleteCalls: vi.fn(),
  invalidate: vi.fn(),
}));

function nextSelect(table: string) {
  h.selectCalls.push(table);
  return h.selectResults.shift() ?? [];
}

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@/lib/analytics/view', () => ({ invalidateAnalyticsMemo: h.invalidate }));
vi.mock('@/lib/db', () => {
  const chain = (table: string) => {
    const thenable = {
      innerJoin: vi.fn(() => thenable),
      where: vi.fn(() => thenable),
      orderBy: vi.fn(() => thenable),
      limit: vi.fn(() => thenable),
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(nextSelect(table)).then(resolve),
    };
    return thenable;
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: { __name?: string }) => chain(table.__name ?? '?')),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => ({ __stmt: 'delete' })) })),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          h.insertValues(values);
          return { __stmt: 'insert' };
        }),
      })),
      batch: h.batch,
    },
    portfolios: { __name: 'portfolios', id: 'id', userId: 'user_id' },
    instruments: { __name: 'instruments', id: 'id', symbol: 'symbol' },
    portfolioTargets: {
      __name: 'portfolio_targets',
      portfolioId: 'portfolio_id',
      instrumentId: 'instrument_id',
      targetPct: 'target_pct',
      createdAt: 'created_at',
    },
  };
});

import {
  getTargets,
  PORTFOLIO_NOT_FOUND,
  replaceTargets,
  UNKNOWN_INSTRUMENT,
} from './store';

const USER = 'user-1';
const PORTFOLIO = '7f1e0a54-3c1e-4d5f-9b2a-1c2d3e4f5a6b';
const AAPL = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MSFT = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';

/** The ownership select answers a row: this user owns the portfolio. */
const owned = [{ id: PORTFOLIO }];

beforeEach(() => {
  vi.clearAllMocks();
  h.selectResults = [];
  h.selectCalls = [];
});

describe('getTargets', () => {
  it('answers "not found" for a foreign portfolio, and reads no targets at all', async () => {
    h.selectResults = [[]]; // the ownership select finds nothing

    await expect(getTargets(USER, PORTFOLIO)).resolves.toEqual({
      ok: false,
      error: PORTFOLIO_NOT_FOUND,
    });
    // Only the ownership select ran — a foreign id never reaches the rows.
    expect(h.selectCalls).toEqual(['portfolios']);
  });

  it('re-normalises the numeric padding so the wire carries "30", not "30.0000"', async () => {
    h.selectResults = [owned, [{ instrumentId: AAPL, symbol: 'AAPL', targetPct: '30.0000' }]];

    await expect(getTargets(USER, PORTFOLIO)).resolves.toEqual({
      ok: true,
      rows: [{ instrumentId: AAPL, symbol: 'AAPL', targetPct: '30' }],
    });
  });

  it('carries the SYMBOL for every stored target, so the edit sheet can show a row the cached analytics payload never listed', async () => {
    // Without this the sheet's row set is only what the (stale) drift
    // payload named, and a bulk-replace save would delete this target
    // silently.
    h.selectResults = [owned, [{ instrumentId: MSFT, symbol: 'MSFT', targetPct: '20.5000' }]];

    const result = await getTargets(USER, PORTFOLIO);

    expect(result).toEqual({
      ok: true,
      rows: [{ instrumentId: MSFT, symbol: 'MSFT', targetPct: '20.5' }],
    });
  });

  it('answers an EMPTY list for an owned portfolio with no targets — a different statement from not-found', async () => {
    h.selectResults = [owned, []];

    await expect(getTargets(USER, PORTFOLIO)).resolves.toEqual({ ok: true, rows: [] });
  });
});

describe('replaceTargets', () => {
  it('refuses a foreign portfolio BEFORE writing anything', async () => {
    h.selectResults = [[]];

    await expect(
      replaceTargets(USER, PORTFOLIO, [{ instrumentId: AAPL, targetPct: '30' }]),
    ).resolves.toEqual({ ok: false, error: PORTFOLIO_NOT_FOUND });

    expect(h.batch).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('refuses an unknown instrument instead of surfacing an FK violation as a 500', async () => {
    h.selectResults = [owned, [{ id: AAPL }]]; // only one of the two exists

    await expect(
      replaceTargets(USER, PORTFOLIO, [
        { instrumentId: AAPL, targetPct: '30' },
        { instrumentId: MSFT, targetPct: '20' },
      ]),
    ).resolves.toEqual({ ok: false, error: UNKNOWN_INSTRUMENT });

    expect(h.batch).not.toHaveBeenCalled();
  });

  it('rewrites in ONE batch — delete then inserts — and invalidates the analytics memo', async () => {
    h.selectResults = [owned, [{ id: AAPL }, { id: MSFT }]];

    await expect(
      replaceTargets(USER, PORTFOLIO, [
        { instrumentId: AAPL, targetPct: '30' },
        { instrumentId: MSFT, targetPct: '20.5' },
      ]),
    ).resolves.toEqual({ ok: true });

    expect(h.batch).toHaveBeenCalledTimes(1);
    // The delete and the inserts travel together or not at all: a delete
    // that landed alone would wipe every target on a flaky save.
    expect(h.batch.mock.calls[0][0]).toEqual([{ __stmt: 'delete' }, { __stmt: 'insert' }]);
    expect(h.insertValues).toHaveBeenCalledWith([
      { portfolioId: PORTFOLIO, instrumentId: AAPL, targetPct: '30.0000' },
      { portfolioId: PORTFOLIO, instrumentId: MSFT, targetPct: '20.5000' },
    ]);
    expect(h.invalidate).toHaveBeenCalledWith(USER);
  });

  it('clears every target with a delete-only batch — an empty save is legal, and never a row of zeros', async () => {
    h.selectResults = [owned];

    await expect(replaceTargets(USER, PORTFOLIO, [])).resolves.toEqual({ ok: true });

    // The delete keeps the batch tuple non-empty; no instrument check is
    // needed because there is nothing to check.
    expect(h.batch).toHaveBeenCalledWith([{ __stmt: 'delete' }]);
    expect(h.insertValues).not.toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalledWith(USER);
  });
});
