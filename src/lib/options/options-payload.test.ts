import { describe, expect, it } from 'vitest';

import type {
  OptionQuote,
  OptionQuoteOutcome,
} from '@/lib/market-data/options-types';
import type { MarketSessionInfo } from '@/lib/market-data/provider';
import { dec, fmtMoney } from '@/lib/money';

import type { ResolvedPrint } from './fresh-print';
import {
  composeOptionsPayload,
  type OptionPositionRow,
} from './options-payload';

/**
 * Unit tests for the Options payload compose — the Decimal P/L math, the
 * break-even by contract type, the NY-calendar days-to-expiry, and the
 * dash-over-fake-zero discipline on a missing quote.
 */

const TICKER = 'O:AAPL260904C00220000';

/** 2026-08-14 08:00 ET — NY calendar date 2026-08-14. */
const NOW_MS = Date.UTC(2026, 7, 14, 12);

const MARKET: MarketSessionInfo = {
  status: 'open',
  nextTransitionAtMs: null,
  nextTransitionKind: null,
  pollingResumesAtMs: null,
};

function row(overrides: Partial<OptionPositionRow> = {}): OptionPositionRow {
  return {
    id: 'lot-1',
    ticker: TICKER,
    underlying: 'AAPL',
    contractType: 'call',
    strikePrice: '220.00000000',
    expirationDate: '2026-09-04',
    sharesPerContract: '100.00000000',
    quantity: '2.00000000',
    entryPrice: '3.50000000',
    tradeDate: '2026-08-10',
    fees: '0.00000000',
    ...overrides,
  };
}

function quote(overrides: Partial<OptionQuote> = {}): OptionQuoteOutcome {
  return {
    ok: true,
    quote: {
      ticker: TICKER,
      underlying: 'AAPL',
      price: '5',
      prevClose: '4',
      dayChangeAmt: '1',
      dayChangePct: '25',
      marketStatus: 'open',
      greeks: { delta: '0.64', gamma: '0.01', theta: '-0.05', vega: '0.22' },
      impliedVolatility: '0.29',
      openInterest: 1500,
      contractType: 'call',
      strikePrice: '220',
      expirationDate: '2026-09-04',
      sharesPerContract: '100',
      asOf: new Date(NOW_MS),
      asOfSource: 'fetch',
      delaySeconds: 900,
      source: 'massive',
      ...overrides,
    },
  };
}

function compose(
  rows: OptionPositionRow[],
  quotes: ReadonlyMap<string, OptionQuoteOutcome>,
  nowMs = NOW_MS,
) {
  return composeOptionsPayload(rows, quotes, MARKET, nowMs);
}

describe('P/L math', () => {
  it('computes the lot P/L on exact Decimal fixtures', () => {
    // (5 − 3.5) × 2 × 100 = 300, exactly.
    const { items } = compose([row()], new Map([[TICKER, quote()]]));
    expect(items[0].plRaw).toBe('300.00000000');
    expect(items[0].pl?.direction).toBe('gain');
    // Percent is per-share vs entry: (5 − 3.5) / 3.5 = +42.86%.
    expect(items[0].pl?.text).toContain('42,86');
    expect(items[0].pl?.text.startsWith('+')).toBe(true);
  });

  it('stays exact where float math would drift', () => {
    // (0.05 − 0.02) × 3 × 100 = 9 exactly; IEEE doubles give 9.000000000000002.
    const { items } = compose(
      [row({ entryPrice: '0.02000000', quantity: '3.00000000' })],
      new Map([[TICKER, quote({ price: '0.05' })]]),
    );
    expect(items[0].plRaw).toBe('9.00000000');
    expect(items[0].pl?.text).toContain('150,00'); // (0.05−0.02)/0.02 = +150%
  });

  it('merges duplicate lots into ONE P/L, the sum of what each lot earned', () => {
    // Two purchases of one contract are one position (2026-08-15): 2 @ 3.50
    // and 2 @ 6.00 → 4 contracts at a weighted average of 4.75.
    // (5 − 4.75) × 4 × 100 = 100 = +300 + (−200), exactly the two lots' own
    // P/Ls added together.
    const { items } = compose(
      [
        row({ id: 'lot-1', entryPrice: '3.50000000' }),
        row({ id: 'lot-2', entryPrice: '6.00000000' }),
      ],
      new Map([[TICKER, quote()]]),
    );
    expect(items).toHaveLength(1);
    expect(items[0].plRaw).toBe('100.00000000');
    expect(items[0].pl?.direction).toBe('gain');
  });

  it('renders a zero entry price with a null percent — never a division crash', () => {
    const { items } = compose(
      [row({ entryPrice: '0' })],
      new Map([[TICKER, quote()]]),
    );
    // Amount still computes: (5 − 0) × 2 × 100 = 1000. Percent is undefined
    // (pctChange semantics), so the text carries NO percent part.
    expect(items[0].plRaw).toBe('1000.00000000');
    expect(items[0].pl?.text).not.toContain('(');
    expect(items[0].pl?.text).not.toContain('%');
  });
});

