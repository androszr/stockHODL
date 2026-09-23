import type { SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dec } from '@/lib/money';

/**
 * Loop-vs-batch equivalence + SQL-shape tests (2026-08-16, ticker-page plan):
 * the batched `getPriorClosesBySymbol` must answer EXACTLY like the retired
 * sequential per-symbol lookup — on gaps, boundary days and numeric padding —
 * while keeping three contract points verbatim: the THROW on db failure (the
 * caller in massive.ts depends on containing it), the found-only memo (a
 * cached miss would hide a brand-new instrument's history), and strict `<`
 * (a boundary-day close is that day's data).
 *
 * The harness mirrors `latest-closes.test.ts` wholesale: real schema via
 * `importActual`, a fixture-backed `db.selectDistinctOn` fake answering
 * through a ~10-line reference evaluator of Postgres's documented DISTINCT ON
 * semantics, `PgDialect.sqlToQuery` param extraction, and the `.toSQL()`
 * SQL-shape pin that ties the fake's contract to the production query. The
 * old loop's semantics live in `loopReference` below — a local
 * reimplementation over the same fixture (the production loop is gone).
 *
 * The memo is MODULE state, so every case gets a fresh module via
 * `vi.resetModules()` + dynamic import (the massive.test.ts pattern) unless
 * the case is ABOUT the memo surviving across calls.
 */

interface FixtureRow {
  symbol: string;
  asOf: string;
  close: string;
}

const state = vi.hoisted(() => ({
  rows: [] as { symbol: string; asOf: string; close: string }[],
  dbCalls: 0,
  failNext: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const schema = await vi.importActual<Record<string, unknown>>('@/lib/db/schema');
  const { PgDialect } = await vi.importActual<typeof import('drizzle-orm/pg-core')>(
    'drizzle-orm/pg-core',
  );
  const dialect = new PgDialect();

  // The production query builds `and(inArray(symbol, …), lt(as_of, before))`,
  // so compiling the captured WHERE yields params in construction order:
  // the symbols first, the boundary date last.
  const paramsOf = (where: unknown) => dialect.sqlToQuery(where as SQL).params as string[];

  // The ~10-line reference evaluator of DISTINCT ON semantics, per SYMBOL.
  const newestPerSymbol = (symbols: readonly string[], before: string) => {
    const newest = new Map<string, { symbol: string; asOf: string; close: string }>();
    for (const row of state.rows) {
      if (!symbols.includes(row.symbol)) continue;
      if (!(row.asOf < before)) continue; // STRICT: a boundary-day close is that day's data
      const held = newest.get(row.symbol);
      if (held === undefined || row.asOf > held.asOf) newest.set(row.symbol, row);
    }
    return newest;
  };

  return {
    ...schema,
    db: {
      /** The batch chain: selectDistinctOn → from → innerJoin → where → orderBy (awaited). */
      selectDistinctOn() {
        state.dbCalls++;
        let captured: unknown;
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: (where: unknown) => {
            captured = where;
            return chain;
          },
          orderBy: async () => {
            if (state.failNext) throw new Error('db down');
            const params = paramsOf(captured);
            const before = params[params.length - 1];
            const symbols = params.slice(0, -1);
            return [...newestPerSymbol(symbols, before).values()].map(({ symbol, close }) => ({
              symbol,
              close,
            }));
          },
        };
        return chain;
      },
    },
  };
});

const DAY = '2026-08-14'; // the last completed session — baselines are STRICTLY before


// Pay the module's cold TRANSFORM once, here at collection time, outside
// every test's timeout. Each test below still gets a fresh instance through
// `vi.resetModules()` + import, but that is now only a re-evaluation of an
// already-transformed module — so a loaded machine can no longer spend a
// test's 5 s budget compiling the file under test.
await import('./prior-closes');

/** Fresh module per case — the memo is module state and must not bleed. */
async function freshModule() {
  vi.resetModules();
  return import('./prior-closes');
}

/** The OLD per-symbol limit-1 semantics, reimplemented over the same fixture. */
function loopReference(symbols: readonly string[], before: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const symbol of symbols) {
    let best: FixtureRow | undefined;
    for (const row of state.rows) {
      if (row.symbol !== symbol) continue;
      if (!(row.asOf < before)) continue;
      if (best === undefined || row.asOf > best.asOf) best = row;
    }
    if (best !== undefined) map.set(symbol, dec(best.close).toString());
  }
  return map;
}

beforeEach(() => {
  state.rows = [];
  state.dbCalls = 0;
  state.failNext = false;
});

