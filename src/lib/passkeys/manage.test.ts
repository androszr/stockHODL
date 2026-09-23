import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The last-key rule, which is the only thing in this module worth a test:
 * everything else is a scoped select. It gets one because its failure mode is
 * not a wrong number on a screen — it is an account nobody can sign into,
 * recoverable only by running a script against the database.
 */

const state = vi.hoisted(() => ({
  count: 0,
  deleted: [] as Array<{ id: string; userId: string }>,
  /** Rows the delete will claim to have removed. */
  returns: [] as Array<{ id: string }>,
}));

vi.mock('server-only', () => ({}));

vi.mock('@/lib/db', () => ({
  db: {
    select: (shape: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          'total' in shape
            ? Promise.resolve([{ total: state.count }])
            : Promise.resolve([]),
        orderBy: () => Promise.resolve([]),
      }),
    }),
    delete: () => ({
      where: (condition: { id: string; userId: string }) => ({
        returning: () => {
          state.deleted.push(condition);
          return Promise.resolve(state.returns);
        },
      }),
    }),
  },
}));

// The `where` above receives drizzle's SQL object, not our fields — the mock
// records the CALL, and the assertions below are about the decision, not the
// SQL. Ownership scoping is asserted by reading the query in the source.
vi.mock('drizzle-orm', () => ({
  and: (...parts: unknown[]) => ({ parts }),
  count: () => 'total',
  desc: (column: unknown) => column,
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

vi.mock('@/lib/db/schema', () => ({
  passkey: {
    id: 'passkey.id',
    name: 'passkey.name',
    userId: 'passkey.user_id',
    deviceType: 'passkey.device_type',
    backedUp: 'passkey.backed_up',
    createdAt: 'passkey.created_at',
  },
}));

const { deletePasskey } = await import('./manage');

beforeEach(() => {
  state.count = 0;
  state.deleted = [];
  state.returns = [{ id: 'k1' }];
});

describe('deletePasskey', () => {
  it('refuses the last key, and does not reach the delete at all', async () => {
    state.count = 1;

    const result = await deletePasskey('u1', 'k1');

    expect(result).toEqual({
      ok: false,
      reason: 'last-key',
      error: expect.stringContaining('only passkey'),
    });
    // The count is not advisory — nothing is deleted on the way to saying no.
    expect(state.deleted).toHaveLength(0);
  });

  it('refuses at zero as well, which is the same lockout from the other side', async () => {
    state.count = 0;

    const result = await deletePasskey('u1', 'k1');

    expect(result.ok).toBe(false);
    expect(state.deleted).toHaveLength(0);
  });

  it('removes one when another remains', async () => {
    state.count = 2;

    expect(await deletePasskey('u1', 'k1')).toEqual({ ok: true });
    expect(state.deleted).toHaveLength(1);
  });

  it('a row that deleted nothing is a refusal, never a cheerful ok', async () => {
    state.count = 2;
    state.returns = [];

    // Unlike the watchlist delete, this one is deliberately not idempotent:
    // "your key is gone" about a key that is still enrolled is the one wrong
    // answer here with a security meaning.
    expect(await deletePasskey('u1', 'someone-elses-key')).toEqual({
      ok: false,
      reason: 'not-found',
      error: 'Passkey not found.',
    });
  });
});
