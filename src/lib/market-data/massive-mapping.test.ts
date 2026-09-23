import { describe, expect, it, vi } from 'vitest';

import { dec, pctChange } from '@/lib/money';

import { regularSessionFor, statusAt } from './market-clock';
import {
  aggsPath,
  deriveDayPair,
  dividendsParams,
  dividendsResponseSchema,
  mapDividendResults,
  headlineSessionPrice,
  mapAggsResults,
  mapBrandingIconUrl,
  mapMarketStatusNow,
  mapSnapshotResult,
  mapStreamAgg,
  mapTickerProfile,
  mapTickerResults,
  mapUpcomingToOverrides,
  marketStatusNowSchema,
  marketUpcomingSchema,
  parseStreamFrame,
  reconcileTransition,
  rolledPrevClose,
  snapshotParams,
  snapshotResponseSchema,
  substituteDayPair,
  tickerOverviewSchema,
  tickerProfileSchema,
  type SnapshotResult,
  type TickerItem,
} from './massive-mapping';
import { rankDirectoryMatches } from './nasdaq-directory';

// CTX.now is SUNDAY 2026-08-09 12:00Z: the closed-branch attribution resolves
// to Friday 2026-08-07's late session, which ended Sat 00:00Z (20:00 ET + 4 h).
// The horizon predates everything — full calendar coverage, no suppression.
const CTX = {
  delaySeconds: 900,
  source: 'massive',
  now: new Date('2026-08-09T12:00:00Z'),
  overrides: [],
  calendarKnownFromISO: '2020-01-01',
};

const FRIDAY_LATE_END = Date.UTC(2026, 7, 8, 0, 0);

/** Minimal valid snapshot result — spread overrides per case. */
function snap(overrides: Partial<SnapshotResult> = {}): SnapshotResult {
  return {
    ticker: 'AAPL',
    type: 'stocks',
    market_status: 'open',
    last_trade: { price: 75.0875, sip_timestamp: 1_700_000_000_000_000_000 },
    last_minute: { close: 75.09 },
    session: { previous_close: 74.5, close: 75.1, price: 75.0875 },
    ...overrides,
  };
}

/** Minimal valid US common-stock ticker item — spread overrides per case. */
function ticker(overrides: Partial<TickerItem> = {}): TickerItem {
  return {
    ticker: 'NKE',
    name: 'Nike, Inc.',
    primary_exchange: 'XNYS',
    type: 'CS',
    locale: 'us',
    currency_name: 'usd',
    active: true,
    ...overrides,
  };
}

