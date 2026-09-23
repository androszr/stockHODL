import { describe, expect, it, vi } from 'vitest';

import { dec } from '@/lib/money';
import type { DividendEvent } from '@/lib/market-data/provider';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {}, instruments: {}, portfolios: {}, transactions: {} }));
vi.mock('@/lib/fx/nbp', () => ({ getFxRateToPln: vi.fn() }));
vi.mock('@/lib/market-data/massive', () => ({ massiveProvider: {} }));

import { planFetchedWrite, type FetchedPaymentInput } from './store';
import { summarizeDividends } from './summary';
import {
  DEFAULT_WITHHOLDING_RATE,
  syncDividendsWith,
  type DividendSyncDeps,
  type DividendSyncRow,
} from './sync';

/**
 * The sync's DECISIONS over injected IO — no Drizzle, no vendor, no NBP:
 * eligibility boundary, per-portfolio split, the 15% default in Decimal, the
 * fx-null retry path, future-event skipping, and the self-heal input side
 * (recomputed quantities always flow to the store; the store decides what
 * may be written).
 */

let seq = 0;

function row(overrides: Partial<DividendSyncRow> = {}): DividendSyncRow {
  seq += 1;
  return {
    id: `tx-${String(seq).padStart(4, '0')}`,
    instrumentId: 'inst-1',
    symbol: 'AAPL',
    displayName: 'Apple Inc.',
    currency: 'USD',
    side: 'buy',
    quantity: '10',
    price: '200',
    fees: '0',
    fxRateToBase: '4',
    tradeDate: '2026-01-05',
    createdAt: new Date('2026-01-05T10:00:00Z'),
    portfolioId: 'port-1',
    ...overrides,
  };
}