describe('fees — the P/L amount is net of costs', () => {
  it('subtracts the recorded fees from the P/L amount on exact Decimal fixtures', () => {
    // (5 − 3.5) × 2 × 100 − 2.04 = 297.96, exactly (the Saxo reference costs).
    const { items } = compose(
      [row({ fees: '2.04000000' })],
      new Map([[TICKER, quote()]]),
    );
    expect(items[0].plRaw).toBe('297.96000000');
    expect(items[0].pl?.direction).toBe('gain');
    // The costs render formatted, and the caption can key off non-null.
    expect(items[0].fees).toContain('2,04');
  });

  it('renders zero fees as null — no costs line, no caption, unchanged P/L', () => {
    const { items } = compose([row()], new Map([[TICKER, quote()]]));
    expect(items[0].fees).toBeNull();
    expect(items[0].plRaw).toBe('300.00000000');
  });

  it('leaves the percent and the break-even untouched by fees', () => {
    const { items } = compose(
      [row({ fees: '2.04000000' })],
      new Map([[TICKER, quote()]]),
    );
    // Percent stays the per-share price-vs-entry figure: +42.86%.
    expect(items[0].pl?.text).toContain('42,86');
    // Break-even stays entry-price-only: 220 + 3.5.
    expect(items[0].breakEven).toContain('223,50');
  });

  it('flips the direction when the fee exceeds the gross P/L', () => {
    // Gross 300, fees 400 → net −100: a loss even though the price rose.
    const { items } = compose(
      [row({ fees: '400.00000000' })],
      new Map([[TICKER, quote()]]),
    );
    expect(items[0].plRaw).toBe('-100.00000000');
    expect(items[0].pl?.direction).toBe('loss');
  });

  it('carries the raw LOT fields the edit form prefills, zeros trimmed', () => {
    // They live on the member lot, never on the card: a card's own entry
    // price can be a weighted average, which no edit may ever submit.
    const { items } = compose([row({ fees: '2.04000000' })], new Map());
    expect(items[0].lots).toHaveLength(1);
    expect(items[0].lots[0].id).toBe('lot-1');
    expect(items[0].lots[0].quantityRaw).toBe('2');
    expect(items[0].lots[0].entryPriceRaw).toBe('3.5');
    expect(items[0].lots[0].feesRaw).toBe('2.04');
    expect(items[0].lots[0].tradeDate).toBe('2026-08-10');
  });
});

describe('break-even', () => {
  it('adds the entry premium to the strike for calls', () => {
    const { items } = compose([row()], new Map());
    expect(items[0].breakEven).toContain('223,50');
  });

  it('subtracts the entry premium from the strike for puts', () => {
    const { items } = compose([row({ contractType: 'put' })], new Map());
    expect(items[0].breakEven).toContain('216,50');
  });
});

describe('missing quote — the dash state', () => {
  it('yields nulls for every live figure and dashes for the definition row', () => {
    const { items } = compose([row()], new Map());
    const item = items[0];
    expect(item.hasQuote).toBe(false);
    expect(item.price).toBeNull();
    expect(item.day).toBeNull();
    expect(item.pl).toBeNull();
    expect(item.plRaw).toBeNull();
    expect(item.delta).toBe('—');
    expect(item.gamma).toBe('—');
    expect(item.theta).toBe('—');
    expect(item.vega).toBe('—');
    expect(item.impliedVolatility).toBe('—');
    expect(item.openInterest).toBe('—');
    // Row-derived figures survive: the user's record outlives the quote.
    expect(item.breakEven).toContain('223,50');
    expect(item.daysToExpiry).toBe(21);
  });

  it('never renders an absent greek or IV as zero', () => {
    const { items } = compose(
      [row()],
      new Map([
        [
          TICKER,
          quote({
            greeks: { delta: null, gamma: null, theta: null, vega: null },
            impliedVolatility: null,
            openInterest: null,
          }),
        ],
      ]),
    );
    const item = items[0];
    expect(item.hasQuote).toBe(true);
    for (const value of [item.delta, item.gamma, item.theta, item.vega, item.impliedVolatility, item.openInterest]) {
      expect(value).toBe('—');
      expect(value).not.toContain('0');
    }
  });
});