describe('mapSnapshotResult — money boundary', () => {
  it('maps the happy path with exact decimal strings — 75.0875 survives verbatim', () => {
    const outcome = mapSnapshotResult(snap(), CTX);
    expect(outcome).not.toBeNull();
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.price).toBe('75.0875');
    expect(outcome.quote.prevClose).toBe('74.5');
    expect(outcome.quote.symbol).toBe('AAPL');
    expect(outcome.quote.marketStatus).toBe('open');
    expect(outcome.quote.delaySeconds).toBe(900);
    expect(outcome.quote.source).toBe('massive');
  });

  it('maps the session OHLV when present — prices/vwap as decimal strings, volume a plain number', () => {
    const outcome = mapSnapshotResult(
      snap({
        session: {
          previous_close: 74.5,
          close: 75.1,
          price: 75.0875,
          open: 74.8,
          high: 75.4,
          low: 74.35,
          volume: 51234567,
          vwap: 75.0125,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.dayOpen).toBe('74.8');
    expect(outcome.quote.dayHigh).toBe('75.4');
    expect(outcome.quote.dayLow).toBe('74.35');
    expect(outcome.quote.vwap).toBe('75.0125');
    // A COUNT, not money — it stays the raw JSON number, never a string.
    expect(outcome.quote.dayVolume).toBe(51234567);
    expect(typeof outcome.quote.dayVolume).toBe('number');
  });

  it('absent session OHLV maps to null per field, never 0 — and a partial session maps only what is there', () => {
    const bare = mapSnapshotResult(snap(), CTX);
    if (!bare || !bare.ok) throw new Error('expected ok outcome');
    expect(bare.quote.dayOpen).toBeNull();
    expect(bare.quote.dayHigh).toBeNull();
    expect(bare.quote.dayLow).toBeNull();
    expect(bare.quote.dayVolume).toBeNull();
    expect(bare.quote.vwap).toBeNull();

    const partial = mapSnapshotResult(
      snap({ session: { previous_close: 74.5, price: 75.0875, open: 74.8, volume: 100 } }),
      CTX,
    );
    if (!partial || !partial.ok) throw new Error('expected ok outcome');
    expect(partial.quote.dayOpen).toBe('74.8');
    expect(partial.quote.dayVolume).toBe(100);
    expect(partial.quote.dayHigh).toBeNull();
    expect(partial.quote.dayLow).toBeNull();
    expect(partial.quote.vwap).toBeNull();
  });

  it('a session open of 0 maps — it is a price, not an absence', () => {
    const outcome = mapSnapshotResult(
      snap({ session: { previous_close: 74.5, price: 75.0875, open: 0 } }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.dayOpen).toBe('0');
  });

  it('converts sip_timestamp from nanoseconds to a ms Date, stamped asOfSource trade', () => {
    const outcome = mapSnapshotResult(snap(), CTX);
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.asOf.getTime()).toBe(1_700_000_000_000);
    expect(outcome.quote.asOfSource).toBe('trade');
  });

  it('uses the last_minute timestamp with asOfSource minute when no trade timestamp exists', () => {
    const outcome = mapSnapshotResult(
      snap({
        last_trade: undefined,
        last_minute: { close: 75.09, last_updated: 1_700_000_060_000_000_000 },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.asOf.getTime()).toBe(1_700_000_060_000);
    expect(outcome.quote.asOfSource).toBe('minute');
  });

  it('a price of 0 maps — it is a price, not an absence', () => {
    const outcome = mapSnapshotResult(
      snap({ session: { previous_close: 74.5, price: 0 } }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.price).toBe('0');
  });

  it('open: the headline is session.price — the price the vendor session figures track', () => {
    const outcome = mapSnapshotResult(snap({ market_status: 'open' }), CTX);
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.price).toBe('75.0875');
  });

  it('open falls back to last_minute.close, then session.close', () => {
    const minute = mapSnapshotResult(
      snap({ last_trade: undefined, session: { previous_close: 74.5, close: 75.1 } }),
      CTX,
    );
    if (!minute || !minute.ok) throw new Error('expected ok outcome');
    expect(minute.quote.price).toBe('75.09');
    // No vendor timestamp anywhere: asOf degrades to fetch time, and
    // asOfSource announces the synthesis — it must never read as a trade time.
    expect(minute.quote.asOf).toBe(CTX.now);
    expect(minute.quote.asOfSource).toBe('fetch');

    const sessionClose = mapSnapshotResult(
      snap({
        last_trade: undefined,
        last_minute: undefined,
        session: { previous_close: 74.5, close: 75.1 },
      }),
      CTX,
    );
    if (!sessionClose || !sessionClose.ok) throw new Error('expected ok outcome');
    expect(sessionClose.quote.price).toBe('75.1');
    // A session-close price with no timestamp is the exact case asOfSource
    // exists for: hours-old data must not look zero minutes old.
    expect(sessionClose.quote.asOf).toBe(CTX.now);
    expect(sessionClose.quote.asOfSource).toBe('fetch');
  });

  it('closed: the headline is the official close, not the lingering extended price', () => {
    const outcome = mapSnapshotResult(snap({ market_status: 'closed' }), CTX);
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    // session.price (75.0875) is present but the close (75.1) wins — Yahoo's
    // behavior: outside regular hours the big number is the official close.
    expect(outcome.quote.price).toBe('75.1');
  });

  it('closed falls back to last_minute.close, then session.price', () => {
    const minute = mapSnapshotResult(
      snap({ market_status: 'closed', session: { previous_close: 74.5, price: 75.2 } }),
      CTX,
    );
    if (!minute || !minute.ok) throw new Error('expected ok outcome');
    expect(minute.quote.price).toBe('75.09');

    const sessionPrice = mapSnapshotResult(
      snap({
        market_status: 'closed',
        last_minute: undefined,
        session: { previous_close: 74.5, price: 75.2 },
      }),
      CTX,
    );
    if (!sessionPrice || !sessionPrice.ok) throw new Error('expected ok outcome');
    expect(sessionPrice.quote.price).toBe('75.2');
  });

  it('unknown status uses the closed chain — never the live-price chain on a guess', () => {
    const outcome = mapSnapshotResult(snap({ market_status: 'half_day' }), CTX);
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.marketStatus).toBe('unknown');
    expect(outcome.quote.price).toBe('75.1');
  });

  it('no usable price in any field → ok:false with reason error', () => {
    const outcome = mapSnapshotResult(
      snap({ last_trade: undefined, last_minute: {}, session: { previous_close: 74.5 } }),
      CTX,
    );
    expect(outcome).toEqual({
      ok: false,
      symbol: 'AAPL',
      reason: 'error',
      message: 'no usable price field',
    });
  });

  it('a per-result error maps to ok:false without affecting siblings', () => {
    const results = [
      snap(),
      snap({ ticker: 'BROKEN', error: 'NOT_FOUND', message: 'Ticker not found.' }),
    ];
    const outcomes = results.map((r) => mapSnapshotResult(r, CTX));
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]).toEqual({
      ok: false,
      symbol: 'BROKEN',
      reason: 'error',
      message: 'Ticker not found.',
    });
  });

  it('a non-stocks type maps to unsupported, not silence', () => {
    const outcome = mapSnapshotResult(snap({ ticker: 'X:BTCUSD', type: 'crypto' }), CTX);
    expect(outcome).toMatchObject({ ok: false, symbol: 'X:BTCUSD', reason: 'unsupported' });
  });

  it('missing prevClose maps to null, and an unknown market_status to "unknown"', () => {
    const outcome = mapSnapshotResult(
      snap({ session: { close: 75.1 }, market_status: 'half_day' }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.prevClose).toBeNull();
    expect(outcome.quote.marketStatus).toBe('unknown');
  });

  it('an entry without a ticker is unusable and returns null', () => {
    expect(mapSnapshotResult(snap({ ticker: undefined }), CTX)).toBeNull();
  });

  it('garbage bodies never throw — safeParse reports failure instead', () => {
    for (const garbage of [null, 'html error page', 42, { results: 'nope' }]) {
      expect(() => snapshotResponseSchema.safeParse(garbage)).not.toThrow();
    }
    expect(snapshotResponseSchema.safeParse(null).success).toBe(false);
    expect(snapshotResponseSchema.safeParse({ results: 'nope' }).success).toBe(false);
    // Unknown extra keys must never fail the parse (loose schema).
    expect(
      snapshotResponseSchema.safeParse({ results: [{ ...snap(), someFutureKey: 1 }] }).success,
    ).toBe(true);
  });
});

describe('mapSnapshotResult — day and extended-hours change', () => {
  it('the coherent-triple invariant holds in every status: price − prevClose = amt, pct = pctChange', () => {
    for (const market_status of ['open', 'closed', 'early_trading', 'late_trading', 'weird'] as const) {
      const outcome = mapSnapshotResult(
        snap({
          market_status,
          session: { previous_close: 74.5, close: 75.1, price: 75.2 },
        }),
        CTX,
      );
      if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
      const { price, prevClose, dayChangeAmt, dayChangePct } = outcome.quote;
      expect(prevClose).toBe('74.5');
      expect(dayChangeAmt).not.toBeNull();
      expect(dayChangePct).not.toBeNull();
      expect(dec(price).minus(dec(prevClose!)).toString()).toBe(dayChangeAmt);
      expect(pctChange(dec(prevClose!), dec(price))!.toString()).toBe(dayChangePct);
    }
  });

  it('ignores the vendor regular-session pair — the day figures derive from the displayed price', () => {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: {
          previous_close: 313.33,
          close: 313.3,
          change_percent: -0.0255, // the trap field — must NOT feed the daily figure
          regular_trading_change: -99, // vendor pair present but schema-only now
          regular_trading_change_percent: -99,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.price).toBe('313.3');
    expect(outcome.quote.dayChangeAmt).toBe(dec('313.3').minus(dec('313.33')).toString());
    expect(outcome.quote.dayChangePct).toBe(pctChange(dec('313.33'), dec('313.3'))!.toString());
  });

  it('open derives from previous_close → session.price (the headline)', () => {
    const outcome = mapSnapshotResult(
      snap({ market_status: 'open', session: { previous_close: 74.5, price: 75.2 } }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.dayChangeAmt).toBe(dec('75.2').minus(dec('74.5')).toString());
    expect(outcome.quote.dayChangePct).toBe(pctChange(dec('74.5'), dec('75.2'))!.toString());
  });

  it('closed derives from previous_close → close, not the lingering extended price', () => {
    const outcome = mapSnapshotResult(
      snap({ market_status: 'closed', session: { previous_close: 74.5, close: 75.1, price: 74.9 } }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.dayChangeAmt).toBe(dec('75.1').minus(dec('74.5')).toString());
    expect(outcome.quote.dayChangePct).toBe(pctChange(dec('74.5'), dec('75.1'))!.toString());
  });

  it('the day pair is atomic: no baseline → amount AND percent null together', () => {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        // A vendor amount without previous_close must not leak through as a
        // lone figure — the pair derives together or not at all.
        session: { close: 75.1, regular_trading_change: -0.08 },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.dayChangeAmt).toBeNull();
    expect(outcome.quote.dayChangePct).toBeNull();
  });

  it('early_trading derives close → price with kind "early" — the vendor early pair is IGNORED (NFLX 2026-08-14 regression)', () => {
    // The real NFLX payload, pre-market 2026-08-14: the vendor's early pair
    // is measured from previous_close (74.21 — the close TWO sessions back),
    // so its 6.724% double-counts the +5.43% day move the day figure already
    // shows. The honest pre-market move is close → price: 78.24 → 79.2,
    // ≈ +1.23%. The UI showed +6.85% under the old preference order.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'early_trading',
        session: {
          previous_close: 74.21,
          close: 78.24,
          price: 79.2,
          change: 4.99,
          change_percent: 6.724,
          early_trading_change: 4.99,
          early_trading_change_percent: 6.724,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBe('early');
    expect(outcome.quote.extendedChangeAmt).toBe(dec('79.2').minus(dec('78.24')).toString());
    expect(outcome.quote.extendedChangePct).toBe(pctChange(dec('78.24'), dec('79.2'))!.toString());
    // Never the vendor's inflated previous_close-based figure.
    expect(outcome.quote.extendedChangePct).not.toBe('6.724');
    // The day pair still derives previous_close → headline close — the +5.43%
    // the day figure honestly owns stays exactly where it was.
    expect(outcome.quote.dayChangeAmt).toBe(dec('78.24').minus(dec('74.21')).toString());
    expect(outcome.quote.dayChangePct).toBe(pctChange(dec('74.21'), dec('78.24'))!.toString());
    // Live reading — the end instant belongs to a COMPLETED session only.
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
    expect(outcome.quote.extendedLive).toBe(true);
  });

  it('late_trading derives close → price with kind "late" — a disagreeing vendor late pair is ignored', () => {
    // The late twin of the NFLX case: the vendor pair is present, fully
    // formed and WRONG (previous_close-based). The derived pair wins.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'late_trading',
        session: {
          previous_close: 74.21,
          close: 78.24,
          price: 79.2,
          late_trading_change: 4.99,
          late_trading_change_percent: 6.724,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBe('late');
    expect(outcome.quote.extendedChangeAmt).toBe(dec('79.2').minus(dec('78.24')).toString());
    expect(outcome.quote.extendedChangePct).toBe(pctChange(dec('78.24'), dec('79.2'))!.toString());
    expect(outcome.quote.extendedChangePct).not.toBe('6.724');
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
    expect(outcome.quote.extendedLive).toBe(true);
  });

  it('closed persists the LAST COMPLETED extended session — DERIVED close → price, attributed "late", stamped with its end', () => {
    // 2026-08-13 reversal (extended-hours-last-reading plan): the reading
    // persists while closed, attributed by clock math — on a Sunday that is
    // Friday's late session. Since 2026-08-14 the figure is the app's own
    // close → price derivation; the vendor pairs (present and disagreeing on
    // purpose) are schema-only and must not leak through.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: {
          previous_close: 313.33,
          close: 313.33,
          price: 313.25,
          early_trading_change: -1.88,
          early_trading_change_percent: -0.6,
          late_trading_change: -0.08,
          late_trading_change_percent: -0.0255,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBe('late');
    expect(outcome.quote.extendedChangeAmt).toBe(dec('313.25').minus(dec('313.33')).toString());
    expect(outcome.quote.extendedChangePct).toBe(pctChange(dec('313.33'), dec('313.25'))!.toString());
    // The derived pct is NOT the vendor's rounded figure.
    expect(outcome.quote.extendedChangePct).not.toBe('-0.0255');
    expect(outcome.quote.extendedEndedAtMs).toBe(FRIDAY_LATE_END);
    // A completed session's reading — never live.
    expect(outcome.quote.extendedLive).toBe(false);
  });

  it('unknown status renders NO extended line — an unrecognised word may be a live session', () => {
    // 2026-08-14 fix: this test previously pinned the OPPOSITE — `unknown`
    // attributing like `closed`, which double-counted a persisted pre-market
    // pair beside a day figure that already contained the move. The persisted
    // branch fires on an unambiguous `closed` only.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'half_day',
        session: {
          previous_close: 313.33,
          close: 313.33,
          late_trading_change: -0.08,
          late_trading_change_percent: -0.0255,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.marketStatus).toBe('unknown');
    expect(outcome.quote.extendedKind).toBeNull();
    expect(outcome.quote.extendedChangeAmt).toBeNull();
    expect(outcome.quote.extendedChangePct).toBeNull();
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
  });

  it('a trading half-day (unrecognised status, mid-session) shows the day figure ALONE — no double-counted pre-market pair', () => {
    // Tuesday 2026-08-04 15:00 ET: the market is genuinely trading a half-day
    // the vendor reports with a word this app does not know. The old code
    // attributed it as closed, `extendedAttribution` returned the morning's
    // early session, and a persisted pre-market pair rendered NEXT TO a day
    // figure that already contained that move.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'half_day',
        session: {
          previous_close: 313.33,
          close: 313.33,
          price: 313.25,
          early_trading_change: -1.88,
          early_trading_change_percent: -0.6,
          late_trading_change: -0.08,
          late_trading_change_percent: -0.0255,
        },
      }),
      { ...CTX, now: new Date('2026-08-04T19:00:00Z') },
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBeNull();
    expect(outcome.quote.extendedChangeAmt).toBeNull();
    expect(outcome.quote.extendedChangePct).toBeNull();
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
    // The day pair still derives — the day figure alone carries the move.
    expect(outcome.quote.dayChangeAmt).not.toBeNull();
    expect(outcome.quote.dayChangePct).not.toBeNull();
  });

  it('closed with NO coverage horizon → the derived pair persists but the instant is suppressed', () => {
    // Fresh calendar tables (or store unreachable): the kind and figure stay
    // trustworthy, the timestamp does not — session name with no time.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: {
          previous_close: 313.33,
          close: 313.33,
          price: 313.25,
          late_trading_change: -0.08,
          late_trading_change_percent: -0.0255,
        },
      }),
      { ...CTX, calendarKnownFromISO: null },
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBe('late');
    expect(outcome.quote.extendedChangePct).toBe(pctChange(dec('313.33'), dec('313.25'))!.toString());
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
    // Pre-horizon: the instant is honestly suppressed, but liveness is its
    // own fact — an ended session must never masquerade as a live one.
    expect(outcome.quote.extendedLive).toBe(false);
  });

  it('closed with full vendor pairs but NO session.price → NOTHING: a vendor pair alone can no longer conjure a line', () => {
    // The no-relabel guard, rebuilt on derivation: both vendor pairs are
    // fully present, but with no tip (session.price) there is nothing honest
    // to measure — the untimestamped vendor figures that made relabelling an
    // older session possible are not consulted at all.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: {
          previous_close: 313.33,
          close: 313.33,
          early_trading_change: -1.88,
          early_trading_change_percent: -0.6,
          late_trading_change: -0.08,
          late_trading_change_percent: -0.0255,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBeNull();
    expect(outcome.quote.extendedChangeAmt).toBeNull();
    expect(outcome.quote.extendedChangePct).toBeNull();
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
  });

  it('closed with a null attribution (closure streak past the scan bound) → no extended figure, even a derivable one', () => {
    const closures: { date: string; status: 'closed' }[] = [];
    for (let d = 26; d <= 31; d++) closures.push({ date: `2026-07-${d}`, status: 'closed' });
    for (let d = 1; d <= 9; d++) {
      closures.push({ date: `2026-08-0${d}`, status: 'closed' });
    }
    // close AND price present — the pair IS derivable, but with no session to
    // attribute it to, no figure renders.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: {
          previous_close: 313.33,
          close: 313.33,
          price: 313.25,
          late_trading_change: -0.08,
          late_trading_change_percent: -0.0255,
        },
      }),
      { ...CTX, overrides: closures },
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBeNull();
    expect(outcome.quote.extendedChangeAmt).toBeNull();
    expect(outcome.quote.extendedChangePct).toBeNull();
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
  });

  it('closed with attribution and close === price → a real 0/0 pair with kind and end instant', () => {
    // The deliberate line-appears-where-none-did consequence: nothing traded
    // off-hours is an honest 0.00% reading, not a blank — pinned on purpose.
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: { previous_close: 313.33, close: 313.25, price: 313.25 },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBe('late');
    expect(outcome.quote.extendedChangeAmt).toBe('0');
    expect(outcome.quote.extendedChangePct).toBe('0');
    expect(outcome.quote.extendedEndedAtMs).toBe(FRIDAY_LATE_END);
    expect(outcome.quote.extendedLive).toBe(false);
  });

  it('open market carries no extended figure at all — the day figure already contains the pre-market move', () => {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'open',
        session: {
          previous_close: 74.5,
          price: 75.2,
          late_trading_change: -0.08,
          late_trading_change_percent: -0.0255,
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBeNull();
    expect(outcome.quote.extendedChangeAmt).toBeNull();
    expect(outcome.quote.extendedChangePct).toBeNull();
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
  });

  it('derives BOTH figures from close → price whatever the vendor pair looks like — derivation is the rule, not a fallback', () => {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'late_trading',
        session: {
          previous_close: 74.5,
          close: 75.1,
          price: 74.9,
          late_trading_change: -0.2, // vendor half-pair — schema-only either way
        },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBe('late');
    expect(outcome.quote.extendedChangeAmt).toBe(dec('74.9').minus(dec('75.1')).toString());
    expect(outcome.quote.extendedChangePct).toBe(pctChange(dec('75.1'), dec('74.9'))!.toString());
  });

  it('an underivable extended pair drops the kind — no label without a figure', () => {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'late_trading',
        session: { previous_close: 74.5, close: 75.1 }, // no extended price at all
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.extendedKind).toBeNull();
    expect(outcome.quote.extendedChangeAmt).toBeNull();
    expect(outcome.quote.extendedChangePct).toBeNull();
  });

  it('everything absent → all six fields null, never "0"', () => {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        last_trade: undefined,
        last_minute: { close: 75 },
        session: undefined,
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.dayChangeAmt).toBeNull();
    expect(outcome.quote.dayChangePct).toBeNull();
    expect(outcome.quote.extendedChangeAmt).toBeNull();
    expect(outcome.quote.extendedChangePct).toBeNull();
    expect(outcome.quote.extendedKind).toBeNull();
    expect(outcome.quote.extendedEndedAtMs).toBeNull();
  });

  it('a flat day is a real zero pair — derived, not nulled', () => {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: { previous_close: 313.33, close: 313.33 },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.quote.dayChangeAmt).toBe('0');
    expect(outcome.quote.dayChangePct).toBe('0');
  });
});

