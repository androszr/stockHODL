import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store's DECISIONS, tested with the framework and database boundaries
 * mocked out (the `transactions/actions.test.ts` pattern). What is real: the
 * overwrite-protection rule (`planFetchedWrite` — the tax-record guarantee's
 * single decision point), the routing of fetched rows into
 * insert/update/skip, the SQL re-assertion of the rule on the update path,
 * the decimal.js scaling of every numeric written, and the ownership filter
 * shape on the list read.
 */

const h = vi.hoisted(() => ({
  /** select().from().where() — the upsert's existing-rows read + the
   *  portfolio-ownership read (and, un-awaited, the ownership subquery). */
  selectWhere: vi.fn(),
  /** select().from().innerJoin().where() — updatePayment's current-row read. */
  joinedWhere: vi.fn(),
  /** select().from().innerJoin().innerJoin().where().orderBy() — the list. */
  orderBy: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  /** What every UPDATE ... RETURNING resolves — per-test routing decisions. */
  updateReturning: vi.fn(async (): Promise<{ id: string }[]> => [{ id: 'row-1' }]),
  insertValues: vi.fn(),
  onConflictDoNothing: vi.fn(),
  deleteWhere: vi.fn(),
  deleteReturning: vi.fn(async (): Promise<{ id: string }[]> => []),
}));

vi.mock('server-only', () => ({}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  desc: vi.fn((column: unknown) => ({ op: 'desc', column })),
  eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
  inArray: vi.fn((column: unknown, values: unknown) => ({ op: 'inArray', column, values })),
  isNotNull: vi.fn((column: unknown) => ({ op: 'isNotNull', column })),
}));
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: h.selectWhere,
        innerJoin: vi.fn(() => ({
          where: h.joinedWhere,
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ orderBy: h.orderBy })),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        h.updateSet(values);
        return {
          where: vi.fn((condition: unknown) => {
            h.updateWhere(condition);
            return { returning: h.updateReturning };
          }),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        h.insertValues(values);
        return { onConflictDoNothing: h.onConflictDoNothing };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        h.deleteWhere(condition);
        return { returning: h.deleteReturning };
      }),
    })),
  },
  dividendPayments: {
    id: 'dp.id',
    portfolioId: 'dp.portfolio_id',
    instrumentId: 'dp.instrument_id',
    vendorEventId: 'dp.vendor_event_id',
    exDate: 'dp.ex_date',
    payDate: 'dp.pay_date',
    quantity: 'dp.quantity',
    amountPerShare: 'dp.amount_per_share',
    grossAmount: 'dp.gross_amount',
    withheldTax: 'dp.withheld_tax',
    currency: 'dp.currency',
    fxRateToBase: 'dp.fx_rate_to_base',
    source: 'dp.source',
    edited: 'dp.edited',
    deleted: 'dp.deleted',
    note: 'dp.note',
    createdAt: 'dp.created_at',
    updatedAt: 'dp.updated_at',
  },
  portfolios: { id: 'p.id', userId: 'p.user_id', name: 'p.name' },
  instruments: { id: 'i.id', symbol: 'i.symbol', displayName: 'i.display_name' },
}));

import { eq } from 'drizzle-orm';

import {
  deletePayment,
  listDividendPayments,
  planFetchedWrite,
  updatePayment,
  upsertFetchedPayments,
  type FetchedPaymentInput,
  type PaymentUpdateInput,
} from './store';

function fetched(overrides: Partial<FetchedPaymentInput> = {}): FetchedPaymentInput {
  return {
    portfolioId: 'port-1',
    instrumentId: 'inst-1',
    vendorEventId: 'E1',
    exDate: '2026-08-10',
    payDate: '2026-08-13',
    quantity: '10',
    amountPerShare: '0.27',
    grossAmount: '2.7',
    withheldTax: '0.405',
    currency: 'USD',
    fxRateToBase: '3.65',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Explicit defaults every test starts from — a per-test override must
  // never leak into the next test through clearAllMocks' kept impls.
  h.updateReturning.mockResolvedValue([{ id: 'row-1' }]);
  h.deleteReturning.mockResolvedValue([]);
});