function event(overrides: Partial<DividendEvent> = {}): DividendEvent {
  return {
    vendorId: 'E1',
    cashAmount: '0.27',
    currency: 'USD',
    exDate: '2026-08-10',
    payDate: '2026-08-13',
    recordDate: '2026-08-10',
    declarationDate: '2026-07-31',
    frequency: 4,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DividendSyncDeps> = {}): DividendSyncDeps & {
  upserted: FetchedPaymentInput[];
} {
  const upserted: FetchedPaymentInput[] = [];
  return {
    upserted,
    loadRows: async () => [row()],
    getDividends: async () => [event()],
    getFxRate: async () => ({ ok: true, rate: '3.65', rateDate: '2026-08-12' }),
    upsert: async (rows) => {
      upserted.push(...rows);
    },
    todayISO: () => '2026-08-16',
    ...overrides,
  };
}

/**
 * A minimal in-memory `dividend_payments` whose writes route through the
 * REAL `planFetchedWrite` — the production store's single decision point —
 * so the delete/edit regression tests below exercise sync + rule together
 * rather than a mock of the rule.
 */
type StoredPayment = FetchedPaymentInput & {
  source: string;
  edited: boolean;
  deleted: boolean;
};

function inMemoryStore() {
  const table = new Map<string, StoredPayment>();
  const upsert = async (rows: FetchedPaymentInput[]) => {
    for (const r of rows) {
      const key = `${r.vendorEventId}|${r.portfolioId}`;
      const plan = planFetchedWrite(table.get(key));
      if (plan === 'skip') continue;
      if (plan === 'insert') {
        table.set(key, { ...r, source: 'massive', edited: false, deleted: false });
      } else {
        // update: recomputed figures flow in, the flags stay.
        table.set(key, { ...table.get(key)!, ...r });
      }
    }
  };
  /** What listDividendPayments surfaces — tombstones never leave the store. */
  const visible = () => [...table.values()].filter((r) => !r.deleted);
  return { table, upsert, visible };
}

describe('syncDividendsWith — eligibility and row math', () => {
  it('derives the AAPL example: 10 shares × 0.27 gross, 15% default withheld, in Decimal', async () => {
    const deps = makeDeps();
    const count = await syncDividendsWith(deps, 'user-1');

    expect(count).toBe(1);
    const [payment] = deps.upserted;
    expect(payment.quantity).toBe('10');
    expect(payment.amountPerShare).toBe('0.27');
    expect(payment.grossAmount).toBe('2.7');
    // 15% of 2.7 exactly — Decimal, no float dust.
    expect(payment.withheldTax).toBe('0.405');
    expect(dec(payment.withheldTax).equals(dec(payment.grossAmount).times(dec('0.15')))).toBe(
      true,
    );
    expect(payment.fxRateToBase).toBe('3.65');
    expect(payment.vendorEventId).toBe('E1');
  });

  it('the default rate constant is 15% and is only ever applied at row creation', () => {
    expect(DEFAULT_WITHHOLDING_RATE).toBe('0.15');
  });

  it('excludes a buy ON the ex-date — the qualifying-day boundary', async () => {
    const deps = makeDeps({
      loadRows: async () => [row({ tradeDate: '2026-08-10' })],
    });
    const count = await syncDividendsWith(deps, 'user-1');
    expect(count).toBe(0);
    expect(deps.upserted).toEqual([]);
  });

  it('splits one event across portfolios by each portfolio\'s own ledger', async () => {
    const deps = makeDeps({
      loadRows: async () => [
        row({ portfolioId: 'port-1', quantity: '10' }),
        row({ portfolioId: 'port-2', quantity: '4' }),
        // port-3 bought after the ex-date: no payment there.
        row({ portfolioId: 'port-3', quantity: '100', tradeDate: '2026-08-11' }),
      ],
    });
    await syncDividendsWith(deps, 'user-1');

    const byPortfolio = new Map(deps.upserted.map((p) => [p.portfolioId, p]));
    expect(byPortfolio.get('port-1')?.grossAmount).toBe('2.7');
    expect(byPortfolio.get('port-2')?.grossAmount).toBe('1.08');
    expect(byPortfolio.has('port-3')).toBe(false);
  });

  it('a failed FX lookup leaves the rate null — retried next sync, never guessed', async () => {
    const deps = makeDeps({
      getFxRate: async () => ({ ok: false, reason: 'not_published' }),
    });
    await syncDividendsWith(deps, 'user-1');
    expect(deps.upserted[0].fxRateToBase).toBeNull();
  });

  it('freezes FX at the pay date, falling back to the ex-date when absent', async () => {
    const asked: string[] = [];
    const deps = makeDeps({
      getDividends: async () => [
        event(),
        event({ vendorId: 'E2', payDate: null, exDate: '2026-05-11' }),
      ],
      getFxRate: async ({ tradeDate }) => {
        asked.push(tradeDate);
        return { ok: true, rate: '3.65', rateDate: tradeDate };
      },
    });
    await syncDividendsWith(deps, 'user-1');
    expect(asked).toEqual(['2026-08-13', '2026-05-11']);
  });

  it('skips events dated after today — declared-but-unpaid is out of scope', async () => {
    const deps = makeDeps({
      getDividends: async () => [
        event(),
        event({ vendorId: 'E-future', exDate: '2026-08-20', payDate: '2026-08-25' }),
      ],
    });
    await syncDividendsWith(deps, 'user-1');
    expect(deps.upserted.map((p) => p.vendorEventId)).toEqual(['E1']);
  });

  it('recomputed quantities always flow to the store — the self-heal input side', async () => {
    // A backdated transaction edit changed the ledger; the sync recomputes
    // and hands the NEW figures to the store, whose one rule decides that
    // only massive+unedited rows take them.
    const deps = makeDeps({
      loadRows: async () => [row({ quantity: '25' })],
    });
    await syncDividendsWith(deps, 'user-1');
    expect(deps.upserted[0].quantity).toBe('25');
    expect(deps.upserted[0].grossAmount).toBe('6.75');
  });

  it('one failing instrument never sinks the others', async () => {
    const deps = makeDeps({
      loadRows: async () => [
        row({ instrumentId: 'inst-bad', symbol: 'BAD' }),
        row({ instrumentId: 'inst-1', symbol: 'AAPL' }),
      ],
      getDividends: async (symbol) => {
        if (symbol === 'BAD') throw new Error('HTTP 429');
        return [event()];
      },
    });
    const count = await syncDividendsWith(deps, 'user-1');
    expect(count).toBe(1);
    expect(deps.upserted).toHaveLength(1);
  });

  it('a deleted fetched payment stays gone through the next sync — REGRESSION (finding 1)', async () => {
    // The sync composed with an in-memory table routed through the REAL
    // planFetchedWrite — the exact decision the production store makes. The
    // bug: deletePayment used to vacate the key, and the recomputed event
    // then hit planFetchedWrite(undefined) → 'insert', silently undoing the
    // delete overnight.
    const { upsert, table, visible } = inMemoryStore();
    const deps = makeDeps({ upsert });

    await syncDividendsWith(deps, 'user-1');
    expect(visible()).toHaveLength(1);

    // What deletePayment does to a vendor-sourced row: tombstone, key kept.
    table.get('E1|port-1')!.deleted = true;

    await syncDividendsWith(deps, 'user-1');

    expect(visible()).toHaveLength(0);
    const stored = table.get('E1|port-1')!;
    expect(stored.deleted).toBe(true);
    // Not even the figures were refreshed — the tombstone skips outright.
    expect(stored.quantity).toBe('10');
  });

  it('an edited payment is never double-counted by the next sync — REGRESSION (finding 2)', async () => {
    // The portfolio of a vendor-sourced row is LOCKED (store.updatePayment),
    // so its key can never vacate; this asserts the invariant the lock
    // protects: however the user corrects a row, a later sync leaves exactly
    // ONE row per (vendor event, portfolio) and the All-holdings net counts
    // the dividend once.
    const { upsert, table, visible } = inMemoryStore();
    const deps = makeDeps({ upsert });

    await syncDividendsWith(deps, 'user-1');

    // The user corrects the row (updatePayment: edited = true, figures own).
    const row = table.get('E1|port-1')!;
    row.edited = true;
    row.withheldTax = '0.5';

    await syncDividendsWith(deps, 'user-1');

    const rows = visible();
    expect(rows.filter((r) => r.vendorEventId === 'E1')).toHaveLength(1);
    // The correction survived AND the All net counts the payment once:
    // (2.7 − 0.5) × 3.65 = 8.03 — not the 16+ a duplicate would produce.
    const { all } = summarizeDividends(rows, '2026-08-16');
    expect(all.count).toBe(1);
    expect(all.netPLN).toBe('8.03');
  });

  it('PLN short-circuits to a rate of 1 with no lookup; unknown currencies stay null', async () => {
    const getFxRate = vi.fn();
    const deps = makeDeps({
      getDividends: async () => [
        event({ vendorId: 'E-pln', currency: 'PLN' }),
        event({ vendorId: 'E-odd', currency: 'XXX' }),
      ],
      getFxRate,
    });
    await syncDividendsWith(deps, 'user-1');
    const byId = new Map(deps.upserted.map((p) => [p.vendorEventId, p]));
    expect(byId.get('E-pln')?.fxRateToBase).toBe('1');
    expect(byId.get('E-odd')?.fxRateToBase).toBeNull();
    expect(getFxRate).not.toHaveBeenCalled();
  });
});
