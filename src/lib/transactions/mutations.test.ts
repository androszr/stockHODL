import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unique cases from the deleted transaction Server Actions: the instrument
 * lock, the affected-row check, and `decimal.js` scaling of every numeric
 * written to the `set` payload. Input is already-validated `TransactionInput`
 * — no FormData, no `redirect()`.
 */

const h = vi.hoisted(() => ({
  /** transactions ⋈ portfolios ⋈ instruments load of the existing row. */
  joinedWhere: vi.fn(),
  /** Plain select().from().where() — the target-portfolio ownership check
   *  (awaited) and the update's ownership subquery (never awaited). */
  selectWhere: vi.fn(),
  updateSet: vi.fn(),
  updateReturning: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
}));
vi.mock('@/lib/analytics/view', () => ({ invalidateAnalyticsMemo: vi.fn() }));
vi.mock('@/lib/day-report/view', () => ({ invalidateDayReportMemo: vi.fn() }));
vi.mock('@/lib/history/portfolio-series', () => ({
  invalidatePortfolioSeriesMemo: vi.fn(),
}));
vi.mock('@/lib/instruments/resolve', () => ({ resolveOrCreateInstrument: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: h.selectWhere,
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({ where: h.joinedWhere })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        h.updateSet(values);
        return { where: vi.fn(() => ({ returning: h.updateReturning })) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn(), returning: vi.fn() })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  },
  portfolios: { id: 'id', userId: 'user_id' },
  instruments: { id: 'id', symbol: 'symbol', currency: 'currency' },
  transactions: { id: 'id', portfolioId: 'portfolio_id' },
}));

import { db } from '@/lib/db';
import { dec, toNumeric } from '@/lib/money';
import { updateTransaction } from '@/lib/transactions/mutations';
import { transactionInputSchema, type TransactionInput } from '@/lib/validation';

const TX_ID = '7f1e0a54-3c1e-4d5f-9b2a-1c2d3e4f5a6b';
const PORTFOLIO_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const INSTRUMENT_ID = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';

function txInput(overrides: Record<string, string> = {}): TransactionInput {
  return transactionInputSchema.parse({
    portfolioId: PORTFOLIO_ID,
    side: 'buy',
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    quantity: '10',
    price: '150.25',
    fees: '1.5',
    tradeDate: '2026-08-03',
    fxRateToBase: '4.05',
    note: '',
    ...overrides,
  });
}

/** The stored row as the ownership-scoped joined load returns it. */
function storedRow(overrides: Record<string, string> = {}) {
  return {
    instrumentId: INSTRUMENT_ID,
    symbol: 'AAPL',
    currency: 'USD',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateTransaction — gates before the write', () => {
  it('reports "not found" when the row is missing or not the user\'s', () => {
    h.joinedWhere.mockResolvedValue([]);
    return expect(updateTransaction('user-1', TX_ID, txInput())).resolves.toEqual({
      ok: false,
      error: 'Transaction not found.',
    });
  });
});

describe('updateTransaction — the instrument lock', () => {
  it('refuses a symbol change and never calls update', async () => {
    h.joinedWhere.mockResolvedValue([storedRow({ symbol: 'MSFT' })]);

    const result = await updateTransaction('user-1', TX_ID, txInput());
    expect(result).toEqual({
      ok: false,
      error: "The instrument can't be changed — delete this transaction and add a new one.",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses a currency change and never calls update', async () => {
    h.joinedWhere.mockResolvedValue([storedRow({ currency: 'EUR' })]);

    const result = await updateTransaction('user-1', TX_ID, txInput());
    expect(result).toEqual({
      ok: false,
      error: "The instrument can't be changed — delete this transaction and add a new one.",
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('updateTransaction — target portfolio ownership', () => {
  it('reports "Portfolio not found." for a portfolio the user does not own', async () => {
    h.joinedWhere.mockResolvedValue([storedRow()]);
    h.selectWhere.mockResolvedValue([]);

    await expect(updateTransaction('user-1', TX_ID, txInput())).resolves.toEqual({
      ok: false,
      error: 'Portfolio not found.',
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('updateTransaction — the write', () => {
  beforeEach(() => {
    h.joinedWhere.mockResolvedValue([storedRow()]);
    h.selectWhere.mockResolvedValue([{ id: PORTFOLIO_ID }]);
  });

  it('reports "not found" when the ownership-scoped update touched no row', () => {
    h.updateReturning.mockResolvedValue([]);
    return expect(updateTransaction('user-1', TX_ID, txInput())).resolves.toEqual({
      ok: false,
      error: 'Transaction not found.',
    });
  });

  it('writes toNumeric-scaled strings for every numeric', async () => {
    h.updateReturning.mockResolvedValue([{ id: TX_ID }]);

    const input = txInput({ note: 'broker fix' });
    await updateTransaction('user-1', TX_ID, input);

    expect(h.updateSet).toHaveBeenCalledExactlyOnceWith({
      portfolioId: PORTFOLIO_ID,
      side: 'buy',
      quantity: toNumeric(dec('10')),
      price: toNumeric(dec('150.25')),
      fees: toNumeric(dec('1.5')),
      tradeDate: '2026-08-03',
      fxRateToBase: toNumeric(dec('4.05'), 10),
      note: 'broker fix',
    });
  });

  it('forces the PLN rate to 1 regardless of any client-sent value', async () => {
    h.joinedWhere.mockResolvedValue([storedRow({ currency: 'PLN' })]);
    h.updateReturning.mockResolvedValue([{ id: TX_ID }]);

    const input = txInput({ currency: 'PLN', fxRateToBase: '9.99' });
    await updateTransaction('user-1', TX_ID, input);

    expect(h.updateSet).toHaveBeenCalledTimes(1);
    expect(h.updateSet.mock.calls[0][0]).toMatchObject({
      fxRateToBase: toNumeric(dec('1'), 10),
      note: null,
    });
  });
});
