import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browsing resolver: select-first, directory-then-mint, and a hard stop on
 * a ticker nothing has heard of.
 *
 * The `latest-closes.test.ts` arrangement — keep the REAL schema so the query
 * builds against real column objects, swap only `db` for a fake, and compile
 * the captured WHERE to recover the symbol it filtered on. That last part is
 * what stops the fake from passing a query that filters on the wrong column:
 * CI has no Postgres, so the fake's fidelity has to be pinned by something.
 */

const state = vi.hoisted(() => ({
  rows: [] as { id: string; symbol: string; displayName: string; exchange: string; currency: string }[],
  inserted: [] as Record<string, unknown>[],
  selectedSymbols: [] as string[],
  directory: null as { name: string; exchange: string } | null,
  directoryCalls: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/market-data/symbol-directory', () => ({
  lookupDirectorySymbol: async (symbol: string) => {
    state.directoryCalls.push(symbol);
    return state.directory;
  },
}));
vi.mock('@/lib/db', async () => {
  const schema = await vi.importActual<Record<string, unknown>>('@/lib/db/schema');
  const { PgDialect } = await vi.importActual<typeof import('drizzle-orm/pg-core')>(
    'drizzle-orm/pg-core',
  );
  const dialect = new PgDialect();

  return {
    ...schema,
    db: {
      select: () => ({
        from: () => ({
          where: (where: unknown) => {
            // Every query on this path filters `instruments.symbol = $1`.
            const [symbol] = dialect.sqlToQuery(where as SQL).params as string[];
            state.selectedSymbols.push(symbol);
            return Promise.resolve(state.rows.filter((r) => r.symbol === symbol));
          },
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            state.inserted.push(values);
            // The real upsert is do-nothing on the unique symbol.
            if (!state.rows.some((r) => r.symbol === values.symbol)) {
              state.rows.push({
                id: `minted-${String(values.symbol)}`,
                symbol: String(values.symbol),
                displayName: String(values.displayName),
                exchange: String(values.exchange),
                currency: String(values.currency),
              });
            }
          },
        }),
      }),
    },
  };
});

import { resolveInstrumentForBrowsing } from './resolve';

describe('resolving a symbol for browsing', () => {
  beforeEach(() => {
    state.rows = [];
    state.inserted = [];
    state.selectedSymbols = [];
    state.directory = null;
    state.directoryCalls = [];
  });

  it('uses an existing row as it stands and writes nothing', async () => {
    state.rows = [
      { id: 'i1', symbol: 'AAPL', displayName: 'Apple', exchange: 'NASDAQ', currency: 'USD' },
    ];

    const found = await resolveInstrumentForBrowsing('AAPL');

    expect(found).toEqual({
      id: 'i1',
      symbol: 'AAPL',
      displayName: 'Apple',
      exchange: 'NASDAQ',
      currency: 'USD',
    });
    // The steady state — every open of a stock you already have — must not
    // write, and must not spend a directory lookup either.
    expect(state.inserted).toEqual([]);
    expect(state.directoryCalls).toEqual([]);
  });

  it('an existing row wins even when its currency is not the directory default', async () => {
    state.rows = [
      { id: 'i2', symbol: 'ASML', displayName: 'ASML', exchange: 'AMS', currency: 'EUR' },
    ];

    const found = await resolveInstrumentForBrowsing('ASML');

    // Select-first is what keeps `resolveOrCreateInstrument`'s currency
    // mismatch refusal from stranding a screen that only wants to look.
    expect(found?.currency).toBe('EUR');
    expect(state.inserted).toEqual([]);
  });

  it('mints from the directory when there is no row yet', async () => {
    state.directory = { name: 'Energy Fuels Inc', exchange: 'NYSE American' };

    const found = await resolveInstrumentForBrowsing('UUUU');

    expect(state.directoryCalls).toEqual(['UUUU']);
    expect(found).toEqual({
      id: 'minted-UUUU',
      symbol: 'UUUU',
      displayName: 'Energy Fuels Inc',
      exchange: 'NYSE American',
      currency: 'USD',
    });
    expect(state.selectedSymbols).toEqual(['UUUU', 'UUUU']);
  });

  it('clamps the minted name and exchange to the watchlist action bounds', async () => {
    state.directory = { name: 'N'.repeat(120), exchange: 'E'.repeat(40) };

    const found = await resolveInstrumentForBrowsing('LONG');

    // First write wins, so a full-length vendor name minted here would be
    // permanent — and would then make every future "add to watchlist" for
    // this symbol fail validation.
    expect(found?.displayName).toHaveLength(80);
    expect(found?.exchange).toHaveLength(20);
  });

  it('a ticker the directory has never heard of resolves to nothing', async () => {
    state.directory = null;

    const found = await resolveInstrumentForBrowsing('NOTATICKER');

    // Browsing is not an oracle over the vendor's whole universe, and it must
    // never mint a row for a string somebody typed.
    expect(found).toBeNull();
    expect(state.inserted).toEqual([]);
  });
});