describe('days to expiry — NY calendar, never the device clock', () => {
  it('counts across a month boundary', () => {
    // 2026-08-31 08:00 ET → four days to 2026-09-04.
    const { items } = compose([row()], new Map(), Date.UTC(2026, 7, 31, 12));
    expect(items[0].daysToExpiry).toBe(4);
    expect(items[0].expired).toBe(false);
  });

  it('reads zero on expiry day itself, not expired', () => {
    const { items } = compose([row()], new Map(), Date.UTC(2026, 8, 4, 12));
    expect(items[0].daysToExpiry).toBe(0);
    expect(items[0].expired).toBe(false);
  });

  it('flags a past expiry as expired', () => {
    const { items } = compose([row({ expirationDate: '2026-08-01' })], new Map());
    expect(items[0].expired).toBe(true);
    expect(items[0].daysToExpiry).toBeLessThan(0);
  });

  it('uses the NY date on a Warsaw evening — never one day too few', () => {
    // 23:30 UTC on Aug 14 is ALREADY Aug 15 in Warsaw, but still Aug 14
    // 19:30 ET in New York: an Aug 15 expiry has 1 day left, not 0.
    const { items } = compose(
      [row({ expirationDate: '2026-08-15' })],
      new Map(),
      Date.UTC(2026, 7, 14, 23, 30),
    );
    expect(items[0].daysToExpiry).toBe(1);
    expect(items[0].expired).toBe(false);
  });
});