describe('rolledPrevClose / substituteDayPair — the pre-open rolled state (defect fix, 2026-08-14)', () => {
  /** The observed pre-market shape: the vendor has rolled `previous_close`
   *  to equal the last session's close, while the pre-market trades at
   *  168.9 — the day pair degenerates to exactly 0.00%. */
  function rolledQuote() {
    const outcome = mapSnapshotResult(
      snap({
        market_status: 'early_trading',
        session: { previous_close: 150.25, close: 150.25, price: 168.9 },
      }),
      CTX,
    );
    if (!outcome || !outcome.ok) throw new Error('expected ok outcome');
    return outcome.quote;
  }

  it('a rolled snapshot maps to the degenerate 0.00% pair and matches the rolled signature', () => {
    const quote = rolledQuote();
    // The defect being pinned: today's mapper honestly derives 0 from the
    // rolled baseline — beside a +12% pre-market line that reads as broken.
    expect(quote.price).toBe('150.25');
    expect(quote.prevClose).toBe('150.25');
    expect(quote.dayChangeAmt).toBe('0');
    expect(quote.dayChangePct).toBe('0');
    expect(rolledPrevClose(quote)).toBe(true);
  });

  it('substitution re-derives the pair from the cached prior close — price, prevClose and extended fields untouched', () => {
    const quote = rolledQuote();
    const substituted = substituteDayPair(quote, '148.10');
    // Yesterday's actual move: 148.10 → 150.25.
    expect(substituted.dayChangeAmt).toBe('2.15');
    expect(substituted.dayChangePct).toBe(pctChange(dec('148.10'), dec('150.25'))!.toString());
    // The coherent triple: the displayed price is unchanged and the pair
    // derives from it — three views of ONE number.
    expect(substituted.price).toBe(quote.price);
    // prevClose stays the VENDOR field — the tick path re-derives from it at
    // the 09:30 open, where the rolled value is exactly right.
    expect(substituted.prevClose).toBe(quote.prevClose);
    // The live pre-market line is somebody else's figure — untouched.
    expect(substituted.extendedKind).toBe(quote.extendedKind);
    expect(substituted.extendedChangeAmt).toBe(quote.extendedChangeAmt);
    expect(substituted.extendedChangePct).toBe(quote.extendedChangePct);
    expect(substituted.marketStatus).toBe(quote.marketStatus);
    expect(substituted.asOf).toBe(quote.asOf);
  });

  it('no cached baseline → both day figures null — the dash, never a fabricated zero', () => {
    const quote = rolledQuote();
    const substituted = substituteDayPair(quote, null);
    expect(substituted.dayChangeAmt).toBeNull();
    expect(substituted.dayChangePct).toBeNull();
    // Everything else still untouched.
    expect(substituted.price).toBe(quote.price);
    expect(substituted.prevClose).toBe(quote.prevClose);
  });

  it('the signature is narrow: open markets, missing prevClose and the pre-roll evening state all miss it', () => {
    // While OPEN the vendor baseline is correct — never substituted.
    const open = mapSnapshotResult(
      snap({
        market_status: 'open',
        session: { previous_close: 150.25, close: 150.25, price: 150.25 },
      }),
      CTX,
    );
    if (!open || !open.ok) throw new Error('expected ok outcome');
    expect(rolledPrevClose(open.quote)).toBe(false);

    // No prevClose at all → nothing to compare, no substitution.
    const noPrev = mapSnapshotResult(
      snap({ market_status: 'closed', session: { close: 150.25 } }),
      CTX,
    );
    if (!noPrev || !noPrev.ok) throw new Error('expected ok outcome');
    expect(noPrev.quote.prevClose).toBeNull();
    expect(rolledPrevClose(noPrev.quote)).toBe(false);

    // The pre-roll evening state: prevClose is still yesterday's baseline,
    // distinct from the close — the vendor pair is correct as-is.
    const evening = mapSnapshotResult(
      snap({
        market_status: 'closed',
        session: { previous_close: 148.1, close: 150.25, price: 150.25 },
      }),
      CTX,
    );
    if (!evening || !evening.ok) throw new Error('expected ok outcome');
    expect(rolledPrevClose(evening.quote)).toBe(false);
  });

  it('decimal equality, not string equality — a rescaled rolled baseline still matches', () => {
    const quote = rolledQuote();
    // '150.250' and '150.25' are one number; the signature must see that.
    expect(rolledPrevClose({ ...quote, prevClose: '150.250' })).toBe(true);
  });
});

