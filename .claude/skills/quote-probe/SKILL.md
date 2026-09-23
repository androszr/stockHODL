---
name: quote-probe
description: Deterministic health check of the market-data pipeline for
  StockHODL — runs the Massive probe against the canary symbols (AAPL, SPY)
  plus the NBP FX endpoint, and reports key health, freshness, search, daily
  and intraday bars, and response-schema drift. Use when the user says
  /quote-probe, after any change to src/lib/market-data/, or when the phone is
  showing stale or missing prices.
---

# quote-probe

The market-data layer is the highest-risk dependency in this app
(`docs/context.md` § Market data) and it **breaks silently** — a vendor field
that changes shape or goes missing surfaces as a stale or absent price rendered
as if it were fine. This skill is the smoke alarm.

No agent spawn. All bash.

## Visual convention

This skill spawns nothing, so it gets a single opening banner instead of a
per-agent one. Before Phase 1, read `.claude/skills/quote-probe/banners/intro.txt`
and paste its full content as a fenced code block in your text response — **not**
via `cat`, because shell output collapses in the terminal scroll.

## Args

`/quote-probe [symbol ...]` — extra symbols to look up beyond the canaries
(Phase 1 profile mode, one run per symbol).

## Canaries

| Symbol | Why this one |
|---|---|
| `AAPL` | US, highest-liquidity — the control for snapshots, daily bars and 5-minute bars |
| `SPY` | The ETF the market strip uses in place of the S&P 500 index (indices are not entitled on this tier) |
| `USD/PLN` | NBP FX; the whole PLN aggregate is wrong without it |

## Phase 1: Massive, through the app's own adapter

Needs `STOCK_API` in `.env`. The probe is read-only against the vendor and
never prints the key.

```bash
pnpm probe:massive; echo "exit=$?"
```

It runs five checks, in order, and exits 0 only if every one succeeds
(nonzero with the failing call named):

1. **The key works** — `/v1/marketstatus/now` answers with a market state and a
   server time.
2. **Snapshots** — `getQuotes` for `AAPL` and `SPY`, with the raw snapshot
   field list and how old the price really is.
3. **Search** — `searchSymbols('nike')` returns results.
4. **Daily bars** — `getDailyCloses` for `AAPL` over the last five days, plus
   the raw previous-day bar as a baseline.
5. **Intraday bars** — `getAggregates` for `AAPL` at 5 minutes over the last
   five days (the 1D/5D chart path).

For each extra symbol from the args:

```bash
pnpm probe:massive profile <SYMBOL>
```

Report per check. A field listed in step 2 that the mapping in
`src/lib/market-data/massive-mapping.ts` reads and that is now absent or
renamed is **schema drift**: include the printed field list, because that is
the signal the vendor changed its contract.

## Phase 2: FX

```bash
curl -s "https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json" | head -c 400
```

Assert: HTTP 200, a `rates[0].mid` value, and an `effectiveDate` within the last
4 calendar days. NBP publishes on business days only, so a Monday probe
legitimately sees Friday's date — flag >4 days, not >1.

## Phase 3: freshness of the intraday path

Read step 5's output from Phase 1. Assert the newest 5-minute bar is from the
last completed or current US session, and that its age while the market is open
is about 15 minutes (the Starter tier's delay) rather than hours. A bar list
that stops at a previous session while the market is open is **DEGRADED** even
though the probe exited 0.

## Report

```
| Check | Symbol | Result | Detail |
|---|---|---|---|

VERDICT: HEALTHY | DEGRADED | BROKEN
```

- `HEALTHY` — every probe check passes, FX is current, intraday bars are
  fresh.
- `DEGRADED` — the probe exits 0 but a freshness or drift check fails. Say
  which, and what the phone will show as a result.
- `BROKEN` — the probe exits nonzero, or FX is unavailable.

When schema drift is detected, include the raw field list in the report. The
next step is almost always a one-file fix in `massive-mapping.ts`, and having
the actual shape in hand is most of that work.
