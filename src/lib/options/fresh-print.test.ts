import { describe, expect, it } from 'vitest';

import type { OptionQuote, OptionQuoteOutcome } from '@/lib/market-data/options-types';
import type { Candle, MarketSessionInfo } from '@/lib/market-data/provider';

import { resolveOptionPrints } from './fresh-print';

/**
 * Unit tests for the freshest-print resolver, pinned on the VERIFIED vendor
 * fixtures (live against our own key, 2026-08-15):
 *
 * - ACME (`O:ACME270319C00260000`): snapshot `close = previous_close = 13.07`
 *   (the fake flat 0.00%) while the daily bars show 08-13 → 13.07 and
 *   08-14 → 12.10 — the stale-snapshot defect this module exists to fix.
 * - IDXF (`O:IDXF261218C00700000`): snapshot `92.73 / 94.30` matching its
 *   08-14 / 08-13 bars exactly — already correct, and the resolver must be a
 *   NO-OP on it.
 */

const ACME = 'O:ACME270319C00260000';
const IDXF = 'O:IDXF261218C00700000';

/** 2026-08-14 14:00 ET (Friday) — market open, NY date 2026-08-14. */
const OPEN_NOW_MS = Date.UTC(2026, 7, 14, 18);
/** The session `OPEN_NOW_MS` describes — the NY date it falls on. */
const DESCRIBED_SESSION = '2026-08-14';
/** 2026-08-15 12:00 UTC (Saturday) — closed; last completed session 08-14. */
const CLOSED_NOW_MS = Date.UTC(2026, 7, 15, 12);
/** 2026-08-17 14:00 ET (Monday) — a NEW session is running. */
const MONDAY_NOW_MS = Date.UTC(2026, 7, 17, 18);

const OPEN: MarketSessionInfo = {
  status: 'open',
  nextTransitionAtMs: null,
  nextTransitionKind: null,
  pollingResumesAtMs: null,
};

const CLOSED: MarketSessionInfo = {
  status: 'closed',
  nextTransitionAtMs: null,
  nextTransitionKind: null,
  pollingResumesAtMs: Date.UTC(2026, 7, 17, 8),
};

/** A daily bar whose start instant lands mid-day NY on `dateISO`. */
function bar(dateISO: string, close: string): Candle {
  return {
    t: Date.parse(`${dateISO}T16:00:00Z`), // 12:00 ET — same NY calendar date
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
  };
}

function quote(
  ticker: string,
  price: string,
  prevClose: string | null,
  overrides: Partial<OptionQuote> = {},
): OptionQuoteOutcome {
  // Degenerate (price === prevClose) → the vendor's 0/0 pair; otherwise the
  // caller supplies the pair via overrides — no arithmetic on money strings
  // in a fixture builder.
  const pair =
    prevClose === null
      ? { dayChangeAmt: null, dayChangePct: null }
      : { dayChangeAmt: '0', dayChangePct: '0' };
  return {
    ok: true,
    quote: {
      ticker,
      underlying: 'X',
      price,
      prevClose,
      ...pair,
      marketStatus: 'open',
      greeks: { delta: null, gamma: null, theta: null, vega: null },
      impliedVolatility: null,
      openInterest: null,
      contractType: 'call',
      strikePrice: '260',
      expirationDate: '2027-03-19',
      sharesPerContract: '100',
      asOf: new Date(OPEN_NOW_MS),
      asOfSource: 'fetch',
      delaySeconds: 900,
      source: 'massive',
      ...overrides,
    },
  };
}

function resolve(
  quotes: [string, OptionQuoteOutcome][],
  bars: [string, Candle[]][],
  market: MarketSessionInfo = OPEN,
  nowMs: number = OPEN_NOW_MS,
) {
  return resolveOptionPrints(new Map(quotes), new Map(bars), market, nowMs);
}

