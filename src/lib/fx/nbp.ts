import 'server-only';

import { and, eq, gte, lte } from 'drizzle-orm';

import { db, fxRates } from '@/lib/db';
import { dec, toNumeric } from '@/lib/money';
import { CURRENCIES } from '@/lib/validation';

import {
  addDaysIso,
  carryForwardRates,
  d1Window,
  isPendingPublication,
  lastWeekdayBefore,
  mapNbpRates,
  NBP_FIRST_DATE,
  nbpRatesResponseSchema,
  splitDateRange,
  type NbpRate,
} from './nbp-mapping';

/**
 * NBP Table A mid rates — the tax-correct FX source for a Polish filer. The
 * only file that knows the vendor URL; a client component never contacts NBP
 * (server-mediation rule, honoured the same way as `massive.ts`). NBP is
 * deliberately NOT behind `QuoteProvider`: that contract is equity
 * quotes/candles/symbol search, and FX is a different shape.
 *
 * `fx_rates` is a permanent read-through cache: a published NBP rate never
 * changes, so caching is correctness, not optimisation. Rows are keyed by
 * NBP's own `effectiveDate` — NEVER the trade date, which would silently
 * serve day D's rate where D-1's belongs. Failures are never persisted.
 */

const BASE_URL = 'https://api.nbp.pl/api';

/**
 * Generous on purpose. Measured against api.nbp.pl (55 direct requests
 * including a 20-way burst, 2026-08): TTFB ~116 ms cold — DNS 3, TCP
 * 29, TLS 70 — steady-state p50 ~120 ms, worst 300 ms, zero throttling. So
 * every millisecond past ~1 s is tail-only, and a timeout here costs the user
 * a wrong-looking "Couldn't reach NBP" on a request that would have landed.
 * Deliberately longer than `massive.ts`'s 5 s: a quote is re-fetched on the
 * next poll, whereas this rate is about to be frozen into cost basis, and the
 * field stays editable the whole time the lookup runs.
 */
const FETCH_TIMEOUT_MS = 12_000;

export type FxRateResult =
  | { ok: true; rate: string; rateDate: string }
  | { ok: false; reason: 'no_rate' | 'not_published' | 'unavailable' };

/**
 * The D-1 rate (art. 11a PIT/CIT): the NBP mid from the last business day
 * strictly before `tradeDate`. `currency` MUST already be validated against
 * the closed `CURRENCIES` list (the Server Action does) — it is interpolated
 * into the request path.
 */
