import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { mapWithConcurrency } from '@/lib/async-pool';
import { db, dividendPayments, instruments, portfolios, transactions } from '@/lib/db';
import { massiveProvider } from '@/lib/market-data/massive';
import type { DividendEvent } from '@/lib/market-data/provider';
import { dec, fmtDecimal } from '@/lib/money';
import { computePositions, type EngineTransaction } from '@/lib/position-engine';
import { dayReportOptionLabel, type OptionPositionRow } from '@/lib/options/options-payload';

import { optionExpiriesInWeek } from './options-loader';

export const earningsSource = 'web_search' as const;
export const EARNINGS_CAPTION =
  "Earnings dates come from the day's macro search, not the market data feed.";

export interface DayReportEvent {
  symbol: string;
  kind: 'ex_dividend' | 'option_expiry';
  date: string;
  detail: string;
}

const DIVIDEND_CONCURRENCY = 5;

export async function loadVendorDividendEvents(
  symbols: readonly string[],
  dayISO: string,
  load: (symbol: string, day: string) => Promise<DividendEvent[]> = (symbol, day) =>
    massiveProvider.getDividends(symbol, day),
): Promise<DayReportEvent[]> {
  const batches = await mapWithConcurrency(symbols, DIVIDEND_CONCURRENCY, async (symbol) => {
    try {
      const vendor = await load(symbol, dayISO);
      return vendor
        .filter((event) => event.exDate === dayISO)
        .map((event): DayReportEvent => ({
          symbol,
          kind: 'ex_dividend',
          date: dayISO,
          detail: `USD ${fmtDecimal(dec(event.cashAmount), 0, 4)} per share`,
        }));
    } catch {
      return [];
    }
  });
  return batches.flat();
}

export async function loadEventsForDay(
  userId: string,
  symbols: readonly string[],
  dayISO: string,
  lots: readonly OptionPositionRow[],
): Promise<DayReportEvent[]> {
  const rawRows = await db
    .select({
      id: transactions.id,
      instrumentId: transactions.instrumentId,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      currency: instruments.currency,
      side: transactions.side,
      quantity: transactions.quantity,
      price: transactions.price,
      fees: transactions.fees,
      fxRateToBase: transactions.fxRateToBase,
      tradeDate: transactions.tradeDate,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(eq(portfolios.userId, userId));
  const txs: EngineTransaction[] = rawRows.map((row) => ({
    ...row,
    side: row.side === 'sell' ? 'sell' : 'buy',
  }));
  const held = new Set(
    computePositions(txs.filter((row) => row.tradeDate <= dayISO))
      .filter((position) => position.quantity.gt(0))
      .map((position) => position.symbol),
  );
  const allowed = [...new Set(symbols)].filter((symbol) => held.has(symbol));
  const events = new Map<string, DayReportEvent>();

  if (allowed.length > 0) {
    const stored = await db
      .select({
        symbol: instruments.symbol,
        amount: dividendPayments.amountPerShare,
        currency: dividendPayments.currency,
      })
      .from(dividendPayments)
      .innerJoin(portfolios, eq(dividendPayments.portfolioId, portfolios.id))
      .innerJoin(instruments, eq(dividendPayments.instrumentId, instruments.id))
      .where(
        and(
          eq(portfolios.userId, userId),
          eq(dividendPayments.exDate, dayISO),
          eq(dividendPayments.deleted, false),
          inArray(instruments.symbol, allowed),
        ),
      );
    for (const row of stored) {
      events.set(`${row.symbol}|${dayISO}`, {
        symbol: row.symbol,
        kind: 'ex_dividend',
        date: dayISO,
        detail: `${row.currency} ${fmtDecimal(dec(row.amount), 0, 4)} per share`,
      });
    }

    for (const event of await loadVendorDividendEvents(allowed, dayISO)) {
      events.set(`${event.symbol}|${dayISO}`, event);
    }
  }

  for (const lot of optionExpiriesInWeek(lots, dayISO)) {
    const key = `option|${lot.ticker}|${lot.expirationDate}`;
    if (events.has(key)) continue;
    events.set(key, {
      symbol: lot.underlying,
      kind: 'option_expiry',
      date: lot.expirationDate,
      detail: `${dayReportOptionLabel(lot)} expires ${lot.expirationDate}`,
    });
  }
  return [...events.values()].sort((a, b) =>
    a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date.localeCompare(b.date),
  );
}