describe('the ACME golden fixture — stale snapshot out-voted by the daily bar', () => {
  const acmeQuote = quote(ACME, '13.07', '13.07');
  const acmeBars = [bar('2026-08-13', '13.07'), bar('2026-08-14', '12.10')];

  it('resolves to the newest bar: price 12.10, source bar, last trade 08-14', () => {
    const print = resolve([[ACME, acmeQuote]], [[ACME, acmeBars]]).get(ACME);
    expect(print?.price).toBe('12.10');
    expect(print?.source).toBe('bar');
    expect(print?.lastTradeDateISO).toBe('2026-08-14');
    expect(print?.noTradeThisSession).toBe(false);
  });

  it('derives the day pair 13.07 → 12.10 from the two newest bars — never the fake 0.00%', () => {
    const print = resolve([[ACME, acmeQuote]], [[ACME, acmeBars]]).get(ACME);
    expect(print?.day?.amt).toBe('-0.97');
    expect(print?.day?.pct?.startsWith('-7.4')).toBe(true); // −0.97/13.07 ≈ −7.42%
  });
});

describe('the IDXF fixture — a correct liquid contract is a NO-OP', () => {
  const idxfQuote = quote(IDXF, '92.73', '94.30', {
    dayChangeAmt: '-1.57',
    dayChangePct: '-1.00',
  });
  const idxfBars = [bar('2026-08-13', '94.30'), bar('2026-08-14', '92.73')];

  it('agrees with the newest bar and keeps the snapshot as the source', () => {
    const print = resolve([[IDXF, idxfQuote]], [[IDXF, idxfBars]]).get(IDXF);
    expect(print?.price).toBe('92.73');
    expect(print?.source).toBe('snapshot');
    expect(print?.lastTradeDateISO).toBe('2026-08-14');
  });

  it("keeps the snapshot's OWN day pair — one source for price and pair", () => {
    const print = resolve([[IDXF, idxfQuote]], [[IDXF, idxfBars]]).get(IDXF);
    expect(print?.day?.amt).toBe('-1.57');
    expect(print?.day?.pct).toBe('-1.00');
  });
});

describe('price selection', () => {
  it('prefers a snapshot matching no bar — a fresher print the delayed aggregates lack', () => {
    const print = resolve(
      [[ACME, quote(ACME, '12.50', '13.07', { dayChangeAmt: '-0.57', dayChangePct: '-4.36' })]],
      [[ACME, [bar('2026-08-13', '13.07'), bar('2026-08-14', '12.10')]]],
    ).get(ACME);
    expect(print?.price).toBe('12.50');
    expect(print?.source).toBe('snapshot');
    // Coherent pair: snapshot source → the snapshot's own pair.
    expect(print?.day?.amt).toBe('-0.57');
  });

  it('matches by Decimal equality — 13.07 and 13.0700 are one number', () => {
    const print = resolve(
      [[ACME, quote(ACME, '13.0700', '13.0700')]],
      [[ACME, [bar('2026-08-13', '13.07'), bar('2026-08-14', '12.10')]]],
    ).get(ACME);
    // '13.0700' equals its OWN '13.0700' previous close — the degenerate pair
    // — so the snapshot never advanced and the bars decide. Equality is
    // Decimal, not string: '13.07' and '13.0700' are one number.
    expect(print?.price).toBe('12.10');
    expect(print?.source).toBe('bar');
  });

  it('does NOT out-vote a fresh snapshot that coincidentally matches an old bar', () => {
    // The regression that motivated the rewrite. A thin option revisits price
    // levels constantly, so "the snapshot equals SOME older close" proves
    // nothing. Here 11.40 is a genuine current-session trade (pair 11.40 vs a
    // 12.10 previous close — non-degenerate) that happens to equal a close
    // from three weeks earlier. The old rule read that coincidence as
    // staleness and replaced a live price with a stale one; the snapshot must
    // win, and its own pair must render.
    const print = resolve(
      [[ACME, quote(ACME, '11.40', '12.10', { dayChangeAmt: '-0.70', dayChangePct: '-5.79' })]],
      [
        [
          ACME,
          [
            bar('2026-07-24', '11.40'), // the coincidental old match
            bar('2026-08-13', '13.07'),
            bar('2026-08-14', '12.10'),
          ],
        ],
      ],
    ).get(ACME);
    expect(print?.price).toBe('11.40');
    expect(print?.source).toBe('snapshot');
    expect(print?.noTradeThisSession).toBe(false);
    expect(print?.day?.amt).toBe('-0.70');
  });

  it('passes the snapshot through unchanged when no bars arrived', () => {
    const print = resolve([[ACME, quote(ACME, '5.10', '5.00', { dayChangeAmt: '0.10', dayChangePct: '2.00' })]], []).get(ACME);
    expect(print?.price).toBe('5.10');
    expect(print?.source).toBe('snapshot');
    // A non-degenerate pair (5.10 against a 5.00 previous close) is the
    // vendor's own evidence that this contract traded in the session being
    // described — so the print is dated to that session even with no bars to
    // corroborate it. Dating it `null` would discard evidence we hold.
    expect(print?.lastTradeDateISO).toBe(DESCRIBED_SESSION);
    expect(print?.noTradeThisSession).toBe(false);
    expect(print?.day?.amt).toBe('0.10');
  });

  it('never derives a bar pair without a previous bar — the snapshot pair renders instead', () => {
    // One bar only, agreeing with the snapshot: the pair must come from the
    // snapshot (or be null) — never from a nonexistent previous bar.
    const print = resolve(
      [[ACME, quote(ACME, '12.10', '13.07', { dayChangeAmt: '-0.97', dayChangePct: '-7.42' })]],
      [[ACME, [bar('2026-08-14', '12.10')]]],
    ).get(ACME);
    expect(print?.price).toBe('12.10');
    expect(print?.source).toBe('snapshot');
    expect(print?.day?.amt).toBe('-0.97');
  });
});