describe('deriveDayPair — the one atomic pair derivation', () => {
  it('derives amount and percent from the same two inputs, strings or numbers', () => {
    expect(deriveDayPair('74.5', '75.2')).toEqual({
      amt: dec('75.2').minus(dec('74.5')).toString(),
      pct: pctChange(dec('74.5'), dec('75.2'))!.toString(),
    });
    expect(deriveDayPair(74.5, 75.2)).toEqual(deriveDayPair('74.5', '75.2'));
  });

  it('null together: absent inputs or a zero base yield NO pair, never half of one', () => {
    expect(deriveDayPair(null, '75.2')).toBeNull();
    expect(deriveDayPair('74.5', undefined)).toBeNull();
    // pctChange semantics: a zero base has no percentage — and the pair is
    // atomic, so the (derivable) amount is withheld with it.
    expect(deriveDayPair('0', '75.2')).toBeNull();
  });
});

describe('stream mapping — parseStreamFrame and mapStreamAgg', () => {
  const NOW_MS = 1_754_800_000_000;

  it('maps a valid A-message; the price survives the dec() round-trip verbatim', () => {
    const [msg] = parseStreamFrame(
      JSON.stringify({ ev: 'A', sym: 'AAPL', c: 123.45, s: 1_000, e: 2_000, v: 9 }),
    );
    expect(mapStreamAgg(msg, NOW_MS)).toEqual({ symbol: 'AAPL', price: '123.45', tMs: 2_000 });
  });

  it('falls back to bar start, then nowMs, when the end timestamp is absent', () => {
    expect(mapStreamAgg({ ev: 'A', sym: 'AAPL', c: 1.5, s: 1_000 }, NOW_MS)?.tMs).toBe(1_000);
    expect(mapStreamAgg({ ev: 'A', sym: 'AAPL', c: 1.5 }, NOW_MS)?.tMs).toBe(NOW_MS);
  });

  it('drops messages without a close, without a symbol, and non-A events', () => {
    expect(mapStreamAgg({ ev: 'A', sym: 'AAPL', s: 1_000, e: 2_000 }, NOW_MS)).toBeNull();
    expect(mapStreamAgg({ ev: 'A', c: 1.5 }, NOW_MS)).toBeNull();
    expect(mapStreamAgg({ ev: 'status', status: 'connected' }, NOW_MS)).toBeNull();
    expect(mapStreamAgg({ ev: 'AM', sym: 'AAPL', c: 1.5 }, NOW_MS)).toBeNull();
  });

  it('parses bare objects AND arrays of messages; garbage frames map to []', () => {
    expect(parseStreamFrame('{"ev":"status","status":"connected"}')).toEqual([
      { ev: 'status', status: 'connected' },
    ]);
    expect(
      parseStreamFrame('[{"ev":"A","sym":"AAPL","c":1.5},{"ev":"A","sym":"SPY","c":2.5}]'),
    ).toHaveLength(2);
    expect(parseStreamFrame('not json at all')).toEqual([]);
    expect(parseStreamFrame('"a bare string"')).toEqual([]);
    expect(parseStreamFrame('[42, null]')).toEqual([]);
  });
});

