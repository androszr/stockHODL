import 'server-only';

import type Decimal from 'decimal.js';

import { addDaysIso } from '@/lib/dates';
import { getDailyCloses } from '@/lib/history/price-history';
import { fetchQuotesBestEffort } from '@/lib/holdings/live-view';
import { resolveOrCreateInstrument } from '@/lib/instruments/resolve';
import type { CalendarOverride } from '@/lib/market-data/market-clock';
import { INDEX_PROXIES, INDEX_PROXY_SYMBOLS, type IndexProxy } from '@/lib/market-strip/compose';
import { dec, pctChange } from '@/lib/money';

import type { FigureSource } from './source';

export async function loadProxyCloses(
  proxy: IndexProxy,
  window: { from: string; to: string },
): Promise<Map<string, string>> {
  try {
    const resolved = await resolveOrCreateInstrument({
      symbol: proxy.proxySymbol,
      displayName: proxy.displayName,
      exchange: proxy.exchange,
      currency: 'USD',
    });
    if (!resolved.ok) return new Map();
    return await getDailyCloses(
      { id: resolved.id, symbol: proxy.proxySymbol, currency: resolved.currency },
      window,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'benchmark history failed';
    console.error(`Day report benchmark failed (${proxy.proxySymbol}): ${message}`);
    return new Map();
  }
}

export interface BenchmarkDayChange {
  indexName: string;
  proxySymbol: string;
  dayPct: Decimal | null;
  extendedPct: Decimal | null;
  extendedKind: 'early' | 'late' | null;
}

export async function benchmarkDayChanges(
  dayISO: string,
  source: FigureSource,
  overrides: readonly CalendarOverride[],
): Promise<BenchmarkDayChange[]> {
  // The caller's calendar is part of this boundary even though stored closes,
  // rather than weekday arithmetic, currently identify the prior session.
  void overrides;
  if (source === 'live') {
    const { quotes } = await fetchQuotesBestEffort(INDEX_PROXY_SYMBOLS);
    return INDEX_PROXIES.map((proxy) => {
      const quote = quotes.get(proxy.proxySymbol);
      return {
        indexName: proxy.indexName,
        proxySymbol: proxy.proxySymbol,
        dayPct: quote?.dayChangePct == null ? null : dec(quote.dayChangePct),
        extendedPct: quote?.extendedChangePct == null ? null : dec(quote.extendedChangePct),
        extendedKind: quote?.extendedKind ?? null,
      };
    });
  }

  const out: BenchmarkDayChange[] = [];
  for (const proxy of INDEX_PROXIES) {
    const closes = await loadProxyCloses(proxy, { from: addDaysIso(dayISO, -21), to: dayISO });
    const dates = [...closes.keys()].filter((date) => date <= dayISO).sort();
    const tipRaw = closes.get(dayISO);
    const previousDate = dates.filter((date) => date < dayISO).at(-1);
    const previousRaw = previousDate ? closes.get(previousDate) : undefined;
    out.push({
      indexName: proxy.indexName,
      proxySymbol: proxy.proxySymbol,
      dayPct:
        tipRaw === undefined || previousRaw === undefined ? null : pctChange(dec(previousRaw), dec(tipRaw)),
      extendedPct: null,
      extendedKind: null,
    });
  }
  return out;
}
