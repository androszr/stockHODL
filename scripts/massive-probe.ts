/**
 * Local health probe for the Massive market-data integration.
 *
 *   pnpm probe:massive
 *
 * Read-only against the vendor, no HTTP route, no DB writes — the same local
 * CLI pattern as `scripts/recover.ts` (NODE_OPTIONS='--conditions=react-server'
 * lets tsx import the `server-only` adapter). It answers, with your own eyes:
 *
 *   1. Does the key work? (`/v1/marketstatus/now`)
 *   2. What does a Starter-tier snapshot actually contain, and how old is the
 *      price really? (getQuotes for AAPL + SPY, with the raw fields listed)
 *   3. Does search work? (searchSymbols('nike'))
 *   4. Do daily bars come back? (getDailyCloses for AAPL, last 5 days, plus
 *      the raw previous-day bar as a baseline check)
 *   5. Do 5-minute intraday bars come back? (getAggregates for AAPL over the
 *      last 5 days, epoch-ms bounds — the 1D/5D chart path)
 *
 * Exits 0 only if every call succeeds; nonzero with the failing call named.
 * The key itself is never printed.
 */

import 'dotenv/config';

import { env } from '../src/lib/env';
import { massiveProvider } from '../src/lib/market-data/massive';
import {
  mapTickerProfile,
  tickerProfileSchema,
} from '../src/lib/market-data/massive-mapping';

const BASE_URL = 'https://api.massive.com';

function die(step: string, error: unknown): never {
  const message = error instanceof Error ? error.message : `${error}`;
  console.error(`\n✗ FAILED at ${step}: ${message}\n`);
  process.exit(1);
}

async function rawGet(path: string): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${env().STOCK_API}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * `pnpm probe:massive profile <SYMBOL>` — the ONE mode that exists to make a
 * mapper honest rather than to check health.
 *
 * `mapTickerProfile` reads two fields out of `/v3/reference/tickers/{ticker}`
 * (`sic_description`, `sic_code`), and a hermetic test proves only that it
 * reads whatever the fixture contains. This prints the RAW body's key set, so
 * the field names are verified against the vendor instead of assumed.
 * Anything it does not list maps to null, permanently and visibly.
 *
 * `locale` and `address.country` are still printed even though nothing maps
 * them: that is the evidence (probed 2026-08-18) for why there is no domicile
 * dimension — `address` carries no `country` key on any ticker, and `locale`
 * is `'us'` for every ticker because it means "listed on a US market".
 */
async function probeProfile(symbol: string) {
  console.log(`massive-probe — ticker profile for ${symbol}\n`);

  let body: unknown;
  try {
    body = await rawGet(`/v3/reference/tickers/${encodeURIComponent(symbol)}`);
  } catch (error) {
    die(`/v3/reference/tickers/${symbol}`, error);
  }

  const results = (body as { results?: Record<string, unknown> }).results;
  if (!results || typeof results !== 'object') {
    console.log('results: absent or null — every profile field maps to null.');
    process.exit(0);
  }

  console.log(`results keys      : ${Object.keys(results).sort().join(', ')}`);
  const address = results.address;
  if (address && typeof address === 'object') {
    console.log(`address keys      : ${Object.keys(address).sort().join(', ')}`);
  }
  for (const field of ['sic_description', 'sic_code', 'locale'] as const) {
    console.log(`${field.padEnd(18)}: ${JSON.stringify(results[field] ?? null)}`);
  }
  console.log(
    `address.country   : ${JSON.stringify(
      (address as { country?: unknown } | undefined)?.country ?? null,
    )}`,
  );

  const parsed = tickerProfileSchema.safeParse(body);
  console.log(
    `\nmapped            : ${
      parsed.success ? JSON.stringify(mapTickerProfile(parsed.data)) : 'PARSE FAILED'
    }`,
  );
  process.exit(0);
}

