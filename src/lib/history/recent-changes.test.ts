import { QueryBuilder } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SQL shape and the two refusals.
 *
 * CI has no real Postgres, so the top-N-per-group semantics are pinned the
 * way `latest-closes.test.ts` pins DISTINCT ON: build the production query
 * over a pg-core `QueryBuilder` and assert `.toSQL()`. What matters is that
 * the ranking is PARTITIONED (a plain `LIMIT 6` would return six rows for the
 * whole set, not six per instrument — the bug this shape exists to avoid),
 * that it orders `as_of DESC` so the newest closes win, and that every value
 * is parameterised.
 */

const state = vi.hoisted(() => ({ dbCalls: 0, rows: [] as unknown[] }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const schema = await vi.importActual<Record<string, unknown>>('@/lib/db/schema');
  return {
    ...schema,
    db: {
      select() {
        state.dbCalls++;
        const chain = {
          from: () => chain,
          where: () => chain,
          as: () => ({}),
          orderBy: async () => state.rows,
        };
        return chain;
      },
    },
  };
});

beforeEach(() => {
  state.dbCalls = 0;
  state.rows = [];
});

// Imported once, at collection time — outside every test's timeout. The
// module holds no state these cases need reset, so one instance serves all.
const { CLOSES_NEEDED, getRecentCloses, recentClosesQuery } = await import('./recent-changes');

describe('recentClosesQuery — the SQL shape', () => {
  it('ranks per instrument, newest first, fully parameterised', async () => {
    const qb = new QueryBuilder();
    const ids = ['id-aaa', 'id-bbb'];

    const { sql, params } = recentClosesQuery(
      // Confined cast: the pg-core QueryBuilder builds the IDENTICAL SQL but
      // types its chain without an executor.
      qb as unknown as Parameters<typeof recentClosesQuery>[0],
      ids,
      CLOSES_NEEDED,
    ).toSQL();
    const lower = sql.toLowerCase();

    // Top-N PER GROUP, not a global limit.
    expect(lower).toContain('row_number() over');
    expect(lower).toMatch(/partition by\s+"?[\w".]*instrument_id"?/);
    // Newest closes win the ranking.
    expect(lower).toMatch(/order by\s+"?[\w".]*as_of"?\s+desc/);
    // The cut is a filter on the rank, and the depth is a parameter.
    expect(lower).toMatch(/"rank"\s*<=/);
    // No id and no depth is ever inlined.
    expect(params).toEqual([...ids, CLOSES_NEEDED]);
    for (const id of ids) expect(sql).not.toContain(id);
  });
});

describe('getRecentCloses — the refusals', () => {
  it('issues no query for an empty instrument set', async () => {
    // `inArray` with an empty list is a drizzle runtime error, and an empty
    // book is a legitimate call path.
    expect(await getRecentCloses([])).toEqual(new Map());
    expect(state.dbCalls).toBe(0);
  });

  it('leaves an instrument with no stored history ABSENT, never empty', async () => {
    state.rows = [{ instrumentId: 'id-aaa', asOf: '2026-08-21', close: '101.00000000' }];

    const byInstrument = await getRecentCloses(['id-aaa', 'id-bbb']);
    expect(byInstrument.has('id-bbb')).toBe(false);
    // And numeric(20,8) padding never leaks into a percentage.
    expect(byInstrument.get('id-aaa')).toEqual([{ asOf: '2026-08-21', close: '101' }]);
  });

  it('costs ONE round trip for the whole set, duplicates included', async () => {
    // Two builder calls, one statement: the ranked subquery and the outer
    // select that filters it. What is being pinned is that the count does not
    // grow with the instrument set — an N+1 here is twenty round trips on
    // every cold start, which is the bug the batched shape exists to avoid.
    await getRecentCloses(['id-aaa', 'id-aaa', 'id-bbb', 'id-ccc']);
    expect(state.dbCalls).toBe(2);
  });
});