describe('planFetchedWrite — the overwrite-protection matrix', () => {
  it('inserts when nothing exists for the (vendor event, portfolio) pair', () => {
    expect(planFetchedWrite(undefined)).toBe('insert');
  });

  it('updates a massive-sourced, unedited row — the self-heal path', () => {
    expect(planFetchedWrite({ source: 'massive', edited: false, deleted: false })).toBe('update');
  });

  it('NEVER touches an edited row — the user correction wins', () => {
    expect(planFetchedWrite({ source: 'massive', edited: true, deleted: false })).toBe('skip');
  });

  it('NEVER touches a manual row, edited or not', () => {
    expect(planFetchedWrite({ source: 'manual', edited: false, deleted: false })).toBe('skip');
    expect(planFetchedWrite({ source: 'manual', edited: true, deleted: false })).toBe('skip');
  });

  it('a tombstone is skipped unconditionally — a deletion wins over a refetch', () => {
    // REGRESSION (2026-08-16 audit): before the tombstone, a deleted fetched
    // row vacated its key and planFetchedWrite(undefined) re-inserted it on
    // the next sync — "This can't be undone" was true in exactly the wrong
    // direction. The occupied key now routes here and stays deleted.
    expect(planFetchedWrite({ source: 'massive', edited: false, deleted: true })).toBe('skip');
    expect(planFetchedWrite({ source: 'massive', edited: true, deleted: true })).toBe('skip');
  });

  it('skips an unknown source rather than guessing it refreshable', () => {
    expect(planFetchedWrite({ source: 'other', edited: false, deleted: false })).toBe('skip');
  });
});