describe('honest day suppression', () => {
  it('kills the unverifiable degenerate 0.00% when no bars exist', () => {
    const print = resolve([[ACME, quote(ACME, '13.07', '13.07')]], []).get(ACME);
    expect(print?.price).toBe('13.07');
    expect(print?.day).toBeNull();
    expect(print?.noTradeThisSession).toBe(false); // unknowable, not asserted
  });

  it('flags no-trade when bars prove the last print predates the session', () => {
    const print = resolve(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [[ACME, [bar('2026-08-12', '13.00'), bar('2026-08-13', '13.07')]]],
    ).get(ACME);
    expect(print?.price).toBe('13.07'); // equals the newest bar — agreement
    expect(print?.lastTradeDateISO).toBe('2026-08-13');
    expect(print?.day).toBeNull();
    expect(print?.noTradeThisSession).toBe(true);
  });

  it('renders a GENUINE bar-verified flat day as 0.00%, not a suppression', () => {
    // Traded today at yesterday's price: the same degenerate-LOOKING 0/0
    // snapshot pair, but the bars prove the trade date is current — so the
    // honest answer really is a flat 0.00%, and it renders.
    const print = resolve(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [[ACME, [bar('2026-08-13', '13.07'), bar('2026-08-14', '13.07')]]],
    ).get(ACME);
    expect(print?.day).toEqual({ amt: '0', pct: '0' });
    expect(print?.noTradeThisSession).toBe(false);
  });

  it('switches the described session on market status — closed weekend accepts Friday prints', () => {
    const barsToFriday: [string, Candle[]][] = [
      [ACME, [bar('2026-08-13', '13.07'), bar('2026-08-14', '12.10')]],
    ];
    // Saturday, closed: the described session is Friday 08-14 → day renders.
    const closedPrint = resolve(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      barsToFriday,
      CLOSED,
      CLOSED_NOW_MS,
    ).get(ACME);
    expect(closedPrint?.day).not.toBeNull();
    expect(closedPrint?.noTradeThisSession).toBe(false);

    // Monday, open: the described session is 08-17 → Friday's print is stale.
    const mondayPrint = resolve(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      barsToFriday,
      OPEN,
      MONDAY_NOW_MS,
    ).get(ACME);
    expect(mondayPrint?.day).toBeNull();
    expect(mondayPrint?.noTradeThisSession).toBe(true);
  });
});