export async function getFxRateToPln(input: {
  currency: string;
  tradeDate: string;
}): Promise<FxRateResult> {
  const { currency, tradeDate } = input;

  // ISO date strings compare lexicographically. A trade on or before the API's
  // first data day has no prior published rate at all.
  if (tradeDate <= NBP_FIRST_DATE) return { ok: false, reason: 'no_rate' };

  const { from, to } = d1Window(tradeDate);

  // "Today" as a calendar string in Warsaw (not money): a window that starts
  // in the future cannot contain a published rate yet.
  const todayWarsaw = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
  }).format(new Date());
  if (to > todayWarsaw) return { ok: false, reason: 'not_published' };

  // Cache read. A hit at the last Mon–Fri day before the trade date is sound:
  // only weekend days separate it from the trade date and NBP never publishes
  // on weekends, so no later rate can exist. If that weekday was a Polish
  // holiday the row can never exist — a clean miss, and NBP resolves the true
  // prior business day below (one idempotent extra fetch, accepted cost).
  const [cached] = await db
    .select({ rate: fxRates.rate, asOf: fxRates.asOf })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.base, currency),
        eq(fxRates.quote, 'PLN'),
        eq(fxRates.asOf, lastWeekdayBefore(tradeDate)),
      ),
    );
  if (cached) {
    // Re-normalised through dec() so the UI shows 3.7324, not the stored
    // numeric(20,10) form 3.7324000000.
    return { ok: true, rate: dec(cached.rate).toString(), rateDate: cached.asOf };
  }

  // Safe in the path only because the action already validated the currency
  // against the closed CURRENCIES enum.
  const code = currency.toLowerCase();
  const url = `${BASE_URL}/exchangerates/rates/a/${code}/${from}/${to}/?format=json`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    // Message only — never a URL (same logging discipline as massive.ts).
    const message = error instanceof Error ? error.message : 'NBP fetch failed';
    console.error(`NBP FX fetch failed: ${message}`);
    return { ok: false, reason: 'unavailable' };
  }

  // A window with no published day 404s with a PLAIN-TEXT body
  // ("404 NotFound - Not Found - Brak danych") — calling .json() on it would
  // throw and misclassify "no rate" as "NBP broken". Handled before any body
  // read.
  if (response.status === 404) return { ok: false, reason: 'no_rate' };
  if (!response.ok) {
    console.error(`NBP FX fetch failed: HTTP ${response.status}`);
    return { ok: false, reason: 'unavailable' };
  }

  let rows: ReturnType<typeof mapNbpRates>;
  try {
    rows = mapNbpRates(nbpRatesResponseSchema.parse(await response.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'NBP parse failed';
    console.error(`NBP FX parse failed: ${message}`);
    return { ok: false, reason: 'unavailable' };
  }
  if (rows.length === 0) return { ok: false, reason: 'no_rate' };

  // Persist every published day the window returned — rates are immutable, so
  // each row answers future lookups permanently. The key is NBP's own
  // effectiveDate; onConflictDoNothing makes re-fetches idempotent.
  await db
    .insert(fxRates)
    .values(
      rows.map((r) => ({
        base: currency,
        quote: 'PLN',
        asOf: r.effectiveDate,
        rate: toNumeric(dec(r.rate), 10),
        source: 'nbp',
      })),
    )
    .onConflictDoNothing({ target: [fxRates.base, fxRates.quote, fxRates.asOf] });

  // Ascending order from NBP: the last element is the newest published day
  // strictly before the trade date — the D-1 rate.
  const last = rows[rows.length - 1];

  // For a trade date of tomorrow, D-1 is TODAY — a day whose rate only exists
  // after NBP's ~12:15 CET publication. Before that, the window returns rates
  // only through yesterday: a correct-looking but WRONG rate that would be
  // frozen into cost basis if saved. Report it honestly as not-yet-published
  // instead of `ok`. (The rows fetched above are still real published rates,
  // so persisting them first is correct.)
  if (isPendingPublication({ to, todayWarsaw, lastEffectiveDate: last.effectiveDate })) {
    return { ok: false, reason: 'not_published' };
  }

  return { ok: true, rate: last.rate, rateDate: last.effectiveDate };
}

/**
 * Valuation-path timeout, deliberately shorter than the form path's 12 s: this
 * runs inside the Holdings server render, where a slow NBP should degrade to a
 * cost-only card — unlike the form, where the rate is about to be frozen into
 * cost basis and waiting is worth it.
 */
const CURRENT_FETCH_TIMEOUT_MS = 4_000;

/** Successes only — a cached failure would hide NBP recovering for 15 min. */
const CURRENT_RATE_TTL_MS = 15 * 60 * 1000;

interface CurrentRateMemoEntry {
  at: number;
  result: Extract<FxRateResult, { ok: true }>;
}

/**
 * In-process, per-instance memo so Holdings reloads don't hit NBP every time.
 * Best-effort on serverless (evaporates on cold start), fine at one user.
 */
const currentRateMemo = new Map<string, CurrentRateMemoEntry>();

/**
 * The most recently published Table A mid — the VALUATION rate, for marking a
 * position to market today. NOT the tax rate: `getFxRateToPln` above answers
 * the D-1 trade-date question and is the only function allowed anywhere near
 * cost basis. Nothing from here may leak into transaction entry.
 *
 * Uses NBP's `last/1` endpoint — "the newest published rate", whatever day
 * that was — so there is no window math and no publication-timing edge. The
 * row is persisted into the immutable `fx_rates` cache (it is a real published
 * rate, keyed by NBP's own effectiveDate) and memoized in-process for 15 min.
 * PLN itself is not handled here: callers short-circuit it to a fixed 1.
 */
export async function getCurrentFxRateToPln(currency: string): Promise<FxRateResult> {
  // Closed allowlist BEFORE anything is interpolated into a URL path. An
  // unknown code is a caller bug, reported as a typed miss — never fetched.
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    return { ok: false, reason: 'no_rate' };
  }

  const hit = currentRateMemo.get(currency);
  if (hit && Date.now() - hit.at < CURRENT_RATE_TTL_MS) return hit.result;

  // Safe in the path only because of the allowlist check above — the raw
  // input never reaches the URL, only this post-validation lowercased code.
  const code = currency.toLowerCase();
  const url = `${BASE_URL}/exchangerates/rates/a/${code}/last/1/?format=json`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(CURRENT_FETCH_TIMEOUT_MS),
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    // Message only — never a URL (same logging discipline as above).
    const message = error instanceof Error ? error.message : 'NBP fetch failed';
    console.error(`NBP latest FX fetch failed: ${message}`);
    return { ok: false, reason: 'unavailable' };
  }

  // Same plain-text-body 404 caveat as the D-1 path: never .json() it.
  if (response.status === 404) return { ok: false, reason: 'no_rate' };
  if (!response.ok) {
    console.error(`NBP latest FX fetch failed: HTTP ${response.status}`);
    return { ok: false, reason: 'unavailable' };
  }

  let rows: ReturnType<typeof mapNbpRates>;
  try {
    rows = mapNbpRates(nbpRatesResponseSchema.parse(await response.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'NBP parse failed';
    console.error(`NBP latest FX parse failed: ${message}`);
    return { ok: false, reason: 'unavailable' };
  }
  if (rows.length === 0) return { ok: false, reason: 'no_rate' };

  const last = rows[rows.length - 1];

  // Persist the published rate permanently (immutable, keyed by NBP's own
  // effectiveDate, idempotent under onConflictDoNothing). A cache-write
  // failure must not cost the render a rate that is already in hand.
  try {
    await db
      .insert(fxRates)
      .values({
        base: currency,
        quote: 'PLN',
        asOf: last.effectiveDate,
        rate: toNumeric(dec(last.rate), 10),
        source: 'nbp',
      })
      .onConflictDoNothing({ target: [fxRates.base, fxRates.quote, fxRates.asOf] });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'insert failed';
    console.error(`NBP latest FX cache write failed: ${message}`);
  }

  const result = { ok: true as const, rate: last.rate, rateDate: last.effectiveDate };
  currentRateMemo.set(currency, { at: Date.now(), result });
  return result;
}

/* ------------------------------------------------------------------ *
 * Range series (M5 charts) — the same read-through `fx_rates` pattern
 * as the single-date lookups above, extended to inclusive date ranges:
 * cached rows answer first, NBP's range endpoint fills holes (in
 * ≤360-day chunks, the API caps a request at 367 days), and every
 * published day fetched is persisted permanently.
 * ------------------------------------------------------------------ */

/** Lookback so the first window days can inherit a prior published rate. */
const RANGE_SEED_DAYS = 14;

/**
 * Weekday holes in the cache are ambiguous (Polish holiday vs never fetched),
 * so a hole triggers ONE NBP range fetch per chunk — and this memo keeps a
 * permanent holiday hole from re-triggering that fetch on every chart view.
 * Per-instance, successes-and-attempts alike (the DB rows fetched are
 * permanent; only the "should I re-ask" decision is memoized).
 */
const RANGE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_RANGE_CHECK_ENTRIES = 500;
const rangeCheckMemo = new Map<string, number>();

/** Whether [from..to] contains a weekday with no cached row — a possible hole. */
function hasWeekdayHole(present: ReadonlySet<string>, from: string, to: string): boolean {
  for (let day = from; day <= to; day = addDaysIso(day, 1)) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (!present.has(day)) return true;
  }
  return false;
}