describe('upsertFetchedPayments — routing through the one rule', () => {
  it('inserts a new pair with toNumeric-scaled strings and the conflict guard', async () => {
    h.selectWhere.mockResolvedValue([]);

    await upsertFetchedPayments([fetched()]);

    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.insertValues).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        vendorEventId: 'E1',
        portfolioId: 'port-1',
        quantity: '10.00000000',
        amountPerShare: '0.27000000',
        grossAmount: '2.70000000',
        withheldTax: '0.40500000',
        fxRateToBase: '3.6500000000',
        source: 'massive',
        edited: false,
      }),
    ]);
    expect(h.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('updates an unedited massive row and re-asserts the rule in the WHERE', async () => {
    h.selectWhere.mockResolvedValue([
      {
        id: 'row-1',
        vendorEventId: 'E1',
        portfolioId: 'port-1',
        source: 'massive',
        edited: false,
        deleted: false,
      },
    ]);

    await upsertFetchedPayments([fetched({ quantity: '12', grossAmount: '3.24' })]);

    expect(h.insertValues).not.toHaveBeenCalled();
    expect(h.updateSet).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ quantity: '12.00000000', grossAmount: '3.24000000' }),
    );
    // The transactional half of the one rule: source/edited/deleted
    // re-checked in SQL, so a racing correction or delete still wins.
    const condition = h.updateWhere.mock.calls[0][0] as { conditions: unknown[] };
    expect(condition.conditions).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'dp.source', value: 'massive' },
        { op: 'eq', column: 'dp.edited', value: false },
        { op: 'eq', column: 'dp.deleted', value: false },
      ]),
    );
  });

  it('leaves edited and manual rows completely untouched', async () => {
    h.selectWhere.mockResolvedValue([
      {
        id: 'row-1',
        vendorEventId: 'E1',
        portfolioId: 'port-1',
        source: 'massive',
        edited: true,
        deleted: false,
      },
      {
        id: 'row-2',
        vendorEventId: 'E2',
        portfolioId: 'port-1',
        source: 'manual',
        edited: false,
        deleted: false,
      },
    ]);

    await upsertFetchedPayments([fetched(), fetched({ vendorEventId: 'E2' })]);

    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it('a tombstoned pair is neither re-inserted nor updated — the delete sticks', async () => {
    // REGRESSION (2026-08-16 audit, finding 1): the deleted row still holds
    // its (vendorEventId, portfolioId) key, so the recomputed event routes to
    // 'skip' instead of the fatal planFetchedWrite(undefined) → 'insert'.
    h.selectWhere.mockResolvedValue([
      {
        id: 'row-1',
        vendorEventId: 'E1',
        portfolioId: 'port-1',
        source: 'massive',
        edited: false,
        deleted: true,
      },
    ]);

    await upsertFetchedPayments([fetched()]);

    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it('a null fx rate is written as null, never a fake rate', async () => {
    h.selectWhere.mockResolvedValue([]);

    await upsertFetchedPayments([fetched({ fxRateToBase: null })]);

    expect(h.insertValues).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ fxRateToBase: null }),
    ]);
  });

  it('REGRESSION: a null fx on the self-heal update never erases the stored frozen rate', async () => {
    // A later sync whose FX lookup fails hands the store fxRateToBase: null.
    // Null is "no answer this run", not "no rate" — writing it would degrade
    // an already-frozen rate to absence until some future sync restored it.
    // The update must SKIP the column entirely.
    h.selectWhere.mockResolvedValue([
      {
        id: 'row-1',
        vendorEventId: 'E1',
        portfolioId: 'port-1',
        source: 'massive',
        edited: false,
        deleted: false,
      },
    ]);

    await upsertFetchedPayments([fetched({ fxRateToBase: null })]);

    expect(h.updateSet).toHaveBeenCalledTimes(1);
    const values = h.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect('fxRateToBase' in values).toBe(false);

    // A real (late-published) rate still flows through the same path.
    h.updateSet.mockClear();
    await upsertFetchedPayments([fetched({ fxRateToBase: '3.65' })]);
    expect(h.updateSet).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fxRateToBase: '3.6500000000' }),
    );
  });

  it('same vendor event across two portfolios routes independently', async () => {
    h.selectWhere.mockResolvedValue([
      {
        id: 'row-1',
        vendorEventId: 'E1',
        portfolioId: 'port-1',
        source: 'massive',
        edited: true,
        deleted: false,
      },
    ]);

    await upsertFetchedPayments([fetched(), fetched({ portfolioId: 'port-2' })]);

    // port-1's edited row is skipped; port-2's absent row is inserted.
    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.insertValues).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ portfolioId: 'port-2' }),
    ]);
  });
});

describe('listDividendPayments — ownership filter shape', () => {
  it('always scopes by portfolios.userId, plus the optional filters', async () => {
    h.orderBy.mockResolvedValue([]);

    await listDividendPayments('user-1', { portfolioId: 'port-1', instrumentId: 'inst-1' });

    // The read is ownership-scoped in SQL — the userId condition is built
    // unconditionally, the filters only when present.
    expect(eq).toHaveBeenCalledWith('p.user_id', 'user-1');
    expect(eq).toHaveBeenCalledWith('dp.portfolio_id', 'port-1');
    expect(eq).toHaveBeenCalledWith('dp.instrument_id', 'inst-1');
  });

  it('checks source instead of casting it wholesale', async () => {
    h.orderBy.mockResolvedValue([
      { source: 'manual', edited: true },
      { source: 'massive', edited: false },
      { source: 'garbage', edited: false },
    ]);

    const rows = await listDividendPayments('user-1');
    expect(rows.map((r) => r.source)).toEqual(['manual', 'massive', 'massive']);
  });

  it('never surfaces tombstoned rows — deleted-in-SQL, not filtered in JS', async () => {
    h.orderBy.mockResolvedValue([]);
    await listDividendPayments('user-1');
    expect(eq).toHaveBeenCalledWith('dp.deleted', false);
  });
});

function updateInput(overrides: Partial<PaymentUpdateInput> = {}): PaymentUpdateInput {
  return {
    portfolioId: 'port-1',
    exDate: '2026-08-10',
    payDate: '2026-08-13',
    quantity: '10',
    amountPerShare: '0.27',
    grossAmount: '2.7',
    withheldTax: '0.405',
    fxRateToBase: '3.65',
    note: null,
    ...overrides,
  };
}