describe('degraded inputs', () => {
  it('keeps a missing quote a dash state while bars still date the last print', () => {
    const print = resolve([], [[ACME, [bar('2026-08-13', '13.07')]]]).get(ACME);
    expect(print?.price).toBeNull();
    expect(print?.lastTradeDateISO).toBe('2026-08-13');
    expect(print?.day).toBeNull();
    expect(print?.noTradeThisSession).toBe(true);
  });

  it('treats a failed outcome exactly like a missing quote', () => {
    const failed: OptionQuoteOutcome = { ok: false, symbol: ACME, reason: 'not_found' };
    const print = resolve([[ACME, failed]], [[ACME, [bar('2026-08-14', '12.10')]]]).get(ACME);
    expect(print?.price).toBeNull();
    expect(print?.lastTradeDateISO).toBe('2026-08-14');
  });

  it('resolves empty inputs to an empty map', () => {
    expect(resolve([], []).size).toBe(0);
  });
});

describe('silent longer than the lookback window', () => {
  // The whole distinction rides on `Map.has` vs `Map.get()?.length`: a
  // KNOWN-EMPTY window (the sync answered, there were no bars in 35 days) is
  // evidence the contract has been silent for over a month, while an ABSENT
  // entry (the sync never ran or failed) supports no claim at all. Without
  // these, a one-character regression would let a months-old price into the
  // USD total wearing no caption — the exact thing the flag exists to stop.

  it('discloses a known-empty window: degenerate pair', () => {
    const print = resolve([[ACME, quote(ACME, '13.07', '13.07')]], [[ACME, []]]).get(ACME);
    expect(print?.staleBeyondLookback).toBe(true);
    expect(print?.noTradeThisSession).toBe(true);
    expect(print?.lastTradeDateISO).toBeNull();
    expect(print?.day).toBeNull();
  });

  it('discloses a known-empty window when there is no previous close either', () => {
    // The ultra-thin class: no `previous_close` to judge freshness by AND no
    // bars. Silence is all we have, so silence is what we report.
    const print = resolve([[ACME, quote(ACME, '13.07', null)]], [[ACME, []]]).get(ACME);
    expect(print?.staleBeyondLookback).toBe(true);
    expect(print?.noTradeThisSession).toBe(true);
  });

  it('claims nothing when the sync never answered for that ticker', () => {
    const print = resolve([[ACME, quote(ACME, '13.07', '13.07')]], []).get(ACME);
    expect(print?.staleBeyondLookback).toBe(false);
    expect(print?.noTradeThisSession).toBe(false);
  });
});