describe('market status — current and upcoming mappers', () => {
  it('maps the observed closed payload, and open/extended variants', () => {
    expect(
      mapMarketStatusNow({ market: 'closed', afterHours: false, earlyHours: false }),
    ).toBe('closed');
    expect(mapMarketStatusNow({ market: 'open' })).toBe('open');
    expect(mapMarketStatusNow({ market: 'extended-hours', earlyHours: true })).toBe(
      'early_trading',
    );
    expect(mapMarketStatusNow({ market: 'extended-hours', afterHours: true })).toBe('late_trading');
    expect(mapMarketStatusNow({})).toBe('unknown');
    expect(mapMarketStatusNow({ market: 'weird-new-value' })).toBe('unknown');
  });

  it('the current-status schema tolerates unknown keys and garbage bodies', () => {
    expect(
      marketStatusNowSchema.safeParse({ market: 'closed', someFutureKey: { nested: 1 } }).success,
    ).toBe(true);
    expect(marketStatusNowSchema.safeParse(null).success).toBe(false);
  });

  it('parses the ARRAY calendar body: full holidays without times, early-closes with UTC instants', () => {
    const body = [
      { date: '2026-09-07', exchange: 'NASDAQ', name: 'Labor Day', status: 'closed' },
      { date: '2026-09-07', exchange: 'NYSE', name: 'Labor Day', status: 'closed' },
      {
        date: '2026-11-27',
        exchange: 'NYSE',
        name: 'Thanksgiving',
        status: 'early-close',
        open: '2026-11-27T14:30:00.000Z',
        close: '2026-11-27T18:00:00.000Z',
      },
    ];
    const parsed = marketUpcomingSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');

    expect(mapUpcomingToOverrides(parsed.data)).toEqual([
      { date: '2026-09-07', status: 'closed' },
      {
        date: '2026-11-27',
        status: 'early-close',
        openMs: Date.UTC(2026, 10, 27, 14, 30),
        closeMs: Date.UTC(2026, 10, 27, 18, 0),
      },
    ]);
  });

  it('drops non-equity exchanges and lets "closed" win a per-date conflict', () => {
    expect(
      mapUpcomingToOverrides([
        { date: '2026-09-07', exchange: 'CRYPTO', status: 'closed' },
        { date: '2026-11-27', exchange: 'NYSE', status: 'early-close', close: '2026-11-27T18:00:00.000Z' },
        { date: '2026-11-27', exchange: 'NASDAQ', status: 'closed' },
      ]),
    ).toEqual([{ date: '2026-11-27', status: 'closed' }]);
  });

  it('an early-close row without parseable times STILL closes the clock early, at 13:00 ET', () => {
    // Asserting the override's mere existence would bless a bug: an
    // instant-less early-close that the clock then models as a full
    // 09:30–16:00 session. Pin the behaviour end to end — the override must
    // make the clock close at 13:00 ET (18:00Z in EST), not 16:00.
    const overrides = mapUpcomingToOverrides([{ date: '2026-11-27', status: 'early-close' }]);
    expect(overrides).toEqual([{ date: '2026-11-27', status: 'early-close' }]);

    expect(regularSessionFor('2026-11-27', overrides)?.closeMs).toBe(
      Date.UTC(2026, 10, 27, 18, 0),
    );
    // 19:00Z = 14:00 EST — after the half-day close, so NOT "open".
    expect(statusAt(Date.UTC(2026, 10, 27, 19, 0), overrides)).toBe('late_trading');
  });
});

describe('reconcileTransition — never a status word with a contradicting countdown', () => {
  const closeAt = { atMs: Date.UTC(2026, 7, 10, 20, 0), kind: 'close' as const };
  const openAt = { atMs: Date.UTC(2026, 7, 11, 13, 30), kind: 'open' as const };

  it('consistent pairs pass through untouched', () => {
    expect(reconcileTransition('open', closeAt)).toEqual(closeAt);
    expect(reconcileTransition('closed', openAt)).toEqual(openAt);
    expect(reconcileTransition('early_trading', openAt)).toEqual(openAt);
    expect(reconcileTransition('late_trading', openAt)).toEqual(openAt);
  });

  it('vendor "open" outside the derived session → the "opens in" countdown is suppressed', () => {
    // The bug this pins: the vendor's status lag in the seconds after
    // 16:00 ET said `open` while the pure clock's next boundary was the next
    // OPEN — rendered as the self-contradiction "Open … opens in 17:29:58".
    expect(reconcileTransition('open', openAt)).toBeNull();
  });

  it('the mirror lag — vendor not-open while the derived session runs → suppressed', () => {
    expect(reconcileTransition('closed', closeAt)).toBeNull();
    expect(reconcileTransition('early_trading', closeAt)).toBeNull();
    expect(reconcileTransition('late_trading', closeAt)).toBeNull();
  });

  it('no transition in, none out', () => {
    expect(reconcileTransition('open', null)).toBeNull();
  });
});

