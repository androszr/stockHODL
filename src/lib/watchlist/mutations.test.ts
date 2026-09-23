import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unique cases from the deleted watchlist Server Actions: the shared
 * instrument-field rules, and the pass-through of a resolve refusal.
 */

const h = vi.hoisted(() => ({
  resolveOrCreateInstrument: vi.fn(),
  insertValues: vi.fn(),
  onConflictDoNothing: vi.fn(),
  deleteWhere: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  asc: vi.fn(),
}));
vi.mock('@/lib/instruments/resolve', () => ({
  resolveOrCreateInstrument: h.resolveOrCreateInstrument,
}));
vi.mock('@/lib/trend/load', () => ({ fetchTrendsBestEffort: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        h.insertValues(values);
        return { onConflictDoNothing: h.onConflictDoNothing };
      }),
    })),
    delete: vi.fn(() => ({ where: h.deleteWhere })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn() })),
        })),
      })),
    })),
  },
  watchlist: { userId: 'user_id', instrumentId: 'instrument_id' },
  instruments: { id: 'id' },
}));

import { addToWatchlist, removeFromWatchlist } from '@/lib/watchlist/mutations';
import { watchlistAddSchema } from '@/lib/validation';

const INSTRUMENT_ID = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';

function addInput(overrides: Record<string, string> = {}) {
  return {
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveOrCreateInstrument.mockResolvedValue({
    ok: true,
    id: INSTRUMENT_ID,
    currency: 'USD',
  });
});

describe('watchlistAddSchema — shared instrument-field rules', () => {
  it('refuses an unsupported currency by name', () => {
    const parsed = watchlistAddSchema.safeParse(addInput({ currency: 'JPY' }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe('Unsupported currency');
    }
  });

  it('refuses an over-long symbol', () => {
    expect(watchlistAddSchema.safeParse(addInput({ symbol: 'X'.repeat(21) })).success).toBe(
      false,
    );
  });

  it('normalizes the symbol (trim + uppercase)', () => {
    expect(watchlistAddSchema.parse(addInput({ symbol: '  aapl ' })).symbol).toBe('AAPL');
  });
});

describe('addToWatchlist — gates before the write', () => {
  it('passes a resolve refusal (currency mismatch) through verbatim', async () => {
    h.resolveOrCreateInstrument.mockResolvedValue({
      ok: false,
      error: 'AAPL already exists as USD — pick that currency or use a different symbol.',
    });
    await expect(
      addToWatchlist('user-1', watchlistAddSchema.parse(addInput({ currency: 'EUR' }))),
    ).resolves.toEqual({
      ok: false,
      error: 'AAPL already exists as USD — pick that currency or use a different symbol.',
    });
    expect(h.insertValues).not.toHaveBeenCalled();
  });
});

describe('addToWatchlist — the write', () => {
  it('inserts the user id + resolved instrument id, do-nothing on conflict', async () => {
    await expect(
      addToWatchlist('user-1', watchlistAddSchema.parse(addInput())),
    ).resolves.toEqual({ ok: true });
    expect(h.insertValues).toHaveBeenCalledWith({
      userId: 'user-1',
      instrumentId: INSTRUMENT_ID,
    });
    expect(h.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});

describe('removeFromWatchlist', () => {
  it('deletes scoped to the user', async () => {
    await expect(removeFromWatchlist('user-1', INSTRUMENT_ID)).resolves.toEqual({ ok: true });
    expect(h.deleteWhere).toHaveBeenCalledTimes(1);
  });
});