describe('the MODEL MARK — a third, preferred source (2026-08-15)', () => {
  /** The measured ACME mark: 9.99 where the last trade said 12.10. */
  const MARK = '9.99';

  function resolveWithMark(
    quotes: [string, OptionQuoteOutcome][],
    bars: [string, Candle[]][],
    marks: [string, string][],
    /** Newest-first per ticker, ≤2 — the loader's shape. */
    recentMarks: [string, { asOf: string; mark: string }[]][] = [],
    market: MarketSessionInfo = OPEN,
    nowMs: number = OPEN_NOW_MS,
  ) {
    return resolveOptionPrints(
      new Map(quotes),
      new Map(bars),
      market,
      nowMs,
      new Map(marks),
      new Map(recentMarks),
    );
  }

  it('out-ranks a FRESH, non-degenerate snapshot', () => {
    const fresh = quote(IDXF, '92.73', '94.30', {
      dayChangeAmt: '-1.57',
      dayChangePct: '-1.00',
    });
    const print = resolveWithMark([[IDXF, fresh]], [], [[IDXF, '91.54']]).get(IDXF);
    expect(print?.price).toBe('91.54');
    expect(print?.source).toBe('model');
  });

  it('out-ranks a newer BAR — the thin contract case the marks exist for', () => {
    const print = resolveWithMark(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [[ACME, [bar('2026-08-13', '13.07'), bar('2026-08-14', '12.10')]]],
      [[ACME, MARK]],
    ).get(ACME);
    expect(print?.price).toBe(MARK);
    expect(print?.source).toBe('model');
  });

  it('derives the day pair MARK vs PREVIOUS MARK, and dates the basis', () => {
    const print = resolveWithMark(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [],
      [[ACME, MARK]],
      [[ACME, [{ asOf: '2026-08-13', mark: '10.09' }]]],
    ).get(ACME);
    expect(print?.day?.amt).toBe('-0.1');
    expect(print?.day?.pct?.startsWith('-0.99')).toBe(true);
    expect(print?.dayBasisMarkDateISO).toBe('2026-08-13');
    // The tip is the LIVE mark shown as the price — no second date to name.
    expect(print?.dayBasisTipDateISO).toBeNull();
  });

  it('never subtracts a mark from a traded close — a stale basis suppresses the pair', () => {
    const print = resolveWithMark(
      [[ACME, quote(ACME, '12.10', '13.07', { dayChangeAmt: '-0.97', dayChangePct: '-7.42' })]],
      [[ACME, [bar('2026-08-13', '13.07'), bar('2026-08-14', '12.10')]]],
      [[ACME, MARK]],
      // Six calendar days back — a long weekend allowance is 5.
      [[ACME, [{ asOf: '2026-08-08', mark: '10.09' }]]],
    ).get(ACME);
    expect(print?.day).toBeNull();
    expect(print?.dayBasisMarkDateISO).toBeNull();
  });

  it('leaves the day figure BLANK when no previous mark exists — never invented', () => {
    const print = resolveWithMark([[ACME, quote(ACME, '13.07', '13.07')]], [], [[ACME, MARK]]).get(
      ACME,
    );
    expect(print?.day).toBeNull();
    expect(print?.dayBasisMarkDateISO).toBeNull();
  });

  it("ignores a mark recorded for TODAY's NY date — a figure can never be its own base", () => {
    const print = resolveWithMark(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [],
      [[ACME, MARK]],
      [[ACME, [{ asOf: DESCRIBED_SESSION, mark: '10.09' }]]],
    ).get(ACME);
    expect(print?.day).toBeNull();
  });

  it('keeps lastTradeDateISO and staleBeyondLookback bar-derived under a mark', () => {
    const dated = resolveWithMark(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [[ACME, [bar('2026-08-13', '13.07')]]],
      [[ACME, MARK]],
    ).get(ACME);
    expect(dated?.lastTradeDateISO).toBe('2026-08-13');
    expect(dated?.staleBeyondLookback).toBe(false);

    const silent = resolveWithMark(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [[ACME, []]],
      [[ACME, MARK]],
    ).get(ACME);
    expect(silent?.lastTradeDateISO).toBeNull();
    expect(silent?.staleBeyondLookback).toBe(true);
  });

  it('forces noTradeThisSession FALSE — the phrase would contradict a moving estimate', () => {
    const print = resolveWithMark(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [[ACME, [bar('2026-08-13', '13.07')]]],
      [[ACME, MARK]],
    ).get(ACME);
    expect(print?.noTradeThisSession).toBe(false);
  });

  it('leaves a ticker with NO mark on exactly its existing branch', () => {
    const prints = resolveWithMark(
      [
        [ACME, quote(ACME, '13.07', '13.07')],
        [IDXF, quote(IDXF, '92.73', '94.30', { dayChangeAmt: '-1.57', dayChangePct: '-1.00' })],
      ],
      [
        [ACME, [bar('2026-08-13', '13.07'), bar('2026-08-14', '12.10')]],
        [IDXF, [bar('2026-08-13', '94.30'), bar('2026-08-14', '92.73')]],
      ],
      [[IDXF, '91.54']],
    );
    // ACME keeps BAR AUTHORITY, byte for byte.
    expect(prints.get(ACME)?.price).toBe('12.10');
    expect(prints.get(ACME)?.source).toBe('bar');
    expect(prints.get(ACME)?.day?.amt).toBe('-0.97');
    expect(prints.get(ACME)?.day?.pct.startsWith('-7.42')).toBe(true);
    // IDXF takes the model branch beside it — one resolver, two sources.
    expect(prints.get(IDXF)?.source).toBe('model');
  });

  it('never conjures a price for a ticker with no quote, mark or not', () => {
    const print = resolveWithMark([], [[ACME, [bar('2026-08-13', '13.07')]]], [[ACME, MARK]]).get(
      ACME,
    );
    expect(print?.price).toBeNull();
    expect(print?.source).toBe('snapshot');
  });

  it('ignores a mark dated TODAY but still uses the older one behind it', () => {
    const print = resolveWithMark(
      [[ACME, quote(ACME, '13.07', '13.07')]],
      [],
      [[ACME, MARK]],
      [
        [
          ACME,
          [
            { asOf: DESCRIBED_SESSION, mark: '11.11' },
            { asOf: '2026-08-13', mark: '10.09' },
          ],
        ],
      ],
    ).get(ACME);
    expect(print?.dayBasisMarkDateISO).toBe('2026-08-13');
    expect(print?.day?.amt).toBe('-0.1');
    expect(print?.dayBasisTipDateISO).toBeNull();
  });
});