describe('mapTickerResults — US-only filter', () => {
  it('keeps CS and ADRC as equity and ETF as etf', () => {
    const rows = mapTickerResults([
      ticker(),
      ticker({ ticker: 'TSM', name: 'Taiwan Semiconductor ADR', type: 'ADRC' }),
      ticker({ ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', type: 'ETF', primary_exchange: 'ARCX' }),
    ]);
    expect(rows).toEqual([
      { symbol: 'NKE', name: 'Nike, Inc.', exchange: 'NYSE', type: 'equity' },
      { symbol: 'TSM', name: 'Taiwan Semiconductor ADR', exchange: 'NYSE', type: 'equity' },
      { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE Arca', type: 'etf' },
    ]);
  });

  it('maps every known US MIC to its display name', () => {
    const rows = mapTickerResults([
      ticker({ ticker: 'A1', primary_exchange: 'XNYS' }),
      ticker({ ticker: 'A2', primary_exchange: 'XNAS' }),
      ticker({ ticker: 'A3', primary_exchange: 'XASE' }),
      ticker({ ticker: 'A4', primary_exchange: 'ARCX' }),
      ticker({ ticker: 'A5', primary_exchange: 'BATS' }),
      ticker({ ticker: 'A6', primary_exchange: 'IEXG' }),
    ]);
    expect(rows.map((r) => r.exchange)).toEqual([
      'NYSE',
      'Nasdaq',
      'NYSE American',
      'NYSE Arca',
      'Cboe BZX',
      'IEX',
    ]);
  });

  it('drops noise types — rights, warrants, funds, units', () => {
    const rows = mapTickerResults([
      ticker({ type: 'RIGHT' }),
      ticker({ type: 'WARRANT' }),
      ticker({ type: 'FUND' }),
      ticker({ type: 'UNIT' }),
      ticker({ type: undefined }),
    ]);
    expect(rows).toEqual([]);
  });

  it('drops unknown MICs (XWAR) — conservative, never a guessed exchange', () => {
    expect(mapTickerResults([ticker({ primary_exchange: 'XWAR' })])).toEqual([]);
    expect(mapTickerResults([ticker({ primary_exchange: undefined })])).toEqual([]);
  });

  it('drops non-USD, non-us-locale and inactive listings', () => {
    expect(mapTickerResults([ticker({ currency_name: 'eur' })])).toEqual([]);
    expect(mapTickerResults([ticker({ currency_name: undefined })])).toEqual([]);
    expect(mapTickerResults([ticker({ locale: 'global' })])).toEqual([]);
    expect(mapTickerResults([ticker({ active: false })])).toEqual([]);
  });

  it('drops entries missing a ticker or a name', () => {
    expect(mapTickerResults([ticker({ ticker: undefined })])).toEqual([]);
    expect(mapTickerResults([ticker({ name: undefined })])).toEqual([]);
  });

  it('feeds rankDirectoryMatches so the exact ticker ranks first with USD stamped', () => {
    const rows = mapTickerResults([
      ticker({ ticker: 'NKEXY', name: 'Not Nike Corp' }),
      ticker({ ticker: 'NKE', name: 'Nike, Inc.' }),
    ]);
    const matches = rankDirectoryMatches('NKE', rows);
    expect(matches[0]).toMatchObject({
      symbol: 'NKE',
      exchange: 'NYSE',
      exchangeDisplay: 'NYSE',
      currency: 'USD',
    });
  });
});

describe('mapAggsResults', () => {
  it('maps o/h/l/c/v to exact decimal strings and keeps t as ms', () => {
    const candles = mapAggsResults([
      { o: 189.87, h: 193.42, l: 189.35, c: 192.53, v: 60943699, t: 1_699_941_600_000 },
    ]);
    expect(candles).toEqual([
      {
        t: 1_699_941_600_000,
        open: '189.87',
        high: '193.42',
        low: '189.35',
        close: '192.53',
        volume: '60943699',
      },
    ]);
  });

  it('drops a bar missing any OHLCV field or its timestamp', () => {
    expect(mapAggsResults([{ o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }])).toEqual([]);
    expect(mapAggsResults([{ o: 1, h: 2, l: 0.5, t: 1 }])).toEqual([]);
    expect(mapAggsResults([{}])).toEqual([]);
  });
});

describe('branding — tickerOverviewSchema and mapBrandingIconUrl', () => {
  const ICON =
    'https://api.massive.com/v1/reference/company-branding/bWNkb25hbGRzLmNvbQ/images/2026-08-01_icon.jpeg';

  it('an https icon_url survives the parse and comes out verbatim', () => {
    const parsed = tickerOverviewSchema.safeParse({
      results: { ticker: 'MCD', branding: { icon_url: ICON, logo_url: 'https://x/logo.png' } },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');
    expect(mapBrandingIconUrl(parsed.data)).toBe(ICON);
  });

  it('branding: null (the observed .WA shape) maps to null, not a parse failure', () => {
    const parsed = tickerOverviewSchema.safeParse({
      results: { ticker: 'CDR.WA', branding: null },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');
    expect(mapBrandingIconUrl(parsed.data)).toBeNull();
  });

  it('branding absent entirely maps to null — at both the branding and results level', () => {
    for (const body of [{ results: { ticker: 'MCD' } }, {}]) {
      const parsed = tickerOverviewSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('expected parse success');
      expect(mapBrandingIconUrl(parsed.data)).toBeNull();
    }
  });

  it('a non-https icon_url maps to null — the key must never chase a downgraded URL', () => {
    for (const icon_url of ['http://api.massive.com/icon.jpeg', 'ftp://evil/icon', '//evil/icon', '']) {
      const parsed = tickerOverviewSchema.safeParse({ results: { branding: { icon_url } } });
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('expected parse success');
      expect(mapBrandingIconUrl(parsed.data)).toBeNull();
    }
  });

  it('garbage bodies never throw — safeParse reports failure instead', () => {
    for (const garbage of [null, 'html error page', 42, { results: 'nope' }, { results: { branding: 'nope' } }]) {
      expect(() => tickerOverviewSchema.safeParse(garbage)).not.toThrow();
      expect(tickerOverviewSchema.safeParse(garbage).success).toBe(false);
    }
    // Unknown extra keys must never fail the parse (loose schema).
    expect(
      tickerOverviewSchema.safeParse({
        results: { branding: { icon_url: ICON, accent_color: 'brand-red' } },
        someFutureKey: 1,
      }).success,
    ).toBe(true);
  });
});

describe('snapshotParams — request building', () => {
  it('joins ticker.any_of with commas and sets limit to the exact batch size', () => {
    // The API default limit is 10 — a 40-ticker batch without an explicit
    // limit silently returns 10 results. The builder must never rely on it.
    const symbols = Array.from({ length: 40 }, (_, i) => `SYM${i}`);
    const params = snapshotParams(symbols);
    expect(params.get('ticker.any_of')).toBe(symbols.join(','));
    expect(params.get('limit')).toBe('40');
  });

  it('a two-symbol batch sets limit=2', () => {
    const params = snapshotParams(['AAPL', 'SPY']);
    expect(params.get('ticker.any_of')).toBe('AAPL,SPY');
    expect(params.get('limit')).toBe('2');
  });

  it('never sends `type` alongside a ticker list', () => {
    // Live-verified 2026-08-09: `/v3/snapshot` answers
    // 400 {"error":"Cannot specify tickers and type."} when both are present.
    // This test locks in the regression the probe caught.
    expect(snapshotParams(['AAPL']).has('type')).toBe(false);
  });
});

describe('aggsPath — pure path building', () => {
  it('builds the daily path with ISO date bounds', () => {
    expect(
      aggsPath('AAPL', { multiplier: 1, timespan: 'day', from: '2026-01-02', to: '2026-08-11' }),
    ).toBe('/v2/aggs/ticker/AAPL/range/1/day/2026-01-02/2026-08-11');
  });

  it('keeps a dot ticker (BRK.A) as one encoded segment', () => {
    expect(
      aggsPath('BRK.A', { multiplier: 1, timespan: 'day', from: '2026-01-02', to: '2026-01-31' }),
    ).toBe('/v2/aggs/ticker/BRK.A/range/1/day/2026-01-02/2026-01-31');
  });

  it('builds the intraday path with epoch-ms string bounds', () => {
    expect(
      aggsPath('SPY', {
        multiplier: 5,
        timespan: 'minute',
        from: '1786060800000',
        to: '1786147200000',
      }),
    ).toBe('/v2/aggs/ticker/SPY/range/5/minute/1786060800000/1786147200000');
  });

  it('neutralizes a path-traversal attempt instead of restructuring the URL', () => {
    const path = aggsPath('../v1/secrets', {
      multiplier: 1,
      timespan: 'day',
      from: '2026-01-02',
      to: '2026-01-31',
    });
    // The hostile symbol stays ONE segment: no raw slash survives encoding.
    expect(path).toBe('/v2/aggs/ticker/..%2Fv1%2Fsecrets/range/1/day/2026-01-02/2026-01-31');
    expect(path.split('/').length).toBe(
      aggsPath('AAPL', { multiplier: 1, timespan: 'day', from: '2026-01-02', to: '2026-01-31' }).split('/').length,
    );
  });

  it('encodes a query-injection attempt in the from segment', () => {
    expect(
      aggsPath('AAPL', { multiplier: 1, timespan: 'day', from: '2026-01-02?limit=1', to: '2026-01-31' }),
    ).toContain('/2026-01-02%3Flimit%3D1/');
  });
});

describe('headlineSessionPrice — the extracted status-aware headline (2026-08-15)', () => {
  // Extracted from `mapSnapshotResult` so the option-pricing path can read an
  // underlying's spot with the SAME rule; every case above still exercises it
  // through the mapper, and these pin it directly.

  it('prefers session.price while open, and the official close otherwise', () => {
    const session = { price: 197.4, close: 196.21, previous_close: 199.05 };
    expect(headlineSessionPrice(session, undefined, 'open')).toBe(197.4);
    expect(headlineSessionPrice(session, undefined, 'closed')).toBe(196.21);
    expect(headlineSessionPrice(session, undefined, 'early_trading')).toBe(196.21);
    expect(headlineSessionPrice(session, undefined, 'unknown')).toBe(196.21);
  });

  it('falls back through last_minute.close before the other session field', () => {
    expect(headlineSessionPrice({ close: 196.21 }, { close: 197 }, 'open')).toBe(197);
    expect(headlineSessionPrice({ price: 197.4 }, { close: 197 }, 'closed')).toBe(197);
  });

  it('keeps a legitimate price of 0 and returns undefined when nothing is usable', () => {
    expect(headlineSessionPrice({ price: 0 }, undefined, 'open')).toBe(0);
    expect(headlineSessionPrice({}, undefined, 'open')).toBeUndefined();
    expect(headlineSessionPrice(undefined, undefined, 'closed')).toBeUndefined();
  });
});

describe('dividends — mapping and request shape (2026-08-16)', () => {
  // A hermetic test proves only that the params are included, never that the
  // vendor accepts them — the parameter names come from the plan's live probe.
  it('builds the verified dividends query', () => {
    const params = dividendsParams('AAPL', '2020-03-01');
    expect(params.get('ticker')).toBe('AAPL');
    expect(params.get('ex_dividend_date.gte')).toBe('2020-03-01');
    expect(params.get('limit')).toBe('1000');
    expect(params.get('order')).toBe('asc');
    expect(params.get('sort')).toBe('ex_dividend_date');
  });

  it('crosses cash_amount number→decimal-string exactly once, no float drift', () => {
    const [event] = mapDividendResults([
      {
        id: 'E1',
        cash_amount: 0.27,
        currency: 'usd',
        ex_dividend_date: '2026-08-10',
        pay_date: '2026-08-13',
        record_date: '2026-08-10',
        declaration_date: '2026-07-31',
        frequency: 4,
      },
    ]);
    expect(event).toEqual({
      vendorId: 'E1',
      cashAmount: '0.27',
      currency: 'USD',
      exDate: '2026-08-10',
      payDate: '2026-08-13',
      recordDate: '2026-08-10',
      declarationDate: '2026-07-31',
      frequency: 4,
    });
    // The decimal string round-trips into dec() without ever being a float
    // in OUR code path again.
    expect(dec(event.cashAmount).times(dec('100')).toString()).toBe('27');
  });

  it('maps an absent pay_date to null (FX and ordering then use exDate)', () => {
    const [event] = mapDividendResults([
      { id: 'E2', cash_amount: 1.5, ex_dividend_date: '2026-05-01' },
    ]);
    expect(event.payDate).toBeNull();
    expect(event.recordDate).toBeNull();
    expect(event.declarationDate).toBeNull();
    expect(event.frequency).toBeNull();
    // US-only vendor: an absent currency defaults to USD, never a guess
    // beyond that.
    expect(event.currency).toBe('USD');
  });

  it('drops malformed rows (missing id, amount or ex-date) instead of guessing', () => {
    const events = mapDividendResults([
      { cash_amount: 0.5, ex_dividend_date: '2026-05-01' }, // no id
      { id: 'E3', ex_dividend_date: '2026-05-01' }, // no amount
      { id: 'E4', cash_amount: 0.5 }, // no ex-date
      { id: 'E5', cash_amount: 0.5, ex_dividend_date: '2026-05-01' },
    ]);
    expect(events.map((e) => e.vendorId)).toEqual(['E5']);
  });

  it('keeps every cash dividend_type but drops zero-amount rows (decision, 2026-08-16)', () => {
    const events = mapDividendResults([
      // Special cash is still cash reaching the account — kept.
      { id: 'SC1', cash_amount: 2.5, ex_dividend_date: '2026-03-02', dividend_type: 'SC' },
      { id: 'LT1', cash_amount: 0.1, ex_dividend_date: '2026-03-02', dividend_type: 'LT' },
      // A payment of nothing is not a payment: a stored zero-gross row would
      // be noise in a tax record and uneditable (positive-gross validation).
      { id: 'Z1', cash_amount: 0, ex_dividend_date: '2026-03-02', dividend_type: 'CD' },
      { id: 'N1', cash_amount: -0.1, ex_dividend_date: '2026-03-02' },
    ]);
    expect(events.map((e) => e.vendorId)).toEqual(['SC1', 'LT1']);
  });

  it('degrades malformed date content instead of persisting it (2026-08-16 security pass)', () => {
    // The date strings feed a Postgres `date` column and the lexical
    // future-skip in sync.ts — content is validated through the one repo date
    // helper, and `.catch` keeps a bad value from failing the whole body: a
    // malformed ex-date drops its row, a malformed optional date nulls out.
    const parsed = dividendsResponseSchema.safeParse({
      results: [
        // US-format ex-date: not a YYYY-MM-DD → the row cannot be filed.
        { id: 'D1', cash_amount: 0.5, ex_dividend_date: '08/10/2026' },
        // Impossible calendar date → same drop (format alone is not enough).
        { id: 'D2', cash_amount: 0.5, ex_dividend_date: '2026-02-31' },
        // Malformed optional dates degrade to null; the row survives.
        {
          id: 'D3',
          cash_amount: 0.5,
          ex_dividend_date: '2026-05-01',
          pay_date: 'soon',
          declaration_date: 20260401 as unknown as string,
          record_date: '2026-13-01',
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const events = mapDividendResults(parsed.data.results ?? []);
      expect(events.map((e) => e.vendorId)).toEqual(['D3']);
      expect(events[0].payDate).toBeNull();
      expect(events[0].declarationDate).toBeNull();
      expect(events[0].recordDate).toBeNull();
    }
  });

  it('drops an implausible cash_amount and says so, never persisting it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events = mapDividendResults([
        // Vendor garbage far past any real per-share payment — dropped + logged.
        {
          id: 'G1',
          cash_amount: 2_000_000,
          ex_dividend_date: '2026-05-01',
          ticker: 'AAPL',
        },
        // A Seaboard-class special in the low thousands is real money — kept.
        { id: 'G2', cash_amount: 2500, ex_dividend_date: '2026-05-01' },
      ]);
      expect(events.map((e) => e.vendorId)).toEqual(['G2']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('G1');
      expect(warn.mock.calls[0][0]).toContain('AAPL');
    } finally {
      warn.mockRestore();
    }
  });

  it('tolerates unknown extra fields — the loose-schema philosophy', () => {
    const parsed = dividendsResponseSchema.safeParse({
      results: [
        {
          id: 'E6',
          cash_amount: 0.26,
          ex_dividend_date: '2026-02-10',
          dividend_type: 'CD',
          some_future_field: { nested: true },
        },
      ],
      next_url: 'https://api.massive.com/v3/reference/dividends?cursor=abc',
      status: 'OK',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const events = mapDividendResults(parsed.data.results ?? []);
      expect(events).toHaveLength(1);
      expect(events[0].cashAmount).toBe('0.26');
    }
  });
});

describe('mapTickerProfile', () => {
  const parse = (body: unknown) => {
    const parsed = tickerProfileSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    return mapTickerProfile(parsed.data);
  };

  const empty = {
    description: null,
    homepageUrl: null,
    sector: null,
    sharesOutstanding: null,
    sicCode: null,
    totalEmployees: null,
  };

  it('reads a full profile payload', () => {
    expect(
      parse({
        results: {
          ticker: 'AAPL',
          sic_code: '3571',
          sic_description: 'Electronic Computers',
          description: '  Apple designs consumer electronics.  ',
          homepage_url: ' https://www.apple.com ',
          total_employees: 164000,
          weighted_shares_outstanding: 15101622000,
          share_class_shares_outstanding: 15_000_000_000,
          locale: 'us',
          address: { address1: 'One Apple Park Way' },
        },
        status: 'OK',
      }),
    ).toEqual({
      sector: 'Electronic Computers',
      sicCode: '3571',
      description: 'Apple designs consumer electronics.',
      homepageUrl: 'https://www.apple.com',
      totalEmployees: 164000,
      sharesOutstanding: '15101622000',
    });
  });

  it('maps a branding-only payload to all nulls', () => {
    expect(parse({ results: { branding: { icon_url: 'https://x/y.png' } } })).toEqual(empty);
  });

  it('reads no domicile, because the vendor exposes none', () => {
    // Probed live 2026-08-18: `address` carries no `country` key on any
    // ticker, and `locale` is 'us' for every ticker because it means "listed
    // on a US market". Neither is a domicile, so neither is mapped.
    const mapped = parse({ results: { locale: 'us', address: { country: 'CH' } } });
    expect(Object.keys(mapped).sort()).toEqual([
      'description',
      'homepageUrl',
      'sector',
      'sharesOutstanding',
      'sicCode',
      'totalEmployees',
    ]);
  });

  it('survives a null results object', () => {
    expect(parse({ results: null, status: 'NOT_FOUND' })).toEqual(empty);
  });

  it('treats a blank sector as absent', () => {
    expect(parse({ results: { sic_description: '   ' } }).sector).toBeNull();
  });

  it('keeps the SIC code as a string', () => {
    expect(parse({ results: { sic_code: '0100' } }).sicCode).toBe('0100');
  });

  it('tolerates unknown extra fields', () => {
    expect(parse({ results: { sic_description: 'Retail', future: { a: 1 } } }).sector).toBe(
      'Retail',
    );
  });

  it('prefers weighted shares over the share-class figure', () => {
    expect(
      parse({
        results: {
          weighted_shares_outstanding: 3_178_000_000,
          share_class_shares_outstanding: 1,
        },
      }).sharesOutstanding,
    ).toBe('3178000000');
  });

  it('uses share-class shares when weighted is absent', () => {
    expect(
      parse({ results: { share_class_shares_outstanding: 3_178_000_000 } }).sharesOutstanding,
    ).toBe('3178000000');
  });

  it('keeps an integral share count as an exact decimal string', () => {
    expect(
      parse({ results: { weighted_shares_outstanding: 3_178_000_000 } }).sharesOutstanding,
    ).toBe('3178000000');
    expect(
      parse({ results: { weighted_shares_outstanding: 3_178_000_000 } }).sharesOutstanding,
    ).not.toMatch(/e/i);
  });

  it('treats a blank description as absent', () => {
    expect(parse({ results: { description: '   ' } }).description).toBeNull();
  });

  it('drops a homepage that is not http(s)', () => {
    expect(parse({ results: { homepage_url: 'ftp://example.com' } }).homepageUrl).toBeNull();
    expect(parse({ results: { homepage_url: 'javascript:alert(1)' } }).homepageUrl).toBeNull();
    expect(parse({ results: { homepage_url: 'not a url' } }).homepageUrl).toBeNull();
  });

  it('keeps a trimmed https homepage', () => {
    expect(parse({ results: { homepage_url: '  https://www.apple.com  ' } }).homepageUrl).toBe(
      'https://www.apple.com',
    );
  });

  it('refuses a negative or fractional employee count', () => {
    expect(parse({ results: { total_employees: -1 } }).totalEmployees).toBeNull();
    expect(parse({ results: { total_employees: 12.7 } }).totalEmployees).toBeNull();
  });
});
