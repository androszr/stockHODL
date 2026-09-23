import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unique cases from the deleted portfolio Server Actions: the unique-violation
 * cause-chain walk (`db-errors.ts`) and the affected-row-count checks.
 */

const h = vi.hoisted(() => ({
  updateReturning: vi.fn(),
  updateSet: vi.fn(),
  deleteReturning: vi.fn(),
  insertValues: vi.fn(),
  selectWhere: vi.fn(),
  batch: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  max: vi.fn(),
  count: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        h.updateSet(values);
        return {
          where: vi.fn(() => ({ returning: h.updateReturning })),
        };
      }),
    })),
    batch: h.batch,
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: h.deleteReturning })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => ({ returning: () => h.insertValues(values) })),
    })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: h.selectWhere })) })),
  },
  portfolios: {
    id: 'id',
    userId: 'user_id',
    name: 'name',
    sortOrder: 'sort_order',
    createdAt: 'created_at',
  },
  transactions: { id: 'id', portfolioId: 'portfolio_id' },
}));

import {
  createPortfolio,
  deletePortfolio,
  renamePortfolio,
  reorderPortfolios,
} from '@/lib/portfolios/mutations';

const UUID = '7f1e0a54-3c1e-4d5f-9b2a-1c2d3e4f5a6b';
const UUID_B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const UUID_C = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('renamePortfolio — affected-row check', () => {
  it('reports "not found" for a stale id instead of a phantom success', () => {
    h.updateReturning.mockResolvedValue([]);
    return expect(renamePortfolio('user-1', UUID, 'Growth')).resolves.toEqual({
      ok: false,
      error: 'Portfolio not found.',
    });
  });

  it('reports ok when a row was actually renamed', () => {
    h.updateReturning.mockResolvedValue([{ id: UUID }]);
    return expect(renamePortfolio('user-1', UUID, 'Growth')).resolves.toEqual({
      ok: true,
    });
  });
});

describe('deletePortfolio — affected-row check', () => {
  it('reports "not found" when nothing was deleted', () => {
    h.deleteReturning.mockResolvedValue([]);
    return expect(deletePortfolio('user-1', UUID)).resolves.toEqual({
      ok: false,
      error: 'Portfolio not found.',
    });
  });

  it('reports ok when a row was actually deleted', () => {
    h.deleteReturning.mockResolvedValue([{ id: UUID }]);
    return expect(deletePortfolio('user-1', UUID)).resolves.toEqual({ ok: true });
  });
});

describe('createPortfolio — unique violation mapping', () => {
  it('maps a drizzle-wrapped 23505 to a friendly field error, not a crash', async () => {
    h.selectWhere.mockResolvedValue([{ value: 2 }]);
    // The real shape: DrizzleQueryError wrapper, Postgres code on the cause.
    h.insertValues.mockRejectedValue(
      Object.assign(new Error('Failed query'), {
        query: 'insert into "portfolios" ...',
        params: [],
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      }),
    );

    const result = await createPortfolio('user-1', 'IKE');
    expect(result).toEqual({ ok: false, error: 'A portfolio named “IKE” already exists.' });
  });

  it('returns the new id, so the caller can select the new scope', async () => {
    h.selectWhere.mockResolvedValue([{ value: 2 }]);
    h.insertValues.mockResolvedValue([{ id: UUID }]);

    // Appending after the highest existing sortOrder is what keeps the new
    // chip at the END of the row rather than silently tying for a slot.
    expect(await createPortfolio('user-1', 'IKE')).toEqual({ ok: true, id: UUID });
    expect(h.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'IKE', sortOrder: 3 }),
    );
  });
});

describe('reorderPortfolios — the drag-and-drop commit', () => {
  it('rewrites sortOrder to the submitted index, in one batch', async () => {
    h.selectWhere.mockResolvedValue([{ id: UUID }, { id: UUID_B }, { id: UUID_C }]);

    const result = await reorderPortfolios('user-1', [UUID_C, UUID, UUID_B]);

    expect(result).toEqual({ ok: true });
    expect(h.updateSet.mock.calls.map(([v]) => v)).toEqual([
      { sortOrder: 0 },
      { sortOrder: 1 },
      { sortOrder: 2 },
    ]);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(h.batch.mock.calls[0][0]).toHaveLength(3);
  });

  it('refuses a list that is not exactly the user’s set — no partial rewrite', async () => {
    h.selectWhere.mockResolvedValue([{ id: UUID }, { id: UUID_B }, { id: UUID_C }]);

    await expect(reorderPortfolios('user-1', [UUID_C, UUID])).resolves.toEqual({
      ok: false,
      error: 'Portfolio list changed — reload and try again.',
    });
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('refuses an id the user does not own', async () => {
    h.selectWhere.mockResolvedValue([{ id: UUID }, { id: UUID_B }]);

    await expect(reorderPortfolios('user-1', [UUID, UUID_C])).resolves.toEqual({
      ok: false,
      error: 'Portfolio list changed — reload and try again.',
    });
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('refuses a duplicated id, which would collapse two rows onto one index', async () => {
    await expect(reorderPortfolios('user-1', [UUID, UUID])).resolves.toEqual({
      ok: false,
      error: 'Invalid request.',
    });
    expect(h.batch).not.toHaveBeenCalled();
  });
});