/**
 * THE SHUT-MARKET RULE (2026-08-15). While no session runs, the live mark is
 * computed from the last completed session's OWN snapshot data — so comparing
 * it against that same session's recorded mark is a self-comparison and yields
 * a fabricated 0,00%. The honest figure is the move that happened DURING the
 * last completed session: the two most recent RECORDED marks. Same decision as
 * the stock tiles (commit 890249d).
 *
 * `CLOSED_NOW_MS` is Sat 2026-08-15 12:00 UTC — NY today 2026-08-15, last
 * completed session 2026-08-14.
 */
describe('the model mark while the market is SHUT — last session, never a self-zero', () => {
  const MARK = '9.99';

  /** Pre-market: options cannot print before 09:30 ET, so this counts as shut. */
  const EARLY: MarketSessionInfo = {
    status: 'early_trading',
    nextTransitionAtMs: null,
    nextTransitionKind: null,
    pollingResumesAtMs: null,
  };

  function closedPrint(
    recent: { asOf: string; mark: string }[],
    mark: string = MARK,
    market: MarketSessionInfo = CLOSED,
  ) {
    return resolveOptionPrints(
      new Map([[ACME, quote(ACME, '13.07', '13.07')]]),
      new Map(),
      market,
      CLOSED_NOW_MS,
      new Map([[ACME, mark]]),
      new Map([[ACME, recent]]),
    ).get(ACME);
  }

  const TWO_MARKS = [
    { asOf: '2026-08-14', mark: '9.99' },
    { asOf: '2026-08-13', mark: '10.09' },
  ];

  it('derives the pair from the two RECORDED marks, not from the live mark', () => {
    // Live mark deliberately far from both recorded figures: if it leaked into
    // the pair the numbers below could not survive.
    const print = closedPrint(TWO_MARKS, '42.00');
    expect(print?.price).toBe('42.00'); // the price stays the LIVE mark
    expect(print?.day?.amt).toBe('-0.1'); // 10.09 → 9.99, the 08-14 session
    expect(print?.day?.pct.startsWith('-0.99')).toBe(true);
    expect(print?.dayBasisMarkDateISO).toBe('2026-08-13');
    expect(print?.dayBasisTipDateISO).toBe('2026-08-14');
  });

  it('never fabricates a 0,00% when the live mark equals the newest recorded one', () => {
    // This is the exact defect: mark 9.99 vs the 08-14 row's 9.99 would be 0.
    const print = closedPrint(TWO_MARKS, '9.99');
    expect(print?.day?.amt).toBe('-0.1');
    expect(print?.day?.amt).not.toBe('0');
  });

  it('shows an em-dash worth of nothing with exactly ONE recorded mark', () => {
    const print = closedPrint([{ asOf: '2026-08-14', mark: '9.99' }]);
    expect(print?.day).toBeNull();
    expect(print?.dayBasisMarkDateISO).toBeNull();
    expect(print?.dayBasisTipDateISO).toBeNull();
  });

  it('shows nothing with ZERO recorded marks — the day-one path', () => {
    const print = closedPrint([]);
    expect(print?.day).toBeNull();
    expect(print?.dayBasisMarkDateISO).toBeNull();
    expect(print?.dayBasisTipDateISO).toBeNull();
  });

  it('suppresses a fortnight-wide gap rather than call it a day move', () => {
    const print = closedPrint([
      { asOf: '2026-08-14', mark: '9.99' },
      { asOf: '2026-07-31', mark: '10.09' },
    ]);
    expect(print?.day).toBeNull();
    expect(print?.dayBasisMarkDateISO).toBeNull();
  });

  it('suppresses a pair whose newer end is itself stale — history, not a day', () => {
    const print = closedPrint([
      { asOf: '2026-08-04', mark: '9.99' },
      { asOf: '2026-08-03', mark: '10.09' },
    ]);
    expect(print?.day).toBeNull();
    expect(print?.dayBasisMarkDateISO).toBeNull();
  });

  it('lets a GENUINELY flat session survive as a real, dated 0.00%', () => {
    const print = closedPrint([
      { asOf: '2026-08-14', mark: '10.09' },
      { asOf: '2026-08-13', mark: '10.09' },
    ]);
    expect(print?.day?.amt).toBe('0');
    expect(print?.dayBasisMarkDateISO).toBe('2026-08-13');
    expect(print?.dayBasisTipDateISO).toBe('2026-08-14');
  });

  it('refuses a reversed pair rather than sign-flip the move', () => {
    // Defensive: the loader orders desc(asOf); an ascending list must not
    // silently produce +0.99% where −0.99% is the truth.
    const print = closedPrint([
      { asOf: '2026-08-13', mark: '10.09' },
      { asOf: '2026-08-14', mark: '9.99' },
    ]);
    expect(print?.day).toBeNull();
  });

  it('treats early_trading exactly like closed — ONE notion of "running"', () => {
    const early = closedPrint(TWO_MARKS, '42.00', EARLY);
    const shut = closedPrint(TWO_MARKS, '42.00');
    expect(early?.day).toEqual(shut?.day);
    expect(early?.dayBasisTipDateISO).toBe('2026-08-14');
  });

  it('leaves price, source and the trade-derived facts untouched', () => {
    const print = closedPrint(TWO_MARKS);
    expect(print?.price).toBe(MARK);
    expect(print?.source).toBe('model');
    expect(print?.noTradeThisSession).toBe(false);
  });

  it('keeps the LIVE-session path exactly as it is: live mark vs last evening', () => {
    // Same two recorded marks, but a session is RUNNING (Mon 08-17). The tip
    // must be the live mark, the base Friday's row — NOT the recorded pair.
    const print = resolveOptionPrints(
      new Map([[ACME, quote(ACME, '13.07', '13.07')]]),
      new Map(),
      OPEN,
      MONDAY_NOW_MS,
      new Map([[ACME, '42.00']]),
      new Map([[ACME, TWO_MARKS]]),
    ).get(ACME);
    // 9.99 → 42.00, the live mark against the newest recorded evening.
    expect(print?.day?.amt).toBe('32.01');
    expect(print?.dayBasisMarkDateISO).toBe('2026-08-14');
    expect(print?.dayBasisTipDateISO).toBeNull();
  });
});
