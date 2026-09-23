import type { SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S4 equivalence + SQL-shape tests (2026-08-16, trim-bundle plan): the
 * batched `getLatestClosesBefore` must answer EXACTLY like running the
 * single-instrument `getLatestCloseBefore` in a loop — on gaps, boundary
 * days, and numeric padding.
 *
 * Own file, own `@/lib/db` mock: `price-history.test.ts` mocks the db as
 * `{}` (its subject is the injectable-IO coverage logic), which cannot serve
 * the fixture-backed fake this needs. Here the mock keeps the REAL schema
 * (the query construction reads real column objects) and swaps only `db` for
 * a fake whose two chains — the `select…limit(1)` shape and the
 * `selectDistinctOn` shape — both answer from ONE shared row fixture through
 * a small reference evaluator of Postgres's documented DISTINCT ON
 * semantics: filter `as_of < before`, newest row per instrument wins.
 *
 * Honest limit, stated plainly: CI has no real Postgres, so the fake's
 * contract is tied to the production query by the `.toSQL()` SQL-shape test
 * below — it pins DISTINCT ON on the instrument-id column, the strict `<`,
 * the ORDER BY leading with the DISTINCT ON column (a Postgres requirement),
 * and fully parameterised values.
 */

interface FixtureRow {
  instrumentId: string;
  asOf: string;
  close: string;
}

const state = vi.hoisted(() => ({
  rows: [] as { instrumentId: string; asOf: string; close: string }[],
  dbCalls: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/market-data/massive', () => ({ massiveProvider: {} }));
vi.mock('@/lib/db', async () => {
  const schema = await vi.importActual<Record<string, unknown>>('@/lib/db/schema');
  const { PgDialect } = await vi.importActual<typeof import('drizzle-orm/pg-core')>(
    'drizzle-orm/pg-core',
  );
  const dialect = new PgDialect();

  // Both production queries build `and(<id predicate>, lt(as_of, before))`,
  // so compiling the captured WHERE yields params in construction order:
  // the instrument id(s) first, the boundary date last.
  const paramsOf = (where: unknown) => dialect.sqlToQuery(where as SQL).params as string[];

  // The ~10-line reference evaluator of DISTINCT ON semantics.
  const latestPerInstrument = (ids: readonly string[], before: string) => {
    const newest = new Map<string, { instrumentId: string; asOf: string; close: string }>();
    for (const row of state.rows) {
      if (!ids.includes(row.instrumentId)) continue;
      if (!(row.asOf < before)) continue; // STRICT: a boundary-day close is that day's data
      const held = newest.get(row.instrumentId);
      if (held === undefined || row.asOf > held.asOf) newest.set(row.instrumentId, row);
    }
    return newest;
  };

  return {
    ...schema,
    db: {
      /** `getLatestCloseBefore`'s chain: select → from → where → orderBy → limit(1). */
      select() {
        state.dbCalls++;
        let captured: unknown;
        const chain = {
          from: () => chain,
          where: (where: unknown) => {
            captured = where;
            return chain;
          },
          orderBy: () => chain,
          limit: async () => {
            const [id, before] = paramsOf(captured);
            const hit = latestPerInstrument([id], before).get(id);
            return hit ? [{ close: hit.close }] : [];
          },
        };
        return chain;
      },
      /** `getLatestClosesBefore`'s chain: selectDistinctOn → from → where → orderBy (awaited). */
      selectDistinctOn() {
        state.dbCalls++;
        let captured: unknown;
        const chain = {
          from: () => chain,
          where: (where: unknown) => {
            captured = where;
            return chain;
          },
          orderBy: async () => {
            const params = paramsOf(captured);
            const before = params[params.length - 1];
            const ids = params.slice(0, -1);
            return [...latestPerInstrument(ids, before).values()].map(
              ({ instrumentId, close }) => ({ instrumentId, close }),
            );
          },
        };
        return chain;
      },
    },
  };
});

import {
  getLatestCloseBefore,
  getLatestClosesBefore,
  latestClosesBeforeQuery,
} from './price-history';

const DAY = '2026-08-14'; // the first charted day — baselines are STRICTLY before

function setFixture(rows: FixtureRow[]) {
  state.rows = rows;
}

/** The old N+1 path, run per id — the behavior the batch must reproduce. */
async function loopBaselines(ids: string[], before: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of ids) {
    const close = await getLatestCloseBefore(id, before);
    if (close !== null) map.set(id, close);
  }
  return map;
}

beforeEach(() => {
  state.rows = [];
  state.dbCalls = 0;
});

describe('getLatestClosesBefore ≡ getLatestCloseBefore-in-a-loop', () => {
  it('an instrument with NO earlier close is absent from both maps', async () => {
    setFixture([{ instrumentId: 'i-none', asOf: DAY, close: '10' }]); // boundary-day only
    const batch = await getLatestClosesBefore(['i-none'], DAY);
    const loop = await loopBaselines(['i-none'], DAY);
    expect(batch).toEqual(loop);
    expect(batch.size).toBe(0);
  });

  it('a close with as_of EXACTLY on the boundary day is excluded by both (strict <)', async () => {
    setFixture([
      { instrumentId: 'i-exact', asOf: DAY, close: '200' },
      { instrumentId: 'i-exact', asOf: '2026-08-12', close: '195' },
    ]);
    const batch = await getLatestClosesBefore(['i-exact'], DAY);
    const loop = await loopBaselines(['i-exact'], DAY);
    expect(batch).toEqual(loop);
    // The boundary-day 200 must lose to the strictly-earlier 195 in BOTH.
    expect(batch.get('i-exact')).toBe('195');
  });

  it('a close the session before is included, and the NEWEST earlier close wins', async () => {
    setFixture([
      { instrumentId: 'i-prior', asOf: '2026-08-01', close: '99' },
      { instrumentId: 'i-prior', asOf: '2026-08-13', close: '101.5' },
    ]);
    const batch = await getLatestClosesBefore(['i-prior'], DAY);
    const loop = await loopBaselines(['i-prior'], DAY);
    expect(batch).toEqual(loop);
    expect(batch.get('i-prior')).toBe('101.5');
  });

  it('a mixed portfolio (no-history + boundary-only + prior-close) answers identically', async () => {
    setFixture([
      { instrumentId: 'i-boundary-only', asOf: DAY, close: '50' },
      { instrumentId: 'i-prior', asOf: '2026-08-13', close: '101.5' },
      { instrumentId: 'i-prior', asOf: '2026-08-11', close: '100' },
      { instrumentId: 'i-old', asOf: '2026-07-01', close: '7' },
    ]);
    const ids = ['i-never-traded', 'i-boundary-only', 'i-prior', 'i-old'];
    const batch = await getLatestClosesBefore(ids, DAY);
    const loop = await loopBaselines(ids, DAY);
    expect(batch).toEqual(loop);
    expect(batch).toEqual(
      new Map([
        ['i-prior', '101.5'],
        ['i-old', '7'],
      ]),
    );
  });

  it("numeric(20,8) padding normalises in both: '123.45000000' → '123.45'", async () => {
    setFixture([{ instrumentId: 'i-pad', asOf: '2026-08-13', close: '123.45000000' }]);
    const batch = await getLatestClosesBefore(['i-pad'], DAY);
    const loop = await loopBaselines(['i-pad'], DAY);
    expect(batch).toEqual(loop);
    expect(batch.get('i-pad')).toBe('123.45');
  });

  it('an empty id list returns an empty map WITHOUT touching the db (inArray([]) throws)', async () => {
    const batch = await getLatestClosesBefore([], DAY);
    expect(batch.size).toBe(0);
    expect(state.dbCalls).toBe(0);
  });
});

describe('latestClosesBeforeQuery — the SQL shape the fake is contracted to', () => {
  it('pins DISTINCT ON, strict <, the required ORDER BY, and full parameterisation', () => {
    const qb = new QueryBuilder();
    const ids = ['id-aaa', 'id-bbb'];
    const query = latestClosesBeforeQuery(
      // Confined cast (plan's stated allowance): the pg-core QueryBuilder
      // builds the IDENTICAL SQL but types its chain without an executor.
      qb as unknown as Parameters<typeof latestClosesBeforeQuery>[0],
      ids,
      DAY,
    );
    const { sql, params } = query.toSQL();
    const lower = sql.toLowerCase();

    // DISTINCT ON targeting the instrument-id column.
    expect(lower).toMatch(/select distinct on \([^)]*instrument_id[^)]*\)/);
    // STRICT < on as_of — never <=.
    expect(lower).toMatch(/"as_of" </);
    expect(lower).not.toMatch(/"as_of" <=/);
    // ORDER BY leads with the DISTINCT ON column (Postgres requires it),
    // then as_of DESC so the newest row per instrument wins.
    expect(lower).toMatch(/order by [^,]*instrument_id[^,]*,[^,]*as_of[^,]* desc/);
    // Fully parameterised: values ride in params, never inlined in the SQL.
    expect(params).toEqual([...ids, DAY]);
    for (const value of [...ids, DAY]) expect(sql).not.toContain(value);
  });
});
