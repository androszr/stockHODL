import { describe, expect, it } from 'vitest';

import type { ChartPoint } from '@/lib/charts/series';
import type { HoldingQuote } from '@/lib/holdings/live-payload';
import { composeMarketStrip, INDEX_PROXY_SYMBOLS } from '@/lib/market-strip/compose';
import type { FxFigures } from '@/lib/market-strip/fx';
import type { MarketSessionInfo } from '@/lib/market-data/provider';
import { dec, pctChange } from '@/lib/money';

import { marketSeriesKeyParamSchema, marketStripPayloadSchema, marketTileKeySchema } from './market-strip';

/**
 * The strip's anti-drift pair, the `live-payload-contract.test.ts`
 * arrangement: the REAL composer's output goes through the schema the Swift
 * structs are generated from, so a field the composer starts producing and
 * the schema does not know fails here rather than silently never reaching the
 * phone.
 *
 * The negative cases pin the money rule: a numeric `last` is the one shape
 * that would make quicktype emit a `Double` for an amount.
 */

function quote(overrides: Partial<HoldingQuote> = {}): HoldingQuote {
  return {
    price: '645.32',
    currency: 'USD',
    prevClose: '639.95',
    dayChangeAmt: dec('645.32').minus(dec('639.95')).toString(),
    dayChangePct: pctChange(dec('639.95'), dec('645.32'))!.toString(),
    extendedChangePct: null,
    extendedKind: null,
    extendedEndedAtMs: null,
    extendedLive: false,
    ...overrides,
  };
}

const MARKET: MarketSessionInfo = {
  status: 'open',
  nextTransitionAtMs: 1_756_000_000_000,
  nextTransitionKind: 'close',
  pollingResumesAtMs: null,
};

const SPARK: ChartPoint[] = [
  { t: 1_755_950_100_000, v: '640.10' },
  { t: 1_755_950_400_000, v: '645.32', p: 'post' },
];

const FX: FxFigures = {
  last: '3,7955',
  dayPct: { text: '+0,12%', direction: 'gain' },
  spark: [{ t: 1_755_950_100_000, v: '3.7900' }],
};

function realPayload() {
  return composeMarketStrip(
    new Map(INDEX_PROXY_SYMBOLS.map((symbol) => [symbol, quote()])),
    new Map(INDEX_PROXY_SYMBOLS.map((symbol) => [symbol, SPARK])),
    MARKET,
    FX,
  );
}

describe('marketStripPayloadSchema mirrors the real composer', () => {
  it('accepts a fully-populated payload', () => {
    const parsed = marketStripPayloadSchema.safeParse(realPayload());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('accepts the fully degraded payload — no quotes, no sparks', () => {
    const payload = composeMarketStrip(
      new Map(),
      new Map(),
      { ...MARKET, status: 'closed', pollingResumesAtMs: 1_756_100_000_000 },
      { last: null, dayPct: null, spark: [] },
    );

    const parsed = marketStripPayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(payload.tiles).toHaveLength(3);
    expect(payload.tiles.every((tile) => tile.proxySymbol.length > 0)).toBe(true);
  });

  it('carries no field the contract does not name', () => {
    const payload = realPayload();
    const tileKeys = new Set(['key', 'indexName', 'proxySymbol', 'last', 'dayPct', 'trend', 'spark']);

    expect(Object.keys(payload).sort()).toEqual(['fx', 'market', 'tiles']);
    for (const tile of payload.tiles) {
      for (const key of Object.keys(tile)) {
        expect(tileKeys.has(key), `unexpected tile key ${key} — add it to the contract`).toBe(
          true,
        );
      }
    }
  });

  it('refuses a numeric price — money never crosses the wire as a number', () => {
    const payload = realPayload();
    const broken = {
      ...payload,
      tiles: [{ ...payload.tiles[0], last: 645.32 }, ...payload.tiles.slice(1)],
    };

    expect(marketStripPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it('refuses a spark point whose value is not a decimal string', () => {
    const payload = realPayload();
    const broken = {
      ...payload,
      tiles: [
        { ...payload.tiles[0], spark: [{ t: 1_755_950_100_000, v: 640.1 }] },
        ...payload.tiles.slice(1),
      ],
    };

    expect(marketStripPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it('refuses a tile with no proxy disclosure', () => {
    const payload = realPayload();
    const withoutProxy: Record<string, unknown> = { ...payload.tiles[0] };
    delete withoutProxy.proxySymbol;
    const broken = { ...payload, tiles: [withoutProxy, ...payload.tiles.slice(1)] };

    expect(marketStripPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it('refuses a numeric fx rate — a rate is money on the wire too', () => {
    const payload = realPayload();
    const broken = { ...payload, fx: { ...payload.fx, last: 3.7955 } };

    expect(marketStripPayloadSchema.safeParse(broken).success).toBe(false);
  });

  it('the tile key is a closed enum, and the path param normalises into it', () => {
    expect(marketTileKeySchema.safeParse('AAPL').success).toBe(false);
    expect(marketTileKeySchema.safeParse('C:USDPLN').success).toBe(false);
    expect(marketTileKeySchema.safeParse('USDPLN').success).toBe(true);

    expect(marketSeriesKeyParamSchema.parse(' usdpln ')).toBe('USDPLN');
    expect(marketSeriesKeyParamSchema.parse('spy')).toBe('SPY');
    expect(marketSeriesKeyParamSchema.safeParse('aapl').success).toBe(false);
    expect(marketSeriesKeyParamSchema.safeParse('C:USDPLN').success).toBe(false);
  });
});