async function main() {
  const [mode, argument] = process.argv.slice(2);
  if (mode === 'profile') {
    await probeProfile((argument ?? 'AAPL').toUpperCase());
    return;
  }

  console.log('massive-probe — Starter tier health check\n');

  // --- 1. Market status (also proves the key) ---------------------------------
  try {
    const status = (await rawGet('/v1/marketstatus/now')) as {
      market?: string;
      serverTime?: string;
    };
    console.log(`[1/5] market status : market=${status.market} serverTime=${status.serverTime}`);
  } catch (error) {
    die('/v1/marketstatus/now (is STOCK_API valid?)', error);
  }

  // --- 2. Batch quotes + freshness evidence -----------------------------------
  try {
    const outcomes = await massiveProvider.getQuotes(['AAPL', 'SPY']);
    for (const [symbol, outcome] of outcomes) {
      if (!outcome.ok) {
        throw new Error(`${symbol}: ${outcome.reason} ${outcome.message ?? ''}`);
      }
      const ageMinutes = ((Date.now() - outcome.quote.asOf.getTime()) / 60_000).toFixed(1);
      console.log(
        `[2/5] quote ${symbol.padEnd(4)} : price=${outcome.quote.price} ` +
          `prevClose=${outcome.quote.prevClose} asOf=${outcome.quote.asOf.toISOString()} ` +
          `asOfSource=${outcome.quote.asOfSource} age=${ageMinutes}min ` +
          `status=${outcome.quote.marketStatus} delay=${outcome.quote.delaySeconds}s`,
      );
      if (outcome.quote.asOfSource === 'fetch') {
        console.log(
          `[2/5]   NOTE ${symbol}: no vendor timestamp on this payload — ` +
            `asOf is fetch time, the age above is NOT meaningful`,
        );
      }
    }

    // Which raw fields does the Starter payload actually carry? The mapper
    // tolerates absences; this is the empirical answer the plan asked for.
    // No `type` param: the endpoint rejects it alongside a ticker list with
    // 400 "Cannot specify tickers and type." (verified live 2026-08-09).
    const raw = (await rawGet('/v3/snapshot?ticker.any_of=AAPL&limit=1')) as {
      results?: Record<string, unknown>[];
    };
    const first = raw.results?.[0];
    if (first) {
      console.log(`[2/5] raw snapshot fields present: ${Object.keys(first).sort().join(', ')}`);
    }
  } catch (error) {
    die('getQuotes(AAPL, SPY)', error);
  }

  // --- 3. Symbol search --------------------------------------------------------
  try {
    const { results, degraded } = await massiveProvider.searchSymbols('nike');
    if (degraded) throw new Error('search returned degraded');
    if (results.length === 0) throw new Error('search returned zero results for "nike"');
    for (const match of results.slice(0, 3)) {
      console.log(
        `[3/5] search "nike" : ${match.symbol.padEnd(6)} ${match.name} ` +
          `(${match.exchangeDisplay}, ${match.currency ?? '?'})`,
      );
    }
  } catch (error) {
    die("searchSymbols('nike')", error);
  }

  // --- 4. Daily bars + previous-close baseline ---------------------------------
  try {
    const candles = await massiveProvider.getDailyCloses('AAPL', isoDaysAgo(5), isoDaysAgo(0));
    if (candles.length === 0) throw new Error('no daily bars returned');
    const last = candles[candles.length - 1];
    console.log(
      `[4/5] daily bars    : ${candles.length} bars; last close=${last.close} ` +
        `at ${new Date(last.t).toISOString().slice(0, 10)}`,
    );

    const prev = (await rawGet('/v2/aggs/ticker/AAPL/prev')) as {
      results?: { c?: number; t?: number }[];
    };
    const bar = prev.results?.[0];
    if (bar?.c !== undefined) {
      console.log(`[4/5] prev-day bar  : close=${bar.c} (raw baseline check)`);
    }
  } catch (error) {
    die('getDailyCloses(AAPL) / prev-day bar', error);
  }

  // --- 5. Intraday 5-minute bars (the 1D/5D chart path) ------------------------
  try {
    const fromMs = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const candles = await massiveProvider.getAggregates('AAPL', {
      multiplier: 5,
      timespan: 'minute',
      from: String(fromMs),
      to: String(Date.now()),
    });
    if (candles.length === 0) throw new Error('no 5-minute bars returned');
    const last = candles[candles.length - 1];
    console.log(
      `[5/5] 5-minute bars : ${candles.length} bars over 5 days; last close=${last.close} ` +
        `at ${new Date(last.t).toISOString()}`,
    );
  } catch (error) {
    die('getAggregates(AAPL, 5/minute)', error);
  }

  console.log('\n✓ All probes succeeded.\n');
  process.exit(0);
}

main();