describe('getPriorClosesBySymbol ≡ the retired per-symbol loop', () => {
  it('a symbol with NO earlier close is absent from both maps', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [{ symbol: 'NONE', asOf: DAY, close: '10' }]; // boundary-day only
    const batch = await getPriorClosesBySymbol(['NONE'], DAY);
    expect(batch).toEqual(loopReference(['NONE'], DAY));
    expect(batch.size).toBe(0);
  });

  it('a close EXACTLY on the boundary day is excluded by both (strict <)', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [
      { symbol: 'EXACT', asOf: DAY, close: '200' },
      { symbol: 'EXACT', asOf: '2026-08-12', close: '195' },
    ];
    const batch = await getPriorClosesBySymbol(['EXACT'], DAY);
    expect(batch).toEqual(loopReference(['EXACT'], DAY));
    // The boundary-day 200 must lose to the strictly-earlier 195 in BOTH.
    expect(batch.get('EXACT')).toBe('195');
  });

  it('a close the session before is included, and the NEWEST earlier close wins', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [
      { symbol: 'PRIOR', asOf: '2026-08-01', close: '99' },
      { symbol: 'PRIOR', asOf: '2026-08-13', close: '101.5' },
    ];
    const batch = await getPriorClosesBySymbol(['PRIOR'], DAY);
    expect(batch).toEqual(loopReference(['PRIOR'], DAY));
    expect(batch.get('PRIOR')).toBe('101.5');
  });

  it('a mixed set (no-history + boundary-only + prior-close) answers identically, in ONE query', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [
      { symbol: 'BOUNDARY', asOf: DAY, close: '50' },
      { symbol: 'PRIOR', asOf: '2026-08-13', close: '101.5' },
      { symbol: 'PRIOR', asOf: '2026-08-11', close: '100' },
      { symbol: 'OLD', asOf: '2026-07-01', close: '7' },
    ];
    const symbols = ['NEVER', 'BOUNDARY', 'PRIOR', 'OLD'];
    const batch = await getPriorClosesBySymbol(symbols, DAY);
    expect(batch).toEqual(loopReference(symbols, DAY));
    expect(batch).toEqual(
      new Map([
        ['PRIOR', '101.5'],
        ['OLD', '7'],
      ]),
    );
    // The N+1 is gone: four symbols, one round-trip.
    expect(state.dbCalls).toBe(1);
  });

  it("numeric(20,8) padding normalises in both: '123.45000000' → '123.45'", async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [{ symbol: 'PAD', asOf: '2026-08-13', close: '123.45000000' }];
    const batch = await getPriorClosesBySymbol(['PAD'], DAY);
    expect(batch).toEqual(loopReference(['PAD'], DAY));
    expect(batch.get('PAD')).toBe('123.45');
  });
});

describe('getPriorClosesBySymbol — memo and contract', () => {
  it('a second identical call answers from the memo with ZERO further db calls', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [{ symbol: 'MEMO', asOf: '2026-08-13', close: '42' }];
    const first = await getPriorClosesBySymbol(['MEMO'], DAY);
    expect(state.dbCalls).toBe(1);
    const second = await getPriorClosesBySymbol(['MEMO'], DAY);
    // The all-memoized path never reaches the db — also the empty-`inArray`
    // guard (`inArray([])` is a drizzle runtime error).
    expect(state.dbCalls).toBe(1);
    expect(second).toEqual(first);
  });

  it('a symbol that had NO row is re-queried next call — misses are not cached', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [];
    const empty = await getPriorClosesBySymbol(['LATE'], DAY);
    expect(empty.size).toBe(0);
    expect(state.dbCalls).toBe(1);
    // The nightly cron lands the history; the next call must SEE it.
    state.rows = [{ symbol: 'LATE', asOf: '2026-08-13', close: '55' }];
    const found = await getPriorClosesBySymbol(['LATE'], DAY);
    expect(state.dbCalls).toBe(2);
    expect(found.get('LATE')).toBe('55');
  });

  it('memoized symbols are served alongside a fresh query for the true misses only', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.rows = [
      { symbol: 'HIT', asOf: '2026-08-13', close: '10' },
      { symbol: 'MISS', asOf: '2026-08-13', close: '20' },
    ];
    await getPriorClosesBySymbol(['HIT'], DAY);
    expect(state.dbCalls).toBe(1);
    const both = await getPriorClosesBySymbol(['HIT', 'MISS'], DAY);
    expect(state.dbCalls).toBe(2); // one MORE query — for MISS alone
    expect(both).toEqual(loopReference(['HIT', 'MISS'], DAY));
  });

  it('a database failure REJECTS — degradation stays the caller’s job (massive.ts contains it)', async () => {
    const { getPriorClosesBySymbol } = await freshModule();
    state.failNext = true;
    await expect(getPriorClosesBySymbol(['ANY'], DAY)).rejects.toThrow('db down');
  });
});

describe('priorClosesQuery — the SQL shape the fake is contracted to', () => {
  it('pins DISTINCT ON (symbol), strict <, the required ORDER BY, and full parameterisation', async () => {
    const { priorClosesQuery } = await freshModule();
    const qb = new QueryBuilder();
    const symbols = ['AAA', 'BBB'];
    const query = priorClosesQuery(
      // Confined cast (the latest-closes.test.ts allowance): the pg-core
      // QueryBuilder builds the IDENTICAL SQL but types its chain without an
      // executor.
      qb as unknown as Parameters<typeof priorClosesQuery>[0],
      symbols,
      DAY,
    );
    const { sql, params } = query.toSQL();
    const lower = sql.toLowerCase();

    // DISTINCT ON targeting the (unique) symbol column.
    expect(lower).toMatch(/select distinct on \([^)]*"symbol"[^)]*\)/);
    // STRICT < on as_of — never <=.
    expect(lower).toMatch(/"as_of" </);
    expect(lower).not.toMatch(/"as_of" <=/);
    // ORDER BY leads with the DISTINCT ON column (Postgres requires it),
    // then as_of DESC so the newest earlier close per symbol wins.
    expect(lower).toMatch(/order by [^,]*"symbol"[^,]*,[^,]*as_of[^,]* desc/);
    // Fully parameterised: values ride in params, never inlined in the SQL.
    expect(params).toEqual([...symbols, DAY]);
    for (const value of [...symbols, DAY]) expect(sql).not.toContain(value);
  });
});