describe('a contract silent longer than the lookback window', () => {
  const ancient: ResolvedPrint = {
    price: '13.07',
    source: 'snapshot',
    lastTradeDateISO: null, // the window came back empty — no date is claimable
    day: null,
    noTradeThisSession: true,
    staleBeyondLookback: true,
  };

  it('captions the card in words and names the lot in the summary note', () => {
    const { items, summaryNotes } = composeOptionsPayload(
      [row()],
      new Map([[TICKER, quote({ price: '13.07' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, ancient]]),
    );
    // Both halves matter: a caption with no note would let the lot into the
    // total unremarked, a note with no caption would leave the card mute.
    expect(items[0].lastTradeBeyondLookback).toBe(true);
    expect(items[0].lastTradeLabel).toBeNull(); // no date to state
    expect(summaryNotes.join(' ')).toContain('over a month ago');
  });
});

describe('resolved prints — the freshest print flows into everything', () => {
  const barPrint: ResolvedPrint = {
    price: '12.10',
    source: 'bar',
    lastTradeDateISO: '2026-08-14',
    day: { amt: '-0.97', pct: '-7.42' },
    noTradeThisSession: false,
    staleBeyondLookback: false,
  };

  it('prices the card and the P/L from the resolved bar print, not the raw snapshot', () => {
    const { items } = composeOptionsPayload(
      [row({ fees: '0.00000000' })],
      new Map([[TICKER, quote({ price: '13.07' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, barPrint]]),
    );
    expect(items[0].price).toContain('12,10');
    // (12.10 − 3.5) × 2 × 100 = 1720 — the resolved price, exactly.
    expect(items[0].plRaw).toBe('1720.00000000');
    // The day pair is the bar-derived one — one source for price and pair.
    expect(items[0].day?.text).toContain('7,42');
    expect(items[0].lastTradeLabel).toBe('14 sie');
  });

  it('renders the no-trade state: null day, noTrade flag, dated label', () => {
    const stale: ResolvedPrint = {
      price: '13.07',
      source: 'snapshot',
      lastTradeDateISO: '2026-08-13',
      day: null,
      noTradeThisSession: true,
      staleBeyondLookback: false,
    };
    const { items, summaryNotes } = composeOptionsPayload(
      [row()],
      new Map([[TICKER, quote({ price: '13.07' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, stale]]),
    );
    expect(items[0].day).toBeNull();
    expect(items[0].dayPct).toBeNull();
    expect(items[0].noTrade).toBe(true);
    expect(items[0].lastTradeLabel).toBe('13 sie');
    expect(summaryNotes).toEqual([
      'Includes last prints from earlier sessions: AAPL $220C (13 sie)',
    ]);
  });

  it('suppresses a degenerate no-bars 0.00% through the default resolver', () => {
    // close === previous_close with no bars to verify it — the maybe-fake
    // zero must not render (the compose-side default resolver run).
    const { items } = compose(
      [row()],
      new Map([
        [TICKER, quote({ price: '5', prevClose: '5', dayChangeAmt: '0', dayChangePct: '0' })],
      ]),
    );
    expect(items[0].day).toBeNull();
    expect(items[0].dayPct).toBeNull();
    expect(items[0].noTrade).toBe(false);
  });
});

describe('tile fields', () => {
  it('carries a percent-only day figure and the P/L percent + direction', () => {
    const { items } = compose([row()], new Map([[TICKER, quote()]]));
    // dayPct is percent-ONLY (no amount, no currency) — the tile line.
    expect(items[0].dayPct?.text).toBe('+25,00%');
    expect(items[0].dayPct?.direction).toBe('gain');
    expect(items[0].plPct).toContain('42,86');
    expect(items[0].plDirection).toBe('gain');
  });

  it('renders the unpriceable tile state as dashes and neutral', () => {
    const { items } = compose([row()], new Map());
    expect(items[0].plPct).toBe('—');
    expect(items[0].plDirection).toBe('neutral');
    expect(items[0].dayPct).toBeNull();
    expect(items[0].lastTradeLabel).toBeNull();
    expect(items[0].noTrade).toBe(false);
  });
});

describe('summary — USD totals over the quoted set', () => {
  it('sums value, basis (fees included) and the day subset on exact fixtures', () => {
    const { summary } = compose(
      [row({ fees: '2.04000000' })],
      new Map([[TICKER, quote()]]),
    );
    // value = 5 × 2 × 100 = 1000.
    expect(summary.totalValue).toContain('1');
    expect(summary.totalValue).toContain('000,00');
    // net P/L = 300 − 2.04 = 297.96; pct vs basis 702.04 ≈ +42.44%.
    expect(summary.totalChange?.text).toContain('297,96');
    expect(summary.totalChange?.text).toContain('42,44');
    expect(summary.totalChange?.direction).toBe('gain');
    // day: 1 × 2 × 100 = 200 over covered value 1000 → base 800 → +25%.
    expect(summary.dayChange?.text).toContain('200,00');
    expect(summary.dayChange?.text).toContain('25,00');
    expect(summary.partialDayChange).toBe(false);
    expect(summary.excludedSymbols).toEqual([]);
  });

  it('excludes an unquoted lot from every total and names it compactly', () => {
    const other = row({
      id: 'lot-2',
      ticker: 'O:SNOW270115C00240000',
      underlying: 'SNOW',
      strikePrice: '240.00000000',
    });
    const { summary } = compose([row(), other], new Map([[TICKER, quote()]]));
    // The totals are exactly the single quoted lot's — nothing counted as 0.
    expect(summary.totalValue).toContain('000,00');
    expect(summary.excludedSymbols).toEqual(['SNOW $240C']);
  });

  it('reports null totals with zero quoted lots — never a fake $0', () => {
    const { summary } = compose([row()], new Map());
    expect(summary.totalValue).toBeNull();
    expect(summary.dayChange).toBeNull();
    expect(summary.totalChange).toBeNull();
    expect(summary.excludedSymbols).toEqual(['AAPL $220C']);
  });

  it('flags a partial day when a quoted lot has no day pair', () => {
    const { summary } = compose(
      [row()],
      new Map([
        [TICKER, quote({ prevClose: null, dayChangeAmt: null, dayChangePct: null })],
      ]),
    );
    expect(summary.partialDayChange).toBe(true);
    expect(summary.dayChange).toBeNull();
    // The lot is still quoted — the value total stands.
    expect(summary.totalValue).not.toBeNull();
  });
});

describe('payload envelope', () => {
  it('carries the market status and stamps a server clock', () => {
    const payload = compose([row()], new Map());
    expect(payload.market.status).toBe('open');
    expect(typeof payload.market.serverNowMs).toBe('number');
  });

  it('keeps a failed outcome out of the live figures (not a crash)', () => {
    const outcome: OptionQuoteOutcome = {
      ok: false,
      symbol: TICKER,
      reason: 'not_found',
    };
    const { items } = compose([row()], new Map([[TICKER, outcome]]));
    expect(items[0].hasQuote).toBe(false);
    expect(items[0].price).toBeNull();
  });
});

describe('model estimates — the mark is priced, labelled and disclosed', () => {
  /** The measured ACME mark, 9.99, against a 10.56 entry. */
  const modelPrint: ResolvedPrint = {
    price: '9.99',
    source: 'model',
    lastTradeDateISO: '2026-08-14',
    day: { amt: '-0.1', pct: '-0.99' },
    dayBasisMarkDateISO: '2026-08-14',
    noTradeThisSession: false,
    staleBeyondLookback: false,
  };

  /** One contract at 10.56, no costs — the sign-flip fixture. */
  const sampleLot = row({ quantity: '1.00000000', entryPrice: '10.56000000', fees: '0.00000000' });

  it('labels the price an estimate and dates the basis of its day figure', () => {
    const { items } = composeOptionsPayload(
      [sampleLot],
      new Map([[TICKER, quote({ price: '12.10' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, modelPrint]]),
    );
    expect(items[0].priceIsEstimate).toBe(true);
    expect(items[0].price).toContain('9,99');
    expect(items[0].dayBasisLabel).toBe('vs estimate of 14 sie');
    // The last-trade caption survives beside the estimate — when the contract
    // really traded is still a fact.
    expect(items[0].lastTradeLabel).toBe('14 sie');
  });

  it('names BOTH evenings while the market is shut — the figure is not from the price above', () => {
    // The shut-market print: the day pair spans two RECORDED evenings while
    // the price stays the live mark, so a one-dated label would invite the
    // number to be read as the move from that price.
    const closedPrint: ResolvedPrint = {
      ...modelPrint,
      dayBasisMarkDateISO: '2026-08-13',
      dayBasisTipDateISO: '2026-08-14',
    };
    const { items } = composeOptionsPayload(
      [sampleLot],
      new Map([[TICKER, quote({ price: '12.10' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, closedPrint]]),
    );
    expect(items[0].dayBasisLabel).toBe('estimate 13 sie → 14 sie');
  });

  it('agrees between the Options card and the Dashboard tile, by construction', () => {
    // `day` (card) and `dayPct` (tile) both derive from the SAME print.day —
    // this pins the coupling so a later edit cannot silently split them.
    const closedPrint: ResolvedPrint = {
      ...modelPrint,
      dayBasisMarkDateISO: '2026-08-13',
      dayBasisTipDateISO: '2026-08-14',
    };
    const { items } = composeOptionsPayload(
      [sampleLot],
      new Map([[TICKER, quote({ price: '12.10' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, closedPrint]]),
    );
    expect(items[0].dayPct).not.toBeNull();
    expect(items[0].dayPct?.text).toBe('-0,99%');
    expect(items[0].day?.text).toContain(items[0].dayPct?.text ?? 'unreachable');
    expect(items[0].dayPct?.direction).toBe(items[0].day?.direction);
  });

  it('renders no day figure and no basis label when no pair exists — a dash, never a zero', () => {
    const noPair: ResolvedPrint = {
      ...modelPrint,
      day: null,
      dayBasisMarkDateISO: null,
      dayBasisTipDateISO: null,
    };
    const { items } = composeOptionsPayload(
      [sampleLot],
      new Map([[TICKER, quote({ price: '12.10' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, noPair]]),
    );
    expect(items[0].day).toBeNull();
    expect(items[0].dayPct).toBeNull();
    expect(items[0].dayBasisLabel).toBeNull();
  });

  it('flips the P/L sign: the mark turns a fake gain into a −57,00 USD loss', () => {
    const { items, summary } = composeOptionsPayload(
      [sampleLot],
      new Map([[TICKER, quote({ price: '12.10' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, modelPrint]]),
    );
    // (9.99 − 10.56) × 1 × 100 = −57.00, exactly — the statement figure.
    expect(items[0].plRaw).toBe('-57.00000000');
    expect(items[0].plDirection).toBe('loss');
    // The last trade would have said (12.10 − 10.56) × 100 = +154.00.
    expect(summary.totalValue).toContain('999,00');
    expect(summary.totalChange?.text).toContain('-57,00');
    expect(summary.totalChange?.direction).toBe('loss');
  });

  it('states once, under the totals, that the figures are estimates', () => {
    const { summaryNotes } = composeOptionsPayload(
      [sampleLot, row({ id: 'lot-2' })],
      new Map([[TICKER, quote({ price: '12.10' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, modelPrint]]),
    );
    const estimateNotes = summaryNotes.filter((note) => note.includes('model estimates'));
    expect(estimateNotes).toHaveLength(1);
  });

  it('names exactly the quoted lots that fell back to a last trade', () => {
    const OTHER = 'O:MSFT260904C00500000';
    const otherRow = row({ id: 'lot-2', ticker: OTHER, underlying: 'MSFT', strikePrice: '500' });
    const fallback: ResolvedPrint = {
      price: '3.90',
      source: 'snapshot',
      lastTradeDateISO: '2026-08-14',
      day: null,
      noTradeThisSession: false,
      staleBeyondLookback: false,
    };
    const { summaryNotes } = composeOptionsPayload(
      [sampleLot, otherRow],
      new Map([
        [TICKER, quote({ price: '12.10' })],
        [OTHER, quote({ ticker: OTHER, price: '3.90' })],
      ]),
      MARKET,
      NOW_MS,
      new Map([
        [TICKER, modelPrint],
        [OTHER, fallback],
      ]),
    );
    const note = summaryNotes.find((n) => n.startsWith('Priced from the last trade'));
    expect(note).toBe('Priced from the last trade, no estimate available: MSFT $500C');
    expect(note).not.toContain('AAPL');
  });

  it('never names a model-priced lot in the stale-print note', () => {
    const staleModel: ResolvedPrint = {
      ...modelPrint,
      // The contract has not traded in the described session — irrelevant to a
      // price that no longer comes from a trade.
      noTradeThisSession: true,
      lastTradeDateISO: '2026-08-13',
    };
    const { summaryNotes, items } = composeOptionsPayload(
      [sampleLot],
      new Map([[TICKER, quote({ price: '12.10' })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, staleModel]]),
    );
    expect(summaryNotes.some((n) => n.startsWith('Includes last prints'))).toBe(false);
    expect(items[0].lastTradeLabel).toBe('13 sie');
  });

  it('leaves a non-estimated lot unlabelled and its basis null', () => {
    const { items } = composeOptionsPayload(
      [row()],
      new Map([[TICKER, quote()]]),
      MARKET,
      NOW_MS,
    );
    expect(items[0].priceIsEstimate).toBe(false);
    expect(items[0].dayBasisLabel).toBeNull();
  });

  it('renders no estimate label for an unpriceable lot — a dash is never an estimate', () => {
    const { items, summaryNotes } = composeOptionsPayload([row()], new Map(), MARKET, NOW_MS);
    expect(items[0].priceIsEstimate).toBe(false);
    expect(items[0].price).toBeNull();
    expect(summaryNotes).toEqual([]);
  });
});

describe('valueRaw — a sort key, never a rendered figure', () => {
  it('equals price × quantity × sharesPerContract as a decimal string', () => {
    // 5 × 2 × 100 = 1000, exactly — gross of fees, unlike plRaw.
    const { items } = compose([row({ fees: '2.04000000' })], new Map([[TICKER, quote()]]));
    expect(items[0].valueRaw).toBe('1000.00000000');
    expect(items[0].plRaw).toBe('297.96000000');
  });

  it('is null for an unquoted lot — unknown, never a zero', () => {
    const { items } = compose([row()], new Map());
    expect(items[0].valueRaw).toBeNull();
    expect(items[0].plRaw).toBeNull();
    expect(items[0].hasQuote).toBe(false);
  });
});

describe('expired lots — the hidden set and the total that describes it', () => {
  const EXPIRED_TICKER = 'O:AAPL260807C00220000';

  /** A quoted lot that expired a week before NOW_MS (NY calendar). */
  const expiredRow = row({
    id: 'lot-expired',
    ticker: EXPIRED_TICKER,
    expirationDate: '2026-08-07',
  });

  const bothQuoted = new Map([
    [TICKER, quote()],
    [EXPIRED_TICKER, quote({ ticker: EXPIRED_TICKER })],
  ]);

  it('counts expired lots and keeps them OUT of the default summary', () => {
    const payload = compose([row(), expiredRow], bothQuoted);
    expect(payload.expiredCount).toBe(1);
    expect(payload.items.find((i) => i.ticker === EXPIRED_TICKER)?.expired).toBe(true);
    // One live lot: 5 × 2 × 100 = 1000. Both: 2000.
    // pl-PL groups with a non-breaking space, so match it loosely.
    expect(payload.summary.totalValue).toMatch(/^1\u00a0000,00\u00a0USD$/);
    expect(payload.allSummary.totalValue).toMatch(/^2\u00a0000,00\u00a0USD$/);
  });

  it('the larger total says why it is larger, and the smaller one never does', () => {
    const { summaryNotes, allSummaryNotes } = compose([row(), expiredRow], bothQuoted);
    expect(allSummaryNotes[0]).toBe('Includes expired contracts.');
    expect(summaryNotes).not.toContain('Includes expired contracts.');
  });

  it('says nothing about expiry when nothing is expired', () => {
    const payload = compose([row()], new Map([[TICKER, quote()]]));
    expect(payload.expiredCount).toBe(0);
    expect(payload.allSummaryNotes).not.toContain('Includes expired contracts.');
    expect(payload.allSummaryNotes).toEqual(payload.summaryNotes);
    expect(payload.allSummary).toEqual(payload.summary);
  });

  it('a lot expiring exactly TODAY is not expired and is in the visible total', () => {
    // NOW_MS is 2026-08-14 in New York; the expiry DAY itself still trades.
    const todayTicker = 'O:AAPL260814C00220000';
    const payload = compose(
      [row({ id: 'lot-today', ticker: todayTicker, expirationDate: '2026-08-14' })],
      new Map([[todayTicker, quote({ ticker: todayTicker })]]),
    );
    expect(payload.expiredCount).toBe(0);
    expect(payload.items[0].expired).toBe(false);
    expect(payload.summary.totalValue).toContain('000,00');
  });

  it('names an unquoted EXPIRED lot only in the all-lots summary', () => {
    const unquotedExpired = row({
      id: 'lot-3',
      ticker: 'O:SNOW260807C00240000',
      underlying: 'SNOW',
      strikePrice: '240.00000000',
      expirationDate: '2026-08-07',
    });
    const { summary, allSummary } = compose(
      [row(), unquotedExpired],
      new Map([[TICKER, quote()]]),
    );
    expect(summary.excludedSymbols).toEqual([]);
    expect(allSummary.excludedSymbols).toEqual(['SNOW $240C']);
  });

  it('reports null all-lots totals when every lot is expired and unquoted', () => {
    const { summary, allSummary, expiredCount } = compose([expiredRow], new Map());
    expect(expiredCount).toBe(1);
    expect(summary.totalValue).toBeNull();
    expect(summary.excludedSymbols).toEqual([]);
    expect(allSummary.totalValue).toBeNull();
    expect(allSummary.excludedSymbols).toEqual(['AAPL $220C']);
  });
});

describe('aggregating two lots of ONE contract', () => {
  const twoLots = [
    row({ id: 'lot-1', quantity: '2', entryPrice: '3.50', fees: '1.02', tradeDate: '2026-08-03' }),
    row({ id: 'lot-2', quantity: '2', entryPrice: '6.00', fees: '2.04', tradeDate: '2026-08-11' }),
  ];

  it('becomes one item that names both purchases', () => {
    const { items } = compose(twoLots, new Map([[TICKER, quote()]]));
    expect(items).toHaveLength(1);
    expect(items[0].lotCount).toBe(2);
    expect(items[0].entryIsAverage).toBe(true);
    expect(items[0].lots.map((l) => l.id)).toEqual(['lot-1', 'lot-2']);
    // Combined size, and the average lies strictly between the two prices.
    expect(items[0].quantity).toBe('4');
    expect(items[0].entryPrice).toContain('4,75');
    // Costs are a SUM, and each lot keeps its own figures for the menu.
    expect(items[0].fees).toContain('3,06');
    expect(items[0].lots[0].entryPrice).toContain('3,50');
    expect(items[0].lots[1].entryPrice).toContain('6,00');
    expect(items[0].lots[0].tradeDate).toBe('2026-08-03');
  });

  it('derives break-even from the WEIGHTED average, both contract types', () => {
    const call = compose(twoLots, new Map([[TICKER, quote()]]));
    // 220 + 4.75 — not 220 + 3.50 and not 220 + 6.00.
    expect(call.items[0].breakEven).toContain('224,75');

    const put = compose(
      twoLots.map((r) => ({ ...r, contractType: 'put' as const })),
      new Map([[TICKER, quote()]]),
    );
    expect(put.items[0].breakEven).toContain('215,25');
  });

  it('recomputes valueRaw and plRaw for the AGGREGATE, never inheriting one lot', () => {
    const { items } = compose(twoLots, new Map([[TICKER, quote()]]));
    // value = 5 × 4 × 100 = 2000 — twice either lot's own 1000.
    expect(items[0].valueRaw).toBe('2000.00000000');
    // P/L = (300 − 1.02) + (−200 − 2.04) = 96.94, net of the summed costs.
    expect(items[0].plRaw).toBe('96.94000000');
  });

  it('leaves EVERY summary figure exactly where it was — merging never re-totals', () => {
    const merged = compose(twoLots, new Map([[TICKER, quote()]]));
    // The same two lots given DISTINCT tickers cannot merge; the totals over
    // them are the arithmetic the merge must not move.
    const OTHER = 'O:AAPL260904C00220001';
    const apart = compose(
      [twoLots[0], { ...twoLots[1], id: 'lot-2', ticker: OTHER }],
      new Map([
        [TICKER, quote()],
        [OTHER, quote({ ticker: OTHER })],
      ]),
    );
    expect(apart.items).toHaveLength(2);
    expect(merged.summary).toEqual(apart.summary);
    expect(merged.allSummary).toEqual(apart.allSummary);
    expect(merged.summaryNotes).toEqual(apart.summaryNotes);
    expect(merged.allSummaryNotes).toEqual(apart.allSummaryNotes);
    expect(merged.expiredCount).toBe(apart.expiredCount);
  });

  it('formats the average ONCE, at the end — the P/L keeps the unrounded figure', () => {
    // 1 @ 5.00 + 2 @ 5.01 → 5.006666…; the DISPLAYED entry is the 2-dp
    // '5,01 USD', but the P/L derives from the unrounded average:
    // (5 − 5.00666…) × 3 × 100 = −2 exactly. Rounding the average to 5.01
    // first would give −3 — a whole dollar of invented loss.
    const { items } = compose(
      [
        row({ id: 'a', quantity: '1', entryPrice: '5.00' }),
        row({ id: 'b', quantity: '2', entryPrice: '5.01' }),
      ],
      new Map([[TICKER, quote()]]),
    );
    expect(items[0].entryPrice).toContain('5,01');
    expect(items[0].plRaw).toBe('-2.00000000');
  });

  it('keeps the dashes when the shared ticker has no quote', () => {
    // The group key IS the ticker and quotes are keyed by ticker, so a
    // partially-quoted aggregate cannot exist: unquoted is all-or-nothing.
    const { items, summary } = compose(twoLots, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].hasQuote).toBe(false);
    expect(items[0].price).toBeNull();
    expect(items[0].pl).toBeNull();
    expect(items[0].day).toBeNull();
    expect(items[0].plRaw).toBeNull();
    expect(items[0].valueRaw).toBeNull();
    expect(items[0].plPct).toBe('—');
    // Named ONCE, not once per lot.
    expect(summary.excludedSymbols).toEqual(['AAPL $220C']);
  });

  it('shares one expiry, so `expired` can never be per-lot', () => {
    const past = twoLots.map((r) => ({ ...r, expirationDate: '2026-08-07' }));
    const { items, expiredCount } = compose(past, new Map([[TICKER, quote()]]));
    expect(items).toHaveLength(1);
    expect(items[0].expired).toBe(true);
    // One item ⇒ one expired contribution, not two.
    expect(expiredCount).toBe(1);
  });

  it('leaves a single-lot card in exactly the shape it has today', () => {
    const { items } = compose([row()], new Map([[TICKER, quote()]]));
    expect(items[0].lotCount).toBe(1);
    expect(items[0].entryIsAverage).toBe(false);
    expect(items[0].key).toBe(TICKER);
    expect(items[0].entryPrice).toContain('3,50');
    expect(items[0].plRaw).toBe('300.00000000');
  });
});

describe('the summary "Today" percent measures the SAME move as its amount', () => {
  /**
   * The bug this pins: while shut, the day pair runs between two recorded
   * evenings, but the summary's value uses the LIVE mark — which has decayed
   * a day of theta since. Reconstructing the denominator as `value − move`
   * therefore stopped giving the base, so the percent drifted away from the
   * amount printed beside it, and once the move exceeded the live value it
   * flipped sign against it: a green amount with a red percent.
   */
  const lot = row({ quantity: '1.00000000', entryPrice: '1.00000000', fees: '0.00000000' });

  function summaryFor(livePrice: string, baseMark: string, amt: string, pct: string) {
    const print: ResolvedPrint = {
      price: livePrice,
      source: 'model',
      lastTradeDateISO: '2026-08-14',
      day: { amt, pct },
      dayBasisMarkDateISO: '2026-08-13',
      dayBasisTipDateISO: '2026-08-14',
      dayBasisBaseMark: baseMark,
      noTradeThisSession: false,
      staleBeyondLookback: false,
    };
    return composeOptionsPayload(
      [lot],
      new Map([[TICKER, quote({ price: livePrice })]]),
      MARKET,
      NOW_MS,
      new Map([[TICKER, print]]),
    ).summary;
  }

  it('uses the pair’s own base, not the decayed live value', () => {
    // base 1.00 → tip 1.02 is +2,00%. The live mark has since decayed to 0.96,
    // and `value − move` would have made that read +2,13%.
    const summary = summaryFor('0.96', '1.00', '0.02', '2.00');
    expect(summary.dayChange?.text).toContain('2,00%');
  });

  it('never disagrees in SIGN with the amount beside it', () => {
    // The pathological shape: the move is larger than the live value, so the
    // old denominator went negative and `pctChange` flipped the sign — a gain
    // printed in green next to a red percentage.
    const summary = summaryFor('0.10', '0.50', '0.60', '120.00');
    const text = summary.dayChange?.text ?? '';
    expect(text.startsWith('+')).toBe(true);
    expect(text).not.toContain('(-');
    expect(text).not.toContain('(−');
    expect(summary.dayChange?.direction).toBe('gain');
  });
});

describe('total cost paid — Σ per lot of entry × quantity × multiplier + fees', () => {
  it('adds fees onto a single purchase', () => {
    // 3.50 × 2 × 100 + 2.04 = 702.04
    const { items } = compose(
      [row({ fees: '2.04000000' })],
      new Map([[TICKER, quote()]]),
    );
    expect(items[0].totalCost).toBe(fmtMoney(dec('702.04'), 'USD'));
  });

  it('equals premium × contracts × multiplier when the purchase has no fees', () => {
    // 3.50 × 2 × 100 = 700
    const { items } = compose([row()], new Map([[TICKER, quote()]]));
    expect(items[0].totalCost).toBe(fmtMoney(dec('700'), 'USD'));
  });

  it('sums each purchase on a two-lot card rather than averaging first', () => {
    // Per-lot: (3.50 × 2 × 100 + 1.02) + (6.00 × 2 × 100 + 2.04) = 1903.06.
    // Average × total would re-multiply a rounded quotient; this is the sum.
    const twoLots = [
      row({ id: 'lot-1', quantity: '2', entryPrice: '3.50', fees: '1.02', tradeDate: '2026-08-03' }),
      row({ id: 'lot-2', quantity: '2', entryPrice: '6.00', fees: '2.04', tradeDate: '2026-08-11' }),
    ];
    const { items } = compose(twoLots, new Map([[TICKER, quote()]]));
    expect(items[0].totalCost).toBe(fmtMoney(dec('1903.06'), 'USD'));
  });

  it('still emits the formatted string when there is no quote', () => {
    const { items } = compose([row()], new Map());
    expect(items[0].totalCost).toBe(fmtMoney(dec('700'), 'USD'));
    expect(items[0].totalCost).not.toBeNull();
  });
});