/**
 * Dense per-calendar-day FX rates to PLN over [from..to]: every day carries
 * the newest rate published on or before it (carry-forward — the D-1 rule's
 * semantics applied to a series). PLN short-circuits to a constant '1' with
 * no lookup. Best-effort: an NBP failure degrades to whatever the cache
 * already answers, logs, and never throws.
 *
 * `currency` MUST already be validated against the closed `CURRENCIES` list —
 * it is interpolated into the request path (same contract as the lookups
 * above); an unknown code returns an empty map without ever being fetched.
 */
export async function getFxRatesForRange(
  currency: string,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  if (from > to) return new Map();

  if (currency === 'PLN') {
    const dense = new Map<string, string>();
    for (let day = from; day <= to; day = addDaysIso(day, 1)) dense.set(day, '1');
    return dense;
  }

  if (!(CURRENCIES as readonly string[]).includes(currency)) return new Map();

  // Published rates exist only from NBP_FIRST_DATE and, at the newest, up to
  // today — clamp the fetchable span so holes outside it never look missing.
  const todayWarsaw = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
  }).format(new Date());
  const seedFrom = addDaysIso(from, -RANGE_SEED_DAYS);
  const fetchFrom = seedFrom < NBP_FIRST_DATE ? NBP_FIRST_DATE : seedFrom;
  const fetchTo = to < todayWarsaw ? to : todayWarsaw;

  // Cache read for the seeded span.
  let cached: NbpRate[] = [];
  try {
    const rows = await db
      .select({ asOf: fxRates.asOf, rate: fxRates.rate })
      .from(fxRates)
      .where(
        and(
          eq(fxRates.base, currency),
          eq(fxRates.quote, 'PLN'),
          gte(fxRates.asOf, fetchFrom),
          lte(fxRates.asOf, fetchTo),
        ),
      );
    cached = rows.map((r) => ({ effectiveDate: r.asOf, rate: dec(r.rate).toString() }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fx cache read failed';
    console.error(`NBP FX range cache read failed: ${message}`);
  }

  const present = new Set(cached.map((r) => r.effectiveDate));
  const fetched: NbpRate[] = [];

  // Safe in the path only because of the allowlist check above.
  const code = currency.toLowerCase();
  const now = Date.now();

  for (const chunk of splitDateRange(fetchFrom, fetchTo)) {
    if (!hasWeekdayHole(present, chunk.from, chunk.to)) continue;

    const memoKey = `${currency}:${chunk.from}:${chunk.to}`;
    const checkedAt = rangeCheckMemo.get(memoKey);
    if (checkedAt !== undefined && now - checkedAt < RANGE_CHECK_TTL_MS) continue;

    const url = `${BASE_URL}/exchangerates/rates/a/${code}/${chunk.from}/${chunk.to}/?format=json`;
    let rows: NbpRate[];
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      // Same plain-text-body 404 caveat as the lookups above: a window with no
      // published day is an ANSWER (all-holiday chunk), never .json()'d.
      if (response.status === 404) {
        rangeCheckMemo.set(memoKey, now);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      rows = mapNbpRates(nbpRatesResponseSchema.parse(await response.json()));
    } catch (error) {
      // Message only — never a URL (same logging discipline as above). The
      // memo is NOT set on failure: a transient outage must retry, only a
      // definitive answer suppresses re-asking.
      const message = error instanceof Error ? error.message : 'NBP fetch failed';
      console.error(`NBP FX range fetch failed: ${message}`);
      continue;
    }

    if (rangeCheckMemo.size >= MAX_RANGE_CHECK_ENTRIES) {
      const oldest = rangeCheckMemo.keys().next().value;
      if (oldest !== undefined) rangeCheckMemo.delete(oldest);
    }
    rangeCheckMemo.set(memoKey, now);

    const missing = rows.filter((r) => !present.has(r.effectiveDate));
    for (const row of missing) present.add(row.effectiveDate);
    fetched.push(...missing);

    // Persist every newly seen published day — rates are immutable, keyed by
    // NBP's own effectiveDate, idempotent under onConflictDoNothing. A write
    // failure must not cost this render the rates already in hand.
    if (missing.length > 0) {
      try {
        await db
          .insert(fxRates)
          .values(
            missing.map((r) => ({
              base: currency,
              quote: 'PLN',
              asOf: r.effectiveDate,
              rate: toNumeric(dec(r.rate), 10),
              source: 'nbp',
            })),
          )
          .onConflictDoNothing({ target: [fxRates.base, fxRates.quote, fxRates.asOf] });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'insert failed';
        console.error(`NBP FX range cache write failed: ${message}`);
      }
    }
  }

  return carryForwardRates([...cached, ...fetched], from, to);
}