describe('updatePayment — the vendor-row portfolio lock', () => {
  it('REGRESSION (finding 2): refuses to move a vendor-sourced row to another portfolio', async () => {
    // Moving would vacate (E1, port-1) for the next sync to re-fill — the
    // same dividend counting twice in the All-holdings net — and re-keying
    // could collide with uq_dividend_vendor_portfolio besides.
    h.selectWhere.mockResolvedValue([{ id: 'port-2' }]);
    h.joinedWhere.mockResolvedValue([
      { id: 'row-1', portfolioId: 'port-1', vendorEventId: 'E1' },
    ]);

    const result = await updatePayment('user-1', 'row-1', updateInput({ portfolioId: 'port-2' }));

    expect(result).toBe('portfolio_locked');
    expect(h.updateSet).not.toHaveBeenCalled();
  });

  it('edits a vendor-sourced row in place (same portfolio) and marks it edited', async () => {
    h.selectWhere.mockResolvedValue([{ id: 'port-1' }]);
    h.joinedWhere.mockResolvedValue([
      { id: 'row-1', portfolioId: 'port-1', vendorEventId: 'E1' },
    ]);

    const result = await updatePayment('user-1', 'row-1', updateInput());

    expect(result).toBe('updated');
    expect(h.updateSet).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ portfolioId: 'port-1', edited: true }),
    );
    // The write itself refuses tombstones — a racing delete still wins.
    const condition = h.updateWhere.mock.calls[0][0] as { conditions: unknown[] };
    expect(condition.conditions).toEqual(
      expect.arrayContaining([{ op: 'eq', column: 'dp.deleted', value: false }]),
    );
  });

  it('still moves a MANUAL row freely — null vendor id, nothing to re-insert', async () => {
    h.selectWhere.mockResolvedValue([{ id: 'port-2' }]);
    h.joinedWhere.mockResolvedValue([
      { id: 'row-1', portfolioId: 'port-1', vendorEventId: null },
    ]);

    const result = await updatePayment('user-1', 'row-1', updateInput({ portfolioId: 'port-2' }));

    expect(result).toBe('updated');
    expect(h.updateSet).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ portfolioId: 'port-2', edited: true }),
    );
  });

  it('answers not_found for a foreign or unknown payment', async () => {
    h.selectWhere.mockResolvedValue([{ id: 'port-1' }]);
    h.joinedWhere.mockResolvedValue([]);
    await expect(updatePayment('user-1', 'row-x', updateInput())).resolves.toBe('not_found');
    expect(h.updateSet).not.toHaveBeenCalled();
  });
});

describe('deletePayment — tombstone vs hard delete', () => {
  it('REGRESSION (finding 1): a vendor-sourced row tombstones, keeping its key occupied', async () => {
    h.updateReturning.mockResolvedValue([{ id: 'row-1' }]);

    await expect(deletePayment('user-1', 'row-1')).resolves.toBe(true);

    expect(h.updateSet).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deleted: true }),
    );
    // The tombstone UPDATE targets vendor rows only, in SQL.
    const condition = h.updateWhere.mock.calls[0][0] as { conditions: unknown[] };
    expect(condition.conditions).toEqual(
      expect.arrayContaining([{ op: 'isNotNull', column: 'dp.vendor_event_id' }]),
    );
    expect(h.deleteWhere).not.toHaveBeenCalled();
  });

  it('a manual row (null vendor id) hard-deletes — nothing can re-create it', async () => {
    h.updateReturning.mockResolvedValue([]);
    h.deleteReturning.mockResolvedValue([{ id: 'row-1' }]);

    await expect(deletePayment('user-1', 'row-1')).resolves.toBe(true);
    expect(h.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('a foreign or unknown id touches nothing and reports false', async () => {
    h.updateReturning.mockResolvedValue([]);
    h.deleteReturning.mockResolvedValue([]);
    await expect(deletePayment('user-1', 'row-x')).resolves.toBe(false);
  });
});
