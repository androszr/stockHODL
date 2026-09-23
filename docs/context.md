<!-- BEGIN DARK ARMY PACK — managed, edits here are overwritten -->
# Project context — stock-follow

Ground truth for every agent in `.claude/agents/`. Read this first, before
exploring the tree. If something here contradicts the code, the code wins —
say so in your report rather than silently working around it.

Three sections here are read by machinery, not only by people, so keep their
shape: the **Identity** table (gates), the **Reviewers** table (which domain
reviewer fires on which paths) and the **Conventions** list (what the
preflight, the verifier and the reviewers enforce).

## Identity

| Field | Value |
|---|---|
| `src_dir` | `ios/` |
| Framework | <one line: what this is built with and where it runs> |
| Package manager | <e.g. pnpm 11 (Node 22) / Swift Package Manager / none> |
| `ios_build_gate` | `xcodebuild build -project ios/StockHODL.xcodeproj -scheme StockHODL -destination 'generic/platform=iOS Simulator' -quiet` |
| `ios_test_gate` | `xcodebuild test -project ios/StockHODL.xcodeproj -scheme StockHODL -destination 'platform=iOS Simulator,name=iPhone 16' -quiet` |
| `entitlements_gate` | `python3 scripts/check-entitlements.py` |
| `privacy_gate` | `python3 scripts/check-privacy-strings.py` |
| Plans | `plans/<YYYY-MM-DD>-<slug>.md` |
| Reference docs | <the docs a planner should read after this one> |

**Every gate must pass before any handoff.** Run them in the order listed —
the fast ones fail first. Agents read the commands from this table; none of
them hardcodes one.

## Reviewers

One row per domain reviewer. `/ship` Phase 6.8 greps the changed-file list
against each regex and spawns every reviewer that matches; `/review --deep`
hands the diff to the first one. The regex is a floor — a reviewer is also
spawned on judgment when the diff touches its domain through other files.

| Agent | Fires when a changed path matches |
|---|---|
| `sf-app-reviewer` | `ios/Config/|\.entitlements$|Info[A-Za-z-]*\.plist$|\.xcconfig$|Keychain|Push|Notification|Background|BGTask|ExportOptions|testflight\.yml|ios\.yml` |
| `sf-integration-reviewer` | `\.xcodeproj/|project\.yml$|Package\.(swift|resolved)$|\.github/workflows/|^scripts/|Migration|Schema|Codable|UserDefaults|SwiftData|CoreData` |
| `sf-security-reviewer` | `Keychain|Auth|Login|Token|Secret|Credential|URLSession|WebSocket|OpenURL|onOpenURL|DeepLink|UniversalLink|WKWebView|\.entitlements$|Info[A-Za-z-]*\.plist$` |

## Architecture

<Replace this section with the real thing: the entry chain, the data layer,
auth, the external services, the background work. Cite real paths and
symbols. Record decisions with their date and the plan that made them, and
record what was tried and reverted — that is the expensive half.>

## Conventions

The project's own non-negotiables. Each is enforced by a preflight check, a
verifier grep or a domain reviewer; a plan that breaks one is a plan that will
not pass. The planner reads these before writing, the implementer before
coding.

1. **No `Double` near money.** Amounts arrive as strings and go through one
   money module to `Decimal`. A `Double(` in the client is the same bug the
   web preflight greps for as `parseFloat`; the only sanctioned exception is
   chart geometry, in one named file. *(preflight BLOCK, verifier grep, CI)*
2. **Every reachable privacy gate is declared.** A camera, microphone,
   speech, photo or location API the app can reach has its
   `NS…UsageDescription` in **both** app Info.plists, with the same text.
   An undeclared gate does not deny — it terminates the process with no
   error. *(preflight BLOCK, guard script, CI)*
3. **No ATS exception in a shipping plist.** Cleartext localhost lives in the
   `-Debug` twin only. *(preflight BLOCK, CI)*
4. **Debug and Release entitlements match** except for `aps-environment`
   (`development` / `production`). A capability added to one and not the
   other ships a Release build quietly missing it. *(preflight BLOCK, guard
   script, CI)*
5. **Persisted shapes decode tolerantly.** A new key on anything stored in
   UserDefaults, the keychain, a file or a shared container has a default on
   read; synthesized `Decodable` throws on a missing key even with a default.
   *(preflight WARN, app reviewer)*
6. **Background work is registered.** A new `BGTaskScheduler` identifier is in
   `BGTaskSchedulerPermittedIdentifiers`; a background mode is in
   `UIBackgroundModes`. *(preflight BLOCK)*
7. **Clock times print both digits.** `.minute(.twoDigits)`, never
   `.minute()` — "10:0" beside money is a wrong number. *(verifier grep, CI)*
8. **Never commit or push** unless explicitly asked.


## What the tests cannot see

The suite is hermetic. Green proves nothing about these surfaces, which is why
the domain reviewers and the audit skill exist:

- **The distribution build.** Simulator tests run a Debug build with the
  development APNs entitlement and the Debug plist. Only the exported `.ipa`
  says which entitlements shipped — the TestFlight workflow reads them back
  from the archive for exactly this reason.
- **The device.** Push delivery, background refresh timing, the keyboard's
  dictation key, the home indicator, a real keychain group shared with an
  extension.
- **A privacy prompt.** The simulator surfaces a missing usage string as a
  crash with no message; nothing in a unit test opens the camera.
- **A file written by the previous build.** Tests decode fixtures the current
  code wrote; a user upgrades from last month's shape.
- **The extension boundary.** A widget reads the keychain through its own
  access group; a mismatch renders "sign in" beside a signed-in app with no
  error anywhere.


## Interview branches

`/ship` asks at most three questions from `.claude/skills/ship/templates/questions.md`.
Branches that the architecture above already settles should be answered from
this file rather than asked.
<!-- END DARK ARMY PACK -->

# Project context — StockHODL

Ground truth for every agent in `.claude/agents/`. Read this first, before
exploring the tree. If something here contradicts the code, the code wins —
say so in your report rather than silently working around it.

## Identity

| Field | Value |
|---|---|
| `src_dir` | `src/` |
| Framework | Next.js 16 API host + iOS Swift client. There is no web product UI. |
| Package manager | pnpm 11 (Node 22) |
| `lint_gate` | `pnpm lint` |
| `typecheck_gate` | `pnpm typecheck` |
| `test_gate` | `pnpm test` (Vitest) |
| `build_gate` | `pnpm build` |
| Plans | `plans/<YYYY-MM-DD>-<slug>.md` |
| Reference docs | `docs/ios-native.md`, `docs/setup.md`, `docs/adr-002-mascot-system.md` |

**All four gates must pass before any handoff.** Run them in that order — lint
and typecheck fail fastest.

## Architecture

### Entry chain

The product the user sees is the iPhone app. Next.js on Vercel is the API
host (`https://sawa-finance.vercel.app`). There is no website product: a
computer browser and a phone browser both get a blank not-found page.

`src/app/layout.tsx` is a minimal html/body shell. There is no `page.tsx`,
so `/` 404s through `src/app/not-found.tsx` (empty — no landing copy).

`src/proxy.ts` runs in front of everything (Next 16's renamed middleware)
and does an optimistic cookie check only. Unauthenticated HTML is a 404
empty body, not a redirect to a login page. Real validation lives on each
JSON door (`sessionUserId` / `auth.api.getSession`) — do not move a DB
round-trip into the proxy.

### Data layer

- Drizzle ORM over Neon HTTP. Schema: `src/lib/db/schema.ts`. Client: `src/lib/db/index.ts`.
- Migrations are generated (`pnpm db:generate`), never hand-edited, and committed under `drizzle/`.
- **All money and quantity columns are `numeric`**, which Drizzle returns as a
  `string`. That string goes straight into `decimal.js` via `dec()` in
  `src/lib/money.ts`. `parseFloat` / `Number()` on a price, quantity, fee or FX
  rate is a bug — the preflight greps for it.

### Auth

`src/lib/auth.ts` (server). Better Auth with the passkey plugin. **Passkey-only
on the phone** — there is no password and no TOTP in normal operation.

Two independent allowlist gates — a request hook and a database hook — both keyed
on `ALLOWED_EMAIL`, plus a "one user, ever" count check. Never weaken any of
them, and never add a standing second sign-in method without a security review.

Break-glass is `scripts/recover.ts`, a local CLI (no HTTP route by design). It
sets a credential password offline; `RECOVERY_MODE=1` then enables password
sign-in for as long as it takes to enroll a passkey from the iPhone (emergency
password on the sign-in screen, then Settings → Passkeys → Add). At
`RECOVERY_MODE=0` the password path is disabled entirely. `RECOVERY_MODE` is
read at build time, so flipping it requires a redeploy — that is intentional
friction. There is no public probe for it. When recovery is off, the phone's
emergency control is still reachable and Better Auth refuses; the phone shows
the same generic "Could not sign in. Try again." sentence.

**Hardening decisions (from the retired MVP plan §5).** The threat model is
internet-exposed personal financial data; the attackers worth designing for
are bots and credential-stuffers, not a targeted adversary. So the goal is no
shared secret to steal and exactly one identity that can ever sign in:
passkey-only with no standing password (a passkey is already two factors, and
a password is the one credential that can be phished, stuffed or reused); the
break-glass CLI above rather than any HTTP recovery route, so recovery has no
surface for a scanner to find; the header set in `next.config.ts` — a tight
CSP with `frame-ancestors 'none'` (no third-party origin is needed because
all market data is server-mediated), `Strict-Transport-Security` (two years,
preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, a minimal
`Permissions-Policy` and `X-DNS-Prefetch-Control: off`; Better Auth's rate
limiter on the auth routes, in-memory per serverless instance (the planned
Upstash-backed store was never adopted, so a recycled instance starts its
window afresh); and secrets only in the Vercel project env and GitHub Actions
secrets, never in the repository or a client bundle (`server-only` on every
module that reads them). Scheduled jobs under `/api/cron/*` authenticate with
`CRON_SECRET` through one shared gate, `cronGate` in `src/lib/api/cron/gate.ts`
(503 when the secret is unset, 401 on a mismatched bearer, compared as
SHA-256 digests under `timingSafeEqual`); `routes-use-gate.test.ts` fails if a
cron route stops using it.

### Market data (M3+)

**Massive is the provider** (`https://api.massive.com`, Starter tier: unlimited
REST, **15-minute-delayed data**), authenticated with the `STOCK_API` key from
the server env. US markets only, end to end. The 2026-08-09 plan
(`plans/2026-08-09-massive-market-data.md`) superseded the original
Yahoo-primary/Stooq-fallback design (2026-08-09).

Everything is server-mediated. **The phone must never fetch any
market-data vendor directly** — it would leak the key and the
polling pattern and bypass the shared cache. The only contract is
`QuoteProvider` in `src/lib/market-data/provider.ts`; add providers behind it,
never inline. Exactly two files (both `server-only`) know a vendor URL or read
`STOCK_API`: `src/lib/market-data/massive.ts` (REST) and
`src/lib/market-data/massive-stream.ts` (the delayed WebSocket behind
`streamPrices()` — channel `A` only; `T`/`Q` and the real-time socket are not
entitled). The pure payload mapping — including the one sanctioned
JSON-number→`dec()`→decimal-string money crossing, for REST payloads and
streamed ticks alike — lives in `massive-mapping.ts`.

**The coherent triple** (decision of 2026-08-10,
plans/2026-08-10-live-quote-stream.md): the displayed price, day change and
day percent are always three views of one number. The headline price is
status-aware (`session.price` while open; the official `session.close`
otherwise — Yahoo's behavior), and the day pair DERIVES from that headline
against `previous_close` via `deriveDayPair()` — atomically, both figures or
neither. The vendor's `regular_trading_*` pair is schema-only and no longer
displayed. The extended-hours line (2026-08-13,
plans/2026-08-13-extended-hours-last-reading.md — the user reversed the
2026-08-10 only-while-running rule for Yahoo parity): live during
`early_trading`/`late_trading`, hidden during the regular session (the day
figure already contains the pre-market move), and while unambiguously `closed`
it persists the **last completed extended session**'s reading; `unknown` (any
unrecognised vendor status — possibly a live half-day session)
renders no extended line at all
(2026-08-14 fix: attributing it as closed double-counted the pre-market move
beside the day figure). The extended pair is SELF-DERIVED, `session.close` →
`session.price`, in BOTH the live and closed branches (2026-08-14 decision,
plans/2026-08-14-extended-pair-self-derived.md — observed live that
`early_trading_change` is measured from `previous_close`, the close TWO
sessions back, double-counting the day move the day figure already shows,
while the late twin was observed CORRECT on another ticker the same day. Only
the early field was caught wrong; the late one is distrusted by inference, not
by evidence — one field measuring from a base the other does not is reason
enough to stop reading either. All four vendor extended fields are now
schema-only like `regular_trading_*`). The persisted reading is attributed by
pure clock math (`extendedAttribution` in `market-clock.ts`; the vendor keeps
both pairs side by side with no per-figure timestamp, and the snapshot-wide
`last_updated` is banned as a proxy instant); while closed the line renders
iff the attribution resolves AND both `session.close` and `session.price` are
present — an older session's figure still can never be relabelled, now by
construction: the tip is the most recent trade and can never predate the
base, so the derived span only covers time after the official close (or a
genuinely flat 0.00%). The line is labelled with the session name and that
session's derived end instant (epoch ms to the client, formatted
device-local pl-PL by the shared `ExtendedMove` renderer; no honest instant →
session name with no time), and with no staleness bound — the timestamp label
is what keeps it honest. An ended reading carries its liveness as its own fact
(`extendedLive`, 2026-08-14 — never inferred from the instant's absence) and
renders the whole line muted with an sr-only "(closed session)" note;
direction survives in the `fmtPct` sign.

Symbol search is Massive-first: `/api/mobile/v1/symbols/search` asks the provider, and
consults the local `symbol_directory` table (daily Nasdaq Trader refresh) when
Massive is degraded, returns nothing, or — for short queries — returned no
exact-ticker hit (the vendor's bounded result window can lose an exact ticker
to alphabetically earlier name matches; both sources then merge through the
shared ranker). `degraded: true` in the response means both sources came up
empty after a provider failure. Both sources emit provider ticker notation —
class shares use dots (`BRK.A`), never the Nasdaq file's slashes.

**Delay disclosure is contract data, not a UI obligation** (decision of
2026-08-10, plans/2026-08-10-holdings-live-market-view.md — reversing the
2026-08-09 rule): `Quote.asOf`, `Quote.asOfSource` and `Quote.delaySeconds`
remain required contract fields, but the UI renders no delay label beside
prices. The `'fetch'`-timestamp honesty rule survives unchanged: when
`asOfSource` is `'fetch'` the payload carried no vendor timestamp and `asOf`
is merely the fetch time — an age or freshness display must never present it
as a trade time. `pnpm probe:massive` is the local health check that shows
real freshness.

**History and charts (M5, 2026-08-11,
plans/2026-08-11-holdings-charts-and-ticker-page.md):**
`QuoteProvider.getAggregates(symbol, spec)` serves bars at any granularity —
daily history and the 5/30-minute intraday bars behind the 1D/5D chart
ranges; `getDailyCloses` survives as a thin alias over the same fetch path.
Daily closes are cached permanently in `price_snapshots` with
`price_history_coverage` recording the span already asked about per
instrument (a missing row is otherwise ambiguous: non-trading day vs never
asked — and a non-US instrument's history will NEVER arrive, so an empty
provider answer still extends coverage). Coverage NEVER reaches past the
last COMPLETED NYSE session (fix of 2026-08-11): today's close does not
exist until the bell, and recording a still-running day as covered would
permanently skip fetching it. `src/lib/history/price-history.ts` is the only
writer of both tables; `/api/cron/refresh-history` (23:30 UTC weekdays)
tops the cache up nightly after the US close; the retired backfill CLI was
removed 2026-09-23; the nightly cron and the on-demand series path are the
only writers. Intraday bars are deliberately NOT stored
(delayed, still-appending data) — a 60 s in-process cache in `massive.ts` is
the whole intraday caching story. The portfolio value series is computed on
the fly from those immutable inputs (`src/lib/history/portfolio-series.ts`,
no materialized value-snapshot table — a backdated transaction edit would
otherwise invalidate the whole tail), with `MAX_BACKFILL_SYMBOLS` /
`MAX_INTRADAY_SYMBOLS` bounding provider fan-out and `excludedSymbols` /
`partialDays` keeping unpriceable instruments named rather than silently
zeroed.

The vendor's market-status endpoints (current status + the upcoming
holiday/early-close calendar) live behind `QuoteProvider.getMarketStatus()`,
composed with the pure NYSE session math in `market-clock.ts` — the vendor's
live status is authoritative, the derived calendar is the fallback and all of
the transition math. The upcoming feed is FUTURE-only (a closure date drops
out the moment it passes), so advertised rows are persisted
(`market_calendar` + `market_calendar_coverage`; `calendar-store.ts` is the
only writer, `calendar-merge.ts` the pure merge) and RETAINED after their
dates pass — the backward scans (`extendedAttribution`,
`lastCompletedSessionDateISO`) see real past closures. Sessions attributed to
dates before the store's set-once `known_from` horizon render with no
timestamp — never a weekday-schedule guess — and any storage failure degrades
to vendor-only rows with a null horizon; quotes never break on the calendar.
`/api/mobile/v1/live` is the session-guarded polled JSON endpoint; its symbol
set always comes from the caller's own DB rows, never from query parameters.
`/api/mobile/v1/live/stream` (approved SSE exception, 2026-08-10 — like the
logo route) is the primary live path: same session guard, same
no-query-parameters rule, a fresh REST baseline on every (re)connect, a
bounded lifetime under Vercel's function cap, and no vendor socket at all
while the market is fully closed.

### FX rates (NBP)

The transaction form's "FX rate to PLN" field auto-fills with the **NBP Table
A mid rate from the last business day strictly before the trade date** — the
D-1 rule of art. 11a PIT/CIT, chosen deliberately. The field stays
manual-overridable, and a typed value always wins over an in-flight lookup.

`src/lib/fx/nbp.ts` (`server-only`) is the only file that knows `api.nbp.pl`;
the pure date math, response schema and the JSON-number→`dec()`→decimal-string
money boundary live in `nbp-mapping.ts` (isomorphic, unit-tested, no network).
NBP is deliberately NOT behind `QuoteProvider` — that contract is equity
quotes/candles/symbol search; the server-mediation rule is honoured the same
way instead: the phone never contacts NBP, and the client↔server
crossing is `/api/mobile/v1/fx-rate`.

Published NBP rates are immutable, so `fx_rates` is a permanent read-through
cache keyed by NBP's own `effectiveDate` — never the trade date (multiple
trade dates legitimately resolve to the same rate row). Lookup failures
(`no_rate` / `not_published` / `unavailable`) are surfaced honestly in the UI
and never persisted. PLN short-circuits to a fixed rate of `1` with no lookup.

For chart series, `getFxRatesForRange(currency, from, to)` extends the same
read-through pattern to inclusive date ranges (NBP's range endpoint, split
into ≤360-day chunks under the API's 367-day cap) and densifies the result
with carry-forward: every calendar day inherits the newest rate published on
or before it — the D-1 semantics applied to a series. Weekday cache holes are
ambiguous (Polish holiday vs never fetched), so a hole triggers at most one
re-ask per chunk per 12 h per instance.

### Deployment

**Pushing to `main` IS the deploy.** `.github/workflows/deploy.yml` fires on
every push to `main` (and on PRs, which get an isolated Neon branch DB plus a
Vercel preview URL). Verify a deploy with `gh run list --limit 4` — expect both
`CI` and `Deploy` green — and give it ~1m45s before concluding anything.

**Never run `vercel --prod` locally.** It fails: the Vercel project's Root
Directory setting is the literal `.`, which Vercel's validator rejects. The
workflow is unaffected because it goes through
`vercel pull && vercel build && vercel deploy --prebuilt`.

There is **no Vercel-native Git integration**, so the Vercel dashboard lists
deployments by *username* rather than by commit. That looks like nothing is
wired up. It is — the workflow deploys with `VERCEL_TOKEN`, so Vercel attributes
the deploy to the token owner. Do not "fix" this by connecting the repo in the
dashboard without asking; it would create a second, competing deploy path.
Likewise, `vercel ls` read immediately after a push is stale by definition.

Secrets live in two non-interchangeable places:

| Where | What | Used by |
|---|---|---|
| Vercel project env | `STOCK_API`, `DATABASE_URL`, `BETTER_AUTH_*`, `ALLOWED_EMAIL`, `CRON_SECRET` | the app at build + runtime |
| GitHub repo secrets | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `NEON_API_KEY`, `DATABASE_URL` | the deploy workflow |

`ci.yml` needs no secrets — it uses hardcoded placeholders. **Any new required
field in the `src/lib/env.ts` zod schema must be mirrored into that placeholder
block**, or CI fails at the build step. Remember the schema is validated at
*build* time (`RECOVERY_MODE` is compiled into the auth config), so a missing
required var fails the build outright rather than degrading at runtime.

Production is `https://sawa-finance.vercel.app`. Raw
`finance-<hash>-sawa12.vercel.app` URLs 302 to Vercel SSO — that is deployment
protection, not a broken deploy.

### Design system

There is no web product UI. The iPhone app is the only human surface.

**No hardcoded colors.** `src/styles/tokens.css` is the only file allowed to
contain a color literal. `pnpm tokens:gen` writes
`ios/StockHODLShared/Generated/Tokens.swift` from it. Gain/loss direction
comes from `directionOf()` in `src/lib/money.ts` (and the Swift port in
`Money.swift`), never from an inline ternary on a raw hex.

The sanctioned money→float crossings are on the phone only, geometry never
formatted or fed back into arithmetic: `ios/StockHODL/Charts/PlotPoints.swift`
in the app (allowlisted by name in the CI Double-initialiser grep) and
`ios/StockHODLShared/Widgets/WidgetPlotPoints.swift` in the widget (strict
pattern → `Decimal` → `NSDecimalNumber.doubleValue`, invisible to the grep by
construction — decision of 2026-09-23,
plans/2026-09-23-release-review-fixes.md). The server has no float crossing
since the web renderer left; labels format the decimal string carried
alongside each point.

Extended hours are tagged on both 1D series — the instrument chart and the
portfolio value chart (2026-08-14). The vendor's
intraday bars already span 04:00–20:00 ET but carry no session label, so the
label is derived server-side — `regularSessionFor()` (the same NYSE calendar
the live header uses) gives the day's real open/close, and
`tagSessionPhases()` in `src/lib/charts/session-phase.ts` marks each bar
outside them with an optional `p: 'pre' | 'post'` on `ChartPoint` (absent =
regular, so every daily range and the 5D payload serialize unchanged).
The iPhone client turns those tags into bands (`PlotPoints.spans`).
Scope is deliberate: 1D only (5D would be stripes); the instrument chart
tags USD listings only (a non-US listing shaded by New York hours would be
false); the portfolio chart tags unconditionally (user decision 2026-08-14 —
the provider serves intraday bars for US symbols only, so only US listings
can contribute to the intraday line; with a mixed portfolio the bands
describe NYSE hours); and the phase is named in the tooltip and a caption —
shading alone is not a label.

### Offline layer

The website's Serwist worker is gone with the website. Offline behaviour that
is current architecture lives on the iPhone: `Reachability`, `StaleState`,
`Backoff`, `DiskCache`, and the App Group snapshot the widgets read. See the
native offline chapter below.

**Not offline:** mutations. Writes stay online-only — no queued writes and no
on-device mirror of the DB.

### Responsive rule

There is no web product UI on a phone browser or a computer browser. Do not
invent a web shell. The only human surface is the iPhone app, and a UI
change must work on every iPhone size the app already supports.

## Conventions

- The JSON surface is `/api/auth/*`, `/api/mobile/v1/*`, `/api/cron/*`, plus
  the Associated Domains file at `/.well-known/apple-app-site-association`.
  Web cookie twins (`/api/quotes*`, `/api/logo`, `/api/news`, `/api/symbols`)
  and Server Actions are gone. Do not add a REST layer outside `/api/mobile/v1`
  without a plan. Chart series, FX, mutations and live quotes all go through
  that versioned path, calling the SAME `src/lib/**` functions a handler must
  not reimplement. Two
  sanctioned non-JSON routes exist under the mobile prefix: `/api/mobile/v1/logo/[symbol]`,
  a session-guarded image proxy that streams the vendor's brand
  icon so the API key never reaches the phone; and `/api/mobile/v1/live/stream`
  (approved SSE exception, 2026-08-10), the session-guarded live-quote stream
  that holds the vendor WebSocket server-side for the same reason.
  `/api/mobile/v1/watchlist/quotes` and its `/stream` (2026-08-14) are
  their Watchlist twins under the same rules — same session guard, same
  no-query-parameters rule, symbol set only ever from the caller's own
  `watchlist` rows (`src/lib/watchlist/live-view.ts`), sharing the extracted
  SSE lifecycle (`src/lib/holdings/stream-response.ts`). Deliberately a
  PARALLEL delivery: watched symbols never enter `loadHoldingsInputs`, so the
  Holdings/Dashboard payload, vendor batch and socket subscription are
  untouched by watching a stock.
- **`/api/mobile/v1/*` — the phone's JSON API** (2026-08-17, docs/ios-native.md
  stage S1). The native iOS client (SwiftUI) is not deployed with the server.
  The phone is the only client; there is no web product UI.

  The rules that keep the surface from spreading:

  - **No new logic in a handler.** A handler is three lines: session guard
    (`sessionUserId` in `src/lib/api/mobile/session.ts` — 401 without a
    session, `private, no-store` on every answer), `safeParse` with a contract
    schema, then a call to the SAME `src/lib/**` function. Logic lives in
    `src/lib/transactions/mutations.ts`, `src/lib/portfolios/mutations.ts`,
    `src/lib/watchlist/mutations.ts`, `src/lib/history/user-series.ts` and
    their siblings. Ownership checks, the instrument lock, the writes and
    the memo invalidation live in those shared modules. (The web-page
    `revalidatePath` calls were removed on 2026-09-23; there is no page to
    revalidate.)
  - **Contracts are zod, in `src/lib/api/contracts/`** — isomorphic (no
    `server-only`, no db, no env), used at runtime by the handlers, and the
    source the Swift `Codable` structs are generated from (stage C0:
    `z.toJSONSchema()` → quicktype → `ios/StockHODLShared/Generated/`, with CI
    regenerating and running `git diff --exit-code`). Input schemas are
    IMPORTED from `src/lib/validation.ts` rather than restated —
    `transactionInputSchema` and `watchlistAddSchema` serve both clients, so a
    bound that changes changes once. `live-payload-contract.test.ts` runs the
    real `composeLivePayload` through `livePayloadSchema` to catch drift in
    both directions.
  - **Money stays a decimal string** on the wire in both directions; there is
    no number type for an amount anywhere in the contracts, so the codegen
    cannot emit a `Double` for one.
  - **Market data stays server-mediated**, NBP included: `/api/mobile/v1/fx-rate`
    is the phone's only route to a rate, and it never learns `api.nbp.pl`
    exists.
  - **Refusal shapes are deliberate, not incidental.** A series answers an
    unknown instrument with the EMPTY PAYLOAD (a 404 would enumerate the global
    `instruments` table one request at a time); `/api/mobile/v1/instrument/[symbol]`
    answers 404 only for a ticker the vendor directory has never heard of —
    since browsing (below) that is no longer an ownership refusal; a stale
    portfolio scope degrades to the all-portfolios series exactly as on the web.
  - **Versioned by path.** A breaking change goes to `contracts/v2/` and a new
    path segment; v1 lives as long as a TestFlight build that speaks it is
    still installed.

  Routes: `bootstrap` (one cold-start call — portfolios, static holdings,
  scopes, watchlist, live payload), `transactions` (+`/[id]`), `portfolios`
  (+`/[id]`, `/reorder`), `watchlist` (+`/[instrumentId]`), `fx-rate`,
  `series/portfolio`, `series/price/[symbol]`, `instrument/[symbol]`,
  `live` and `live/stream`, plus logo, news, options, passkeys, widget.

  **How the phone authenticates (stage S2, 2026-08-17).** Three changes,
  which only make sense read together:

  1. `bearer({ requireSignature: true })` in `src/lib/auth.ts`. The native
     client holds its session as a token in the Keychain rather than as a
     `__Host-` cookie hidden inside `HTTPCookieStorage`, and sends it as
     `Authorization: Bearer …`; `auth.api.getSession` resolves it through the
     same call that reads a cookie, so `sessionUserId` needed no branch.
     `requireSignature` is NOT the default and matters: without it the raw
     `session.token` column value would authenticate on its own. The signed
     form the client stores is the `set-auth-token` header the plugin already
     emits on sign-in. A browser never sends `Authorization`.
  2. The `src/proxy.ts` matcher excludes `api/auth`, `api/cron`, `api/mobile/`
     and `/.well-known/apple-app-site-association`. A cookie gate would 404 a
     Bearer call and Apple's unauthenticated fetcher. (A `/sw.js` exclusion
     for the leftover-PWA kill-switch worker existed until 2026-09-23 and was
     removed with the worker.) This is what finally makes each
     handler's own 401 branch reachable; that branch was always the
     authoritative check, the proxy was only ever an optimistic one.
     Unauthenticated HTML is a 404 empty body, not a redirect.
  3. Because writes are no longer behind the cookie gate, `isCrossSiteWrite`
     (`src/lib/api/mobile/respond.ts`) refuses any unsafe method that is
     cookie-authenticated and does not name this exact origin. `sameSite:
     'lax'` already covered this; the explicit check is the second lock, and
     it exempts bearer requests because a browser never attaches that header
     by itself. Reads are exempt — they mutate nothing.

  `/.well-known/apple-app-site-association` publishes `webcredentials.apps`
  from the optional `APPLE_APP_ID` env var (`<TeamID>.<bundle id>`) and 404s
  while it is unset, which is the truth before Apple enrollment completes. No
  `applinks`: a dev build must not claim the web app's URLs.

  `passkey({ origin })` stays at the web origin, and stage C1 CONFIRMED that
  against a real on-device assertion: a native client with verified Associated
  Domains reports exactly `https://sawa-finance.vercel.app`, so the single
  origin is correct and no array is needed. Had it differed, the fix would have
  been an array of origins, never a looser `rpID`.

  **The `ios/` tree (stage C0, 2026-08-17).** A SwiftUI client lives in the
  same repo, at `ios/`, with a committed `StockHODL.xcodeproj`. The root gets
  nothing new: no `Package.swift`, no CocoaPods, no XcodeGen. Sources are
  Xcode 16 **synchronized folder references**, so adding a Swift file does not
  touch `project.pbxproj` — which is what makes committing the pbxproj by hand
  tolerable for one developer.

  Two things in `ios/` are GENERATED and committed, so the Xcode build never
  needs Node:

  - `ios/StockHODLShared/Generated/Contracts.swift` — `pnpm contracts:gen` walks the
    exports of `src/lib/api/contracts/`, converts them through a zod REGISTRY
    in one pass (`z.toJSONSchema`) so shared shapes become `$ref`s rather than
    duplicated structs, and runs quicktype over the result. Response shapes
    only: a response that drifts fails silently on the phone, a request that
    drifts gets a 400 naming the field.
  - `ios/StockHODLShared/Generated/Tokens.swift` — `pnpm tokens:gen` reads
    `src/styles/tokens.css`. Non-negotiable #2 is why this is generated rather
    than typed: a second renderer hand-copying thirty OKLCH triples breaks
    "tokens.css is the only file with a color literal" on day one. The values
    stay OKLCH and convert at runtime in `ios/StockHODLShared/Design/OKLCH.swift` —
    three tokens sit outside sRGB and inside Display P3, so pre-flattening
    would visibly dull them against the browser on the same phone.

  `pnpm ios:gen` runs both. The `contracts` job in `ci.yml` reruns them and
  fails on `git diff --exit-code` — that check IS the anti-drift mechanism, and
  it runs on ubuntu because the codegen is Node. The same job greps the client
  for `Double(`: non-negotiable #1 ported, with `Charts/PlotPoints.swift` the
  one allowlisted exception when Swift Charts arrives in C3.

  **Three targets, two source folders.** `ios/StockHODL/` is the app;
  `ios/StockHODLWidgets/` is the WidgetKit extension; `ios/StockHODLShared/` is
  the Foundation-and-tokens core that BOTH compile — the generated contracts
  and tokens, `APIClient`/`AppConfig`, the token stores, the App Group snapshot
  and widget cache, `PollPolicy` and the OKLCH→SwiftUI bridge. The split is not
  taste: an app extension cannot compile the app's screens (half of UIKit is
  unavailable to one), so the shared half had to become its own synchronized
  group rather than a second membership on `ios/StockHODL/`. Tests still reach
  everything through `@testable import StockHODL`, because the shared group is
  a member of the app target too.

  **Widgets (2026-08-18, plans/2026-08-18-ios-widgets.md).** Two Home Screen
  tiles — Holdings (PLN) and Options (USD) — plus one lock-screen accessory
  showing both. They read `GET /api/mobile/v1/widget`, a projection of the same
  `getHoldingsView` / `composeLiveOptionsPayload` the big routes use, about four
  hundred bytes wide: a widget runs on a metered refresh budget and would
  otherwise pay for every holding and a full greeks load to render two numbers.
  Every figure is a server-formatted string, `dayChangePct`/`totalChangePct`
  included — the percent halves exist as their own fields precisely so a
  renderer with no room for the amount never splits `"+123,45 zł (+0,84%)"` on
  a bracket. The reload cadence follows the session
  (`WidgetReloadPolicy`): fifteen minutes while a session runs, otherwise the
  `pollingResumesAtMs` the payload names, floored at five minutes and capped at
  a day. A failed refresh repaints the App Group cache with its age; a 401 does
  not, because cached money beside a dead session is the one lie a widget can
  tell. The session token lives in a shared keychain access group
  (`KEYCHAIN_ACCESS_GROUP` in `Base.xcconfig`, referenced by every entitlements
  and Info plist), and `MigratingTokenStore` moves the pre-widget item into it
  so the update does not sign existing installs out.

  `ci.yml` and `deploy.yml` carry `paths-ignore: ['ios/**']`, and ESLint
  ignores `ios/**` explicitly. The contracts and tokens live under `src/`
  precisely so that changing one cannot be filtered out of web CI.

  `ios/StockHODL/Money/Money.swift` mirrors `src/lib/money.ts`, and
  `ios/StockHODLTests/MoneyTests.swift` ports its test cases one for one — a
  divergence there is a bug on one side, not a platform difference. The
  formatters are hand-rolled rather than `Decimal.FormatStyle`, because Polish
  CLDR's `minimumGroupingDigits: 2` leaves four-digit values ungrouped and
  Foundation has no equivalent of Intl's `useGrouping: 'always'` to switch it
  off.

  **Native sign-in (stage C1, 2026-08-17).** The phone signs in with a passkey
  — same `rpID` as the Better Auth plugin, so the credential is the one in
  iCloud Keychain. Enrollment is on the phone too: Settings → Passkeys → Add
  a passkey, against the plugin's generate-register-options /
  verify-registration endpoints. Emergency password is a tucked-away control
  on the sign-in screen for `RECOVERY_MODE=1`; there is no public probe.

  The ceremony is three calls in `ios/StockHODL/Auth/AuthClient.swift`:
  `GET /api/auth/passkey/generate-authenticate-options`, the system sheet, then
  `POST /api/auth/passkey/verify-authentication`. Two things about it are easy
  to get wrong and are pinned by tests:

  - **the challenge is cookie-bound.** The plugin stores it server side under a
    random token and returns that token in a signed cookie; verify reads the
    cookie back. So the client forwards the cookies from call one into call two
    by hand. That is the ONLY cookie this client touches — `URLSession` is
    configured with no cookie storage at all, because a session cookie hiding in
    `HTTPCookieStorage` is state the app cannot clear on sign-out.
  - **every field is base64url, not base64.** The server finds the passkey by
    string equality on `id`, so the wrong alphabet surfaces as "passkey not
    found", which points at the wrong problem entirely.

  The session token is the SIGNED value from the `set-auth-token` response
  header (`bearer({ requireSignature: true })` — the raw `session.token` is
  rejected), stored in the Keychain at `kSecAttrAccessibleAfterFirstUnlock`. The
  header only leaves the server for a caller that declared itself native, so
  `APIClient` sends `x-stockhodl-client: ios` on EVERY request including the two
  above — before any session exists. A 200 from verify with no token is
  therefore a distinct, diagnosable failure and not a generic one.

  Sign-out revokes server side and purges the Keychain **whether the revoke
  succeeded or not**: a tap on a flaky connection must not leave a live
  seven-day token on the device. Launch does the reverse check — a stored token
  is verified against `get-session` rather than trusted, but an unreachable
  server keeps the token instead of throwing it away.

  Build configuration moved into `ios/Config/` (xcconfig + two Info.plists +
  entitlements), a plain group rather than a synchronized folder so the
  entitlements do not get copied into the app bundle as a resource. `API_BASE_URL`
  is per configuration and read from the bundle, so there is no URL literal in
  Swift. The cleartext-localhost ATS exception exists ONLY in
  `Config/Info-Debug.plist`; `ci.yml` fails if it ever appears in the shipping
  one.

  All of it now runs on hardware. `APPLE_APP_ID` is set in production, the AASA
  route answers `200`, the device is registered, and a browser-minted passkey
  has signed a challenge on the phone.

  One trap that cost the first attempt: `API_BASE_URL` for Debug used to be
  `http://localhost:3000` unconditionally. On the simulator that is right — it
  shares the Mac's network stack — but on a phone `localhost` IS the phone, and
  every call died in transport before the system sheet opened, surfacing as the
  same generic "Could not sign in" as a rejected credential. Debug is now
  SDK-conditional: `API_BASE_URL[sdk=iphoneos*]` points at production. The Mac's
  LAN address is NOT an alternative — `rpID` derives from that host and there is
  no AASA file at `192.168.x.x`, so a device Debug build must talk to
  production. A `#if DEBUG` line logs the underlying error so the next failure
  is not opaque.

  **Native Holdings (stage C2, 2026-08-18).** The phone's first real screen.
  `ios/StockHODL/Live/` holds the data layer and `Holdings/` the views; the
  scaffold from C0 is gone.

  Two server routes were added, and the reason is worth keeping: the plan had
  assumed the phone would reuse `/api/quotes` and `/api/quotes/stream`. It
  cannot. `src/proxy.ts` is a COOKIE gate — unauthenticated HTML is a 404
  empty body, not a 307 to `/login`. The matcher excludes `api/auth`,
  `api/cron`, `api/mobile/` and the Associated Domains file. A bearer-only client hitting
  a cookie-gated path gets that empty 404 where it expected JSON — which
  surfaces as a decode error, not as an auth failure, and is therefore
  maximally confusing. Rather than widen the proxy's exclusion list,
  `/api/mobile/v1/live` and `/api/mobile/v1/live/stream` mirror them through
  `sessionUserId`. Both are thin: they call the same
  `getHoldingsView` / `loadHoldingsInputs` + `composeLivePayload` +
  `quoteStreamResponse`, so there is one live payload in this codebase, not a
  web one and a mobile one. The watchlist screen will need the same twin.

  On the client: `/bootstrap` and `/live` are fetched CONCURRENTLY (`async let`)
  because neither needs the other and a cold Vercel function would otherwise be
  paid for twice. `PollPolicy.swift` is a port of `poll-policy.ts`, including
  the distinction that motivates that module — structural emptiness (nothing
  the vendor can price) silences the cadence, a transient all-null payload does
  not. The client consumes the server's `hasPollableSymbols` verdict rather than
  re-deriving it from prices.

  `LiveStore` runs ONE pump: SSE while the market is live, falling back to the
  10 s REST cadence when the server says `fallback`, and stopping entirely on
  `idle` or a closed market — zero requests, which is the point. A clean end of
  stream is NOT an error: Vercel caps the function, so ending is ordinary and
  means reconnect. `scenePhase` tears the pump down on `.background` and, on
  `.active`, takes a fresh REST baseline BEFORE reconnecting, since the stream
  only carries changes from the moment it opens.

  The last payload is written to the App Group container (`Live/SnapshotStore`),
  which is why that entitlement was claimed in C1 — a widget can read it, the
  app's own sandbox it could not. Cold launch paints from it immediately.
  Sign-out purges the snapshot as well as the token.

  **The native offline layer (2026-08-22).** Four pieces in
  `StockHODLShared/Networking/`, and one in `StockHODLShared/Storage/`.

  `Reachability` wraps `NWPathMonitor` as one process-wide `@Observable`. It is
  a HINT, not a verdict — captive-portal Wi-Fi reports `.satisfied` — so the
  failure counting stays. What it adds is the two things counting could never
  do: an immediate, correct "no route" instead of two 20-second timeouts, and
  an EDGE to reload on. Nothing was listening for that edge before, so a phone
  regaining signal showed stale prices until the user backgrounded the app or
  pulled to refresh. `SignedInView` fans it out beside `scenePhase`, through
  the same `hasStarted` gate.

  `StaleState` is the freshness bookkeeping `LiveStore`, `WatchlistStore` and
  `OptionsStore` each carried a private copy of. It answers `Freshness`:
  `fresh`, `stale(since:)`, `disconnected(since:)`. Two consecutive failures
  still make a verdict over a healthy-looking network; a known-disconnected
  radio needs no second opinion and is stale at once. `isConfirmed` is the flag
  that fixed the cold-launch lie — a snapshot read from disk used to be
  indistinguishable from a fresh fetch, so a launch in a tunnel painted
  yesterday's money undisclosed until two requests had timed out.

  `Backoff` widens a failing pump from its normal cadence to a 60 s ceiling and
  idles at a flat 30 s while there is no route. `LiveStore.poll()` used to fire
  every 10 s regardless, each request holding the radio for the full timeout.

  `StaleLabel` is where the bar's sentence is decided, so it can be tested:
  `Data from 17:02` today, `yesterday 17:02`, `Wed 17:02` inside the week, a
  date past that, and a warning weight past three days. A bare time is only
  unambiguous on the day it was taken. `StaleBar` and `LoadFailureView`
  (`Design/StaleBar.swift`) are the two views, replacing six copies of a
  `Try again` VStack and two differently-worded staleness strips.

  `DiskCache<Value>` gives every remaining screen what Holdings already had.
  Caches directory, not the App Group container: these are re-fetchable by
  definition and the container is for the one payload a WIDGET reads. Keyed by
  `ContractsVersion.current` — a fingerprint of `Contracts.swift`, emitted by
  the codegen — so an app update that changes a payload's shape makes every
  stored file a MISS rather than a silent reinterpretation, which `Codable`
  alone does not guarantee. Per-TTL by kind (`CacheTTL`). Sign-out calls
  `clearAll()`, which removes the whole directory: a per-store list is a list
  someone forgets to add to.

  Cached now: watchlist (list+quotes together), options (book and chart
  separately), transactions, dividends (per filter), news (per ticker),
  instrument detail and series (per symbol, per range). `InstrumentSeed` covers
  the one gap a cache cannot: the FIRST visit to a stock with no connection
  draws a header from what `LiveStore` already holds — and deliberately not a
  reconstructed `InstrumentResponse`, since `position`, `dayStats`, `groups`
  and `transactions` are not in the holdings payload and filling them with
  empties would tell the user they own nothing.

  **Still not offline: mutations**, matching the web (`Server Actions stay
  online-only`). A write that never left the device now says so — "You're
  offline — nothing was saved" rather than a sentence that reads as a refusal —
  and the transaction form keeps its draft and retries ONCE when the network
  returns. There is no outbox, and there should not be one until
  `/api/mobile/v1/transactions` carries an idempotency key: without one a retry
  can double a purchase.

  Every figure on screen is a server-formatted string. Nothing is re-derived
  client side, including the "All" scope total — re-adding across currencies
  would be a second money implementation on the one platform where `Double` is
  a footgun, and the CI grep for `Double(` covers `ios/` for exactly that
  reason.

  Not yet rewired: `(app)/holdings/[ticker]/page.tsx` still has its own
  loader. `src/lib/instruments/detail.ts` composes the endpoint's payload from
  the same shared pieces (`loadInstrumentInputs`, `composeHoldingsView`,
  `computePortfolioGroups`, `quoteFigures`), so figure parity is structural;
  the page needs more than the endpoint does (dividends, news, the streamed
  series, `createdAt` transaction ordering) and merging them was left out of
  this stage deliberately.

  **TestFlight, so the phone updates itself (2026-08-22).**
  `.github/workflows/testflight.yml` archives, signs and uploads on a push to
  `main` that touches `ios/**`. Internal testing needs no Beta App Review, so
  a build reaches the device minutes after processing — the cable was only
  ever there because nothing else was wired up.

  Signing imports one certificate and fetches the profiles. The first
  version let `-allowProvisioningUpdates` mint the certificate on the runner
  too, and since a runner is a blank Mac that meant a NEW development
  certificate per run until the Apple account hit its cap — "Choose a
  certificate to revoke", three times by 2026-09-21. Now one `.p12`
  exported from the owner's Keychain with BOTH the Apple Development and
  the Apple Distribution certificate lives in `IOS_DIST_P12` (base64) with
  `IOS_DIST_P12_PASSWORD`; the workflow imports it into a throwaway keychain
  and refuses to archive unless both identities are there, so nothing is
  ever minted. Both are needed because automatic signing archives with
  Development — it refuses a `CODE_SIGN_IDENTITY="Apple Distribution"`
  override on an automatically signed target (tried 2026-09-21) — and the
  export re-signs with Distribution.
  Profiles still come through the API key (`ASC_KEY_ID`, `ASC_ISSUER_ID`,
  `ASC_PRIVATE_KEY`) and no `.mobileprovision` is stored. The team id is NOT
  a secret: it is already public in `Base.xcconfig` and the AASA file.

  `testflight.yml`, `ios.yml`, `scripts/check-*.py` and the `release-ios`
  skill are written by Dark Army's agent-pack resync from its
  `ios-swift-testflight` profile. The project name it substitutes comes from
  its ledger (`~/.bob-companion/agent-pack.json`, `app`), which was empty and
  fell back to the title-cased folder name `StockFollow` — the ledger now
  says `StockHODL` and the pack detects `ios/*.xcodeproj` when the field is
  blank. A CI change belongs in the pack template first, or the next resync
  reverts it; the two `Double()` allowlist lines and the
  `gen-swift-contracts.mjs` trigger are still hand additions the resync
  drops, so check `git diff .github` after one.

  The build number is `github.run_number`, which is monotonic and traces a
  TestFlight build back to a CI run and a commit. Recreating the workflow
  would restart it and collide — `manageAppVersionAndBuildNumber` is false in
  `ExportOptions.plist` precisely so the number is ours to reason about.

  **The APNs split this forced.** `aps-environment` was `development` in the
  one entitlements file, and a distribution build claiming that is rejected at
  upload. So `StockHODL-Release.entitlements` now carries `production` and
  `Release.xcconfig` points at it. The two files must stay identical in every
  other key — a capability added to one and not the other ships a Release
  build silently missing it — which `scripts/check-entitlements.py` enforces
  in `ios.yml` by parsing both, and the TestFlight job re-checks by reading
  the entitlement back out of the ARCHIVED binary.

  **The API key needs the Admin role.** An App Manager key creates
  development certificates happily — the archive signs, and the failure only
  arrives at export as `Cloud signing permission error` / `No profiles were
  found`. Creating a DISTRIBUTION certificate through the API takes Admin. A
  key's role cannot be edited, so a key with too little access has to be
  revoked and replaced (`ASC_KEY_ID` and `ASC_PRIVATE_KEY` change,
  `ASC_ISSUER_ID` does not).

  **The archive is development-signed, and that is fine.** The second run
  died on our own guard: the .xcarchive claims `aps-environment=development`
  because automatic signing archives with a development identity. It is
  `-exportArchive` that re-signs with the distribution certificate and swaps
  the entitlement. So the export runs first to a local .ipa, the guard reads
  the entitlement out of THAT, and the upload is the same export again with
  `destination` flipped to `upload` on a copy of the plist. Verifying the
  archive proved nothing about the upload; verifying the .ipa proves it about
  the bytes.

  **The runner image is a source dependency.** The first run died in the
  archive with forty concurrency errors — `macos-15` ships Xcode 16.4 and this
  app needs Swift 6.2's default MainActor isolation, without which every
  UIKit call in `AppChrome.swift` and every store is "main actor-isolated ...
  from a nonisolated context". So the job runs on `macos-26`, selects the
  newest installed Xcode explicitly, and refuses anything below Swift 6.2 in
  its first step — a toolchain that cannot build this should say so in one
  line, not as a wall of type-checker output.

  The consequence this had: sandbox and production device tokens are
  different universes, and a token from one is `BadDeviceToken` at the other's
  host. `APNS_ENVIRONMENT` picks the host the server pushes to, so it could
  only ever be right for one of the two builds at a time — and both exist at
  once here, a TestFlight install and the same app run from Xcode over a
  cable.

  So `sendPushAlert` no longer trusts it. A token the chosen host answers
  `BadDeviceToken` for is replayed once against the other host on a second
  connection, and only a token BOTH hosts reject is called an error. The
  classification lives in the exported `classifyResponse` because the whole
  retry hinges on it, and it is what the tests drive. `410 Unregistered` is
  still the only response that may delete a row; `BadDeviceToken` never
  deletes, because it is the same reply for a wrong-universe token and a
  malformed one. `APNS_ENVIRONMENT` is now only a hint about which host to
  try first.

  **Notification preferences + the daily summary (2026-09-05,
  plans/2026-09-05-daily-portfolio-summary-push.md).** The Settings screen
  has TWO switches — "Price alerts" and the evening "Daily summary" — and
  both are server-stored facts in `notification_preferences`
  (`src/lib/push/preferences.ts`, the table's only owner), read and written
  through `GET`/`PUT /api/mobile/v1/notification-preferences` (deliberately
  NOT a field on `/settings`, whose handler pays for an uncached vendor
  probe). A MISSING row means both off — uniformly, forever: the backfill
  migration inserted `price_alerts = true` for every user already holding a
  push token, so there is no token-exists fallback for readers to know
  about, and the check-price-alerts cron now filters on that preference
  instead of pushing to every token. The device token itself is registered
  while ANY switch is on and DELETEd only when both are off — the switches
  are preferences, the registration is the shared plumbing under both.
  `/api/cron/daily-summary` (Vercel Cron, weekdays at 20:15, 20:30, 20:45,
  21:15, 21:30, 21:45, 22:00 and 22:15 UTC — a retry ladder starting 16:15 ET
  in each half of the year, the pre-close slots a no-op) sends one push
  per opted-in user with the all-portfolios day pair — the pure composition
  is `src/lib/push/daily-summary.ts`: null (send nothing) when no day figure
  exists, "At least" when `partialDayChange` floors it, excluded tickers
  NAMED on a second line — gated on `dailySummaryDayToSend` (send iff the
  last COMPLETED session is today, NY-calendar; holidays and weekends fall
  out of one comparison) and marked in `daily_summary_last_sent_day` ONLY on
  a `delivered` outcome. The push also WAITS for the close report it
  deep-links to (2026-09-23, plans/2026-09-23-report-push-waits-for-report.md):
  a run whose report is not `ready`/`refused` (`dayReportIsComplete`,
  `src/lib/day-report/readiness.ts`) sends nothing, writes no marker and
  reports `notReady` in its JSON and log, so a later slot retries; an evening
  whose report never completes (or whose every slot errors at APNs) has no
  summary that day. `not_configured` (no `ANTHROPIC_API_KEY`, an optional
  key) does NOT hold — no report is ever coming, so the push goes out
  (`dayReportPushMayGo`). `21:00 UTC` is never a slot: it is the winter close
  instant, which counts as completed, and the close report — never
  regenerated — would be written from 15-minute-delayed quotes;
  `src/lib/push/cron-slots.test.ts` pins the ladder. Its tap deep-links the
  close report, `stockhodl://day-report/<YYYY-MM-DD>?kind=close`
  (`dayReportUrlScheme`), as § Day report below describes.

  **Five-day lights on the totals and the market strip (2026-09-21).** The
  same `TrendLights` every tile draws now sit under the Dashboard's "Total
  value" box, under a new "Options value" box (the same `SummaryHeader`,
  above the options grid, in place of the inline figure the header carried),
  and on the four market-strip tiles. Server side: `liveSummarySchema`,
  `indexTileSchema` and `currencyTileSchema` gain an optional `trend`
  (`trendDaysField`). `src/lib/trend/total-trend.ts` (pure) sums CURRENT
  units × per-session close × per-session NBP rate into one point per
  session, and a session is a HOLE unless every position has a figure for
  it — summing whatever is there would report a book that shrank because a
  row was missing. `fetchHoldingsTotalTrendBestEffort` (PLN, equity bands)
  and `fetchOptionsTotalTrendBestEffort` (USD, unexpired lots, option bands)
  live beside the per-tile loaders in `trend/load.ts`, both never-throw.
  Index tiles grade the proxy's daily bars on the NYSE calendar; the FX
  tile grades its daily bars on the last six UTC days that have one, on a
  new `FX_TREND_SCALE` (0,1 / 0,35 / 0,8 %) because a currency's ordinary
  day would sit at level 1 on the equity bands.

  **USD/PLN in the market strip, and a screen behind every tile (2026-09-20,
  plans/2026-09-20-usd-pln-tile-and-market-detail.md).** The Dashboard strip
  carries a fourth tile, USD/PLN, sourced from forex AGGREGATES
  (`C:USDPLN`, `src/lib/market-strip/fx.ts` + `fx-load.ts`): the vendor's
  snapshot endpoint answers NOT_ENTITLED for currency pairs, so the headline
  is the newest minute bar's close and the day move is measured from the
  last daily close strictly BEFORE the tip's UTC date — the forex "day" is
  the **UTC clock day** (the vendor's daily bars sit at 00:00 UTC), never the
  NYSE session; `sliceLastUtcDays` replaces `sliceLastSessions` and no
  `tagSessionPhases` bands are drawn. Picking the base by date rather than
  by index is what keeps the vendor's still-forming daily bar from becoming
  a 0,00% lie. `C:USDPLN` never enters the snapshot batch, the socket or an
  `instruments` row; no forex history is stored server-side (the phone's
  `DiskCache` per key/range is the cache). Every tile is now a push to the
  read-only `MarketDetailView` (`Route.marketDetail(MarketTileKey)`), whose
  header reads the SAME `MarketStripStore` the Dashboard polls and whose
  chart comes from `/api/mobile/v1/market-strip/series/[key]` — a door that
  accepts only the CLOSED `MarketTileKey` enum (`SPY|QQQ|DIA|USDPLN`) and
  answers anything else with the empty payload before any resolve, so it is
  not a symbol proxy. Index keys chart through `resolveInstrumentForBrowsing`
  + `getInstrumentPriceSeries` with the 5-year watched anchor (never the
  user's trade anchor). The rate prints four decimals everywhere via
  `ChartUnit.rate`. The tile refreshes on the strip's US-market poll gate,
  not around the clock — deliberate.

  **Day report (2026-09-19, plans/2026-09-19-day-report-page.md).** Two
  weekday crons, a pre-open Morning brief (`/api/cron/morning-brief`, 12:30,
  12:45, 13:00, 13:15 UTC — all before the summer open, same readiness gate
  as the closing push, plans/2026-09-23-report-push-waits-for-report.md) and
  the existing after-close summary, each walk EVERY account
  (`listDayReportUsers`, `user` LEFT JOIN `notification_preferences`) and
  write that half's report row first; the one daily-report preference
  governs only whether a push follows. The walk used to be gated on the
  switch, which meant an account with pushes off got no morning report at
  all (fixed 2026-09-21). Same day, two more: the narrative reservation in
  `narrative-store.ts` now stamps its own millisecond `createdAt` — the
  `defaultNow()` value came back through `.returning()` truncated from
  microseconds, so complete/release (which match on `createdAt` equality)
  updated zero rows and every row stayed `pending` forever, the finished
  prose discarded. And headlines are the writer's SOURCE MATERIAL, not
  content: `facts.headlines[]` carries each article's `url` + `summary`,
  the writer has `web_fetch` (max 8) beside `web_search` (max 3) and is told
  to fold what it reads into the prose and never list or restate a
  headline; the iOS Day Report screen no longer renders a headline list
  (the field stays on the wire). Later the same day, after a
  claude-fable-5-1 audit of the first live report: the writer's prompt was
  rewritten (`narrative.ts` — one job per field, `kind` splits a morning
  "what to watch today and this week" from a close "what happened and why",
  150–240 words per field, sign in words not symbols, never read the movers
  table back, never mention inputs or tooling — `LEAK_PATTERN` is the
  deterministic backstop with one corrective retry); budgets went to effort
  `medium`, 8 searches for a morning / 5 for a close, 8 fetches, 6144 output
  tokens, up to four `pause_turn` continues. The facts gained `weekday`,
  `week` (Mon..Fri), `heldSymbols` (every held name, not the five movers)
  and `optionPositions`, and lost the events caption the model had been
  paraphrasing into the prose. The writer now also returns `events` (a
  dated list: earnings, ex-dividends, expiries, central-bank dates,
  summits — the Events card renders THESE, the market feed's own items are
  only the fallback) and `todayLine` (the morning push's second line, in
  place of headline/event counts); both persisted on `day_reports`
  (migration 0023, additive). One report per day-half for everything held —
  the per-portfolio scope chips are gone from the screen (the `p` query
  still works). Portfolio values in the report print in whole złoty. Both
  pushes use
  `stockhodl://day-report/<YYYY-MM-DD>?kind=morning|close`, so a tap opens the
  exact trading day and report half. Close figures rebuild equities from the
  holdings engine and options from their recorded daily mark (or close), then
  add the two PLN contributions; a single-portfolio scope excludes options
  because option lots are user-owned rather than portfolio-owned. Written
  portfolio, event, and macro sections are stored once in `day_reports` per
  user/day/scope/kind and are never regenerated; current figures can therefore
  disclose that older prose is stale. `src/lib/day-report/narrative.ts` is the
  second and only other `ANTHROPIC_API_KEY` reader beside vision extraction,
  and uses server-side web search for macro context while persisting only the
  returned source links. Known structured events are ex-dividend dates and
  option expiries; earnings dates are limited to the searched narrative.

  **Day-report history on the Dashboard (2026-09-20,
  plans/2026-09-20-day-report-history-on-dashboard.md).** The bottom of the
  Dashboard lists every report the app has WRITTEN — one row per
  `day_reports` row with `status IN ('ready','refused')` (a `pending` row is
  a 15-minute reservation, not a report) — newest first, close above morning
  within a day, thirty at a time behind "Show more". The row's figure is
  PERSISTED, never recomputed: `day_reports` carries three nullable columns
  (`figure_day`, `day_change_pln`, `day_change_pct`) plus `figure_partial`,
  written ONLY by `narrative-store.ts`'s `reserveNarrative` (insert and lease
  reclaim alike) from the same `combineDayFigures` Decimals the report page
  formatted, as decimal strings. A row written before those columns existed
  is listed with a dash — never a zero. The figure is NOT part of the facts
  fingerprint, so existing prose stays non-stale. The door is
  `GET /api/mobile/v1/day-report/history?cursor=YYYY-MM-DD:kind`, a keyset
  cursor naming the last row of the previous page (`history.ts`, one
  PK-prefix query; `history-compose.ts` the pure composer that formats
  through `dec()` → `signedMoney`/`fmtPct`). The Dashboard lists the `all`
  scope ONLY — a per-portfolio report generated lazily from the report
  page's chips is not listed. On the phone `DayReportHistoryStore` is
  cache-first for page one (`day-report-history`, 24 h TTL), never caches
  later pages, and dedupes on `(day, kind)`; a row is a `NavigationLink` to
  the SAME `Route.dayReport(day:kind:)` the push deep link reaches, from the
  Dashboard tab's own stack. A morning row's figure is the PREVIOUS session's
  move (that is what the brief recaps) and carries a "<day> close" caption
  saying so.

    **Browsing any ticker (2026-08-22).** The instrument screen used to answer
  only for a symbol you owned or watched (the web page has a third source —
  options underlyings — the endpoint never got). Everything else was "We don't
  have this instrument for you", so you had to commit a watchlist row before
  you could see a price. That is the wrong way round, and it filled the
  watchlist with stocks nobody chose.

  `resolveInstrumentForBrowsing` (`src/lib/instruments/resolve.ts`) is the
  fourth identity source and needs no relationship to the user at all:
  select-first on `instruments`, then the vendor directory, then a lazy mint
  through the one shared `resolveOrCreateInstrument` path, with the name and
  exchange clamped to the watchlist action's bounds because first-write-wins
  makes them permanent. `loadInstrumentDetail`'s watched branch became
  `unownedDetail` — one payload shape, `watched` the only difference — and
  `userPriceSeriesBySymbol` charts from the SAME resolved row it is priced
  from. The by-uuid `userPriceSeries` keeps its ownership gate: a uuid is not
  something a person browses.

  What stays refused: a ticker the directory has never heard of. That is a
  true answer rather than a permission one, and it is the reason a mint can
  never happen for a string somebody typed.

  On the phone this made the Watchlist tab's `+` a SEARCH rather than an add:
  tapping a result opens the stock, and the row's trailing binoculars still
  watches it in one tap for when that is what you came for. Watch and Add
  transaction then live where they belong — the instrument screen's `+` menu,
  which has always had them. The web's `/holdings/[ticker]` still 404s a
  ticker you have no relationship with; its loader is the un-rewired one noted
  above, and widening it is a separate job.

  **The rest of the native client (stages C3–C5, 2026-08-18).** Instrument
  screen with charts, transactions, watchlist and profile — the app is now
  feature-complete against the v1 scope in `docs/ios-native.md` A.8.

  *Charts (`ios/StockHODL/Charts/`).* `PlotPoints.swift` is the app's sanctioned
  money→float crossing (the widget's is `WidgetPlotPoints.swift`, see
  § Design system), and CI's `Double(` grep allows exactly
  that path by name. The floats become coordinates; every visible figure is
  formatted from the decimal string riding on each point. The axis is
  CATEGORICAL for 1D/5D and continuous otherwise — the same call
  `value-chart.tsx` makes, because a continuous intraday axis draws every
  overnight as a long diagonal, which is a closed market rendered as data.
  Extended-hours bands, the dashed first-point baseline and the tick placement
  are ports of the web's; the band spans including their deliberate off-by-one.
  A value that will not parse is DROPPED rather than zeroed: a fabricated zero
  draws a cliff to the floor and reads as a real crash in price.

  Every chart reports its change (2026-09-03,
  plans/2026-09-03-chart-change-indicators.md): a fixed-height row above the
  plot with the window's change — amount, percent and the range's
  `windowLabel` ("+12,40 zł  +3,12%  past month") — and a since-line in the
  scrub callout measured from the window's FIRST visible point ("+3,12% since
  1 sie"), the same baseline the dashed rule and the stroke colour already
  use. Both are computed in `ChartChange.swift` on `Decimal` from each point's
  `raw` string; the file never sees a plotted coordinate, because a
  subtraction of two floats is the money bug the `Double(` grep cannot catch.
  In Return mode (`unit == .percent`) the plotted quantity is already a
  return, so both figures are a percentage-POINT delta ("+3,12 pp") and
  `pctChange` is never called. A window starting at zero or below shows the
  amount only — never a fake "0,00%", never a sign-flipped ratio. The row
  reserves its height in every state so the plot never moves when a range
  finishes loading under a thumb; the callout is an overlay and re-measures
  itself, so the extra line moves nothing either.

  Every chart also carries the user's OWN trades as marks sitting on the line
  (2026-09-04, plans/2026-09-04-chart-trade-markers-hour-labels.md). Placement
  is one pure file, `Charts/TradeMarkers.swift` — Foundation only, no `Double(`
  — so the four surfaces (instrument price, portfolio value, the options book
  and one contract) cannot each decide it differently. Two rules are the whole
  feature. **The day key is granularity-dependent:** a DAILY point's `t` is an
  anchor the server chose — midnight UTC for instrument and portfolio bars,
  noon UTC for the options series — so its day is the **UTC** date
  (`ChartLabels.utcDate`), while an INTRADAY point is a real instant the server
  grouped by **New York** date (`NYCalendar.isoDate`). Reading a daily point
  through the NY calendar names the day BEFORE and puts every marker one bar to
  the left, which looks almost right; both directions are pinned by tests.
  Every `TradeMark` also carries a `label` — the ticker for a share trade, the
  card's `OptionCardItem.headline` ("AAPL $220 CALL") for an option lot — and
  the callout prints it on every surface ("BUY · AAPL · 12 @ 231,10 USD ·
  2026-08-12"): on the Holdings and Options lines a mark is otherwise a count
  of things bought with no way to tell which (2026-09-05). The two string
  helpers it leans on, `TransactionLine.quantityAtPrice` and the headline, are
  `nonisolated`/on the model because a `View`'s statics are main-actor and the
  marks are built off it.
  **The marker's Y is the matched POINT's y**, never derived from the trade's
  price — that is what "on the line" means and it keeps the traded amount out
  of the float world; the only arithmetic is the `Decimal` nearest-price search
  used on the instrument chart alone (`matchOnPrice`), where a price and the
  plotted quantity are the same kind of number. Everywhere else a busy day
  marks its LAST point. Trades on a day the range has no reading for are
  counted in a caption rather than vanishing; trades outside the window are
  simply not this window's business. The Holdings chart needed a journal, so
  `TransactionsStore` is HOISTED to `RootView` beside `portfolioChart` and
  `RouteStores.transactions` is gone: two instances would leave a marker on
  the chart for a row deleted on the Transactions screen. Holdings opens it
  through `loadIfNeeded()`, gated on the cached capture against
  `CacheTTL.ledger`, because that `.task` re-runs on every reselection of the
  tab and `load()` always issues the request; the Transactions screen keeps
  `load()`, since a screen about the journal should confirm it. That TTL is a
  FORTNIGHT, so every add path — the Holdings sheet and the instrument
  screen's — calls `TransactionsStore.invalidate()` and reloads after a save:
  nothing else in the app writes these rows, so without it a trade just
  recorded would go unmarked on a chart whose line had already moved for it.
  A tapped
  marker's callout is a TOGGLE and belongs to one plot: `onChange` on the
  placed marks AND on `ChartState` drops it whenever the chip, the range, the
  mode or the journal changes underneath, since a range switch changes what
  `PlotPoint.x` even means (an index intraday, days since the epoch daily) and
  a remembered mark would clamp its box to the left edge naming a trade no
  longer there. **A guard for `@State` must live at least as long as the state
  it guards.** Both those `onChange`s sit on `ValueChart`'s OUTERMOST `VStack`,
  never inside the chart subtree: an `onChange` re-seeds its baseline every
  time it is re-inserted, and the chart is swapped for a placeholder rectangle
  on every `.loading` — which `PortfolioChartStore.reload()` enters on every
  range and chip switch — so a modifier attached inside is destroyed exactly
  when it was supposed to fire. For the same reason the marker accessibility
  label is applied unconditionally with an EMPTY string when there is nothing
  marked, rather than through an `if`: a `_ConditionalContent` branch flip
  rebuilds the subtree and takes its modifiers with it. The tap/scrub split
  reads the gesture's OWN `translation` and keeps no origin in `@State`: the
  enclosing `ScrollView` can steal a drag, `onEnded` never fires when it does,
  and a remembered origin would then survive into the next gesture and make a
  genuine tap read as a scrub. The toggle itself needs the selection as it was
  BEFORE the gesture (`markBeforeGesture`, captured on the first `onChanged`
  and keyed on the gesture's `startLocation`), because `DragGesture(minimumDistance: 0)`
  fires `onChanged` on touch-down and clears the selection there — comparing
  the hit against `selectedMark` in `onEnded` can never be true.

  Every wall-clock time in the client prints `.minute(.twoDigits)`. `.minute()`
  drops the leading zero — "10:0" beside money — and it had shipped in five
  formatters at once; `ios.yml` now refuses the bare spelling anywhere under
  `ios/`.

  *Transactions (`ios/StockHODL/Transactions/`).* `src/lib/validation.ts` is
  ported rule for rule into `TransactionInput.swift` — the thousands-grouping
  refusal with its `0,125` carve-out, the comma-as-decimal normalisation the
  pl-PL keypad forces, the storage bounds, the FX-required-for-non-PLN rule,
  the PLN-forces-'1' transform. The server still validates everything; the port
  buys a field that turns red as you leave it rather than a round trip that
  names the problem after Save. Two rules needed more than translation:
  `Decimal(string:)` parses the longest valid PREFIX (so "1.234,5" would pass
  as 1.234 — `dec()` is right for server-produced amounts and wrong for user
  input), and the server's `replace(',', '.')` replaces ONE comma, so replacing
  all of them turns "1,2,3" into a plausible "1.2.3" instead of a clean refusal.
  An EDIT form is seeded through the initialiser precisely so `draft`'s
  `didSet` does not fire: an FX autofill there would overwrite a historical
  trade's frozen rate with today's idea of it.

  *Watchlist (`ios/StockHODL/Watchlist/`).* A separate store from `LiveStore`,
  mirroring the server's deliberate parallelism — watched symbols never widen
  the holdings vendor batch, and merging the two clients would quietly undo
  that. No App Group snapshot — that container is for the one payload a widget
  reads — but a `DiskCache` since 2026-08-22: "cheap to refetch" was true of
  the request and false of the experience, since offline the tab was a blank
  screen with a Try again button. The SSE parser became generic
  (`StreamEvent<Payload>`, `SSEParser<Payload>`) so both pumps share one
  implementation rather than diverging in the reconnect logic.

  The screen is a TILE GRID, not a list (2026-08-18) — the same shape the web
  takes, where `watchlist-live.tsx` imports the Dashboard's `TickerTile`
  outright. iOS reuses its own `TickerTile` under the identical
  `.adaptive(minimum: 76)` template, passing `unrealizedPct: nil` so the P/L
  line is absent rather than a `P/L —` about a position nobody holds. The
  reason is drift, not density: the same tickers rendered as tiles on the
  Dashboard and as rows here are two renderings of one idea, and the second
  stops being maintained. A grid has no swipe actions, so removal is visible
  as Edit mode (2026-08-30): the persistent top bar shows Edit whenever the
  watchlist root has tiles (`TopBarEdit`, the `TopBarAdd` pattern), and while
  it is on every tile carries a remove badge in place of its navigation. The
  long press stays as a shortcut — it used to be the only, and invisible, way;
  the web removes from the ticker page instead, and a screen that could
  already do it here should not lose that by changing shape. The shared
  search sheet's watch action is a labelled Watch/Watching capsule reusing
  the instrument screen's vocabulary (the word plus the binoculars fill carry
  the state, never color alone), stays open after a watch so several stocks
  can be watched in one visit, and records a watched stock into "Recently
  searched" the same as an opened one.

  Four more server routes, all for the same reason as C2's — `src/proxy.ts` is
  a cookie gate (404 empty body; exclusions are `api/auth`, `api/cron`,
  `api/mobile/`, AASA):
  `/api/mobile/v1/symbols/search`, `/api/mobile/v1/watchlist/quotes` and its
  `/stream`. The symbol search itself moved to `src/lib/market-data/search.ts`
  so the web route and the mobile twin answer from one body. Two contract
  changes came with them: `symbols.ts` (new) and `exchange` added to
  `transactionRowSchema` — the write schema requires the field and
  `updateTransaction` never writes it, so an edit form without it would send a
  fiction the server happens to discard.

  Two testability problems this stage surfaced and fixed at the cause:
  `UserDefaults.standard` is process-wide, so adding suites reordered the run
  and one test's remembered scope decided what another opened on — both stores
  take an injected `UserDefaults` now; and the search debounce is awaited
  through `awaitSearch()` rather than slept through, because a test that waits
  out 250 ms passes or fails on machine load.

  **Visual parity with the web (stage C6, 2026-08-18).** The client was
  feature-complete and did not look like the product: correct tokens, wrong
  hierarchy. The pass ported the DECISIONS, not the pixels — every screen is
  still native SwiftUI, and nothing about the layout is a webview.

  What changed and why: the holding card now leads with the PRICE, not the PLN
  value, and carries a brand tile, `SYMBOL · N shares`, and a bordered Oversold
  badge — the mobile layout of `holding-card.tsx` down to the reading order,
  because leading with the value read like a different product on the same
  account. The summary puts every figure under its own label
  (`portfolio-summary.tsx`); two signed percentages side by side with no
  heading are indistinguishable at a glance. `MarketStatusBar` replaced a
  one-line caption with the web's dot + word + ticking countdown, driven by
  `TimelineView` against the server's `nextTransitionAtMs` — the client still
  does no timezone math.

  `ExtendedMoveView` is the single native renderer of the extended-hours line,
  the counterpart of `extended-move.tsx`: full variant for cards and headers
  (session word, figure, and the instant when the reading is stale), compact
  for tiles (no instant — it never fit). The old inline `PRE`/`POST` spellings
  in three files are gone, which is what stops the wording from drifting.

  Brand icons needed a route: `/api/mobile/v1/logo/[symbol]`, the bearer twin
  of `/api/logo/[symbol]`, both now sharing `src/lib/market-data/logo.ts` —
  the injection gate has ONE implementation and its own test. On the client
  `TickerLogo` cannot use `AsyncImage` (there is nowhere to put an
  Authorization header), so `LogoLoader` fetches, decodes and caches both hits
  AND misses — most of this portfolio has no vendor icon, and without the
  negative set every scroll re-asks for a 404 already given. It reaches views
  through `\.logoLoader` in the environment rather than a constructor
  argument, which keeps the auth store out of files that are currently
  testable without one, and it is purged on sign-out with the rest.

  Only a DEFINITIVE miss is remembered. The fetch closure answers
  `RemoteImageOutcome` — `.bytes` / `.absent` / `.failed` — not `Data?`,
  because the negative set is permanent for the life of the process and a
  request that never finished has established nothing. When it was `Data?`,
  a tile whose `.task` was cancelled by scrolling, and every tile rendered in
  the moment before the session token was readable at launch, were filed as
  logo-less for the rest of the session: an arbitrary handful of holdings drew
  a monogram until the app was force-quit, while the server logged 200 for
  every one of them. `RemoteImageOutcome.of(_:)` is the single place a 404 is
  told apart from any other error.

  **The phone's shell became the web's shell (C7, 2026-08-18).** A tab bar
  with the same four slots as `NAV` in `app-shell.tsx` (Dashboard, Holdings,
  Options, Watchlist) under a persistent top bar carrying the `BullMark` and
  the profile glyph — the mark is the illustrated SharedAssets image at 24pt,
  so no second drawing exists. Each tab
  owns its own `NavigationStack`; Profile is a SHEET because the top bar sits
  above the `TabView` and belongs to no stack. `AppChrome` paints the UIKit
  tab bar from tokens — `.tint` alone colours only the selected item, and a
  system-material bar under a token-painted app was the loudest way the native
  app stopped looking like the web one.

  *Passkeys in Profile (2026-08-18, `ios/StockHODL/Profile/`).* The enrolled
  keys — name, synced-or-device-bound, backed-up, added — over
  `/api/mobile/v1/passkeys` (+ `DELETE /[id]`). Adding a key is a WebAuthn
  registration ceremony on the phone (`PasskeyRegistrationController` plus
  the plugin's generate-register-options / verify-registration endpoints),
  not a JSON write.

  The last-key rule moved to where the row is deleted
  (`src/lib/passkeys/manage.ts`, shared by both surfaces). It had lived in a
  DISABLED BUTTON on the web — a hint, not a rule: absent from the phone,
  from a stale second tab, and from any direct call to the plugin endpoint.
  On a passkey-only app with no password fallback, deleting the final
  credential does not degrade the account, it ends access to it, recoverable
  only through `scripts/recover.ts`. So the web delete now goes through a
  Server Action over the same function, the refusal is a 409 with a sentence,
  and the phone renders `canRemove` as the SERVER computed it rather than
  re-deriving it from `items.length`.

  The delete is deliberately NOT idempotent, unlike the watchlist's: an
  unknown or foreign id is a 404, because "your key is gone" about a key that
  is still enrolled is the one wrong answer here with a security meaning.

  *Screenshot import, dividends and news on the phone (2026-08-18).* The
  three surfaces the web had and the phone did not.

  **Import** is the one that justified being native: the web importer
  deliberately opens the photo LIBRARY and never the camera, because a browser
  file input cannot do better. The phone offers both, and photographing the
  broker app you are already looking at is the gesture the feature was waiting
  for. `NSCameraUsageDescription` is in BOTH plists — iOS kills the process
  outright when a camera is presented without it, so its absence is a crash
  rather than a denied permission. That is the rule for EVERY in-process TCC
  gate the app can reach, not a fact about the camera:
  `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` sit
  under it too (2026-09-04). Keyboard dictation is the second such gate — since
  iOS 16 the mic key runs in the host process, so every free-text field in the
  app is a reachable microphone, and it asks for speech recognition alongside
  the microphone, which is why there are two keys and not one. The widget
  plists carry none of the three: an extension presents neither keyboard nor
  camera. `scripts/check-privacy-strings.py`, run from `ios.yml`, is what
  enforces all of that, and `PrivacyStringsTests` reads the merged plist of the
  built bundle so a key lost in the `GENERATE_INFOPLIST_FILE` merge is caught
  too.

  The gate ladder moved to `src/lib/screenshots/parse.ts` on the way. Two
  Server Actions carried two copies of it and the mobile routes would have
  made four; its ORDER is the security and cost story of a route that turns an
  upload into a paid vendor call (free local gates → the shared rate limit →
  the vendor), and four copies of a load-bearing order is three too many. Auth
  stays with each caller, since that is the one step a cookie session and a
  bearer token do differently. Extracting it also surfaced a real gap: the
  normalizers index into model output directly, so a shape nobody anticipated
  threw past every surface instead of degrading to `unparseable` — the
  documented promise is now actually kept.

  The transaction route answers the PREFILL, not the extraction. Which side
  the screen means, which currency the price is really in when the screen
  mislabels it, whether a złoty commission can be converted into a dollar
  field — those are the rules a broker screenshot exists to defeat, and
  shipping the raw fields would have meant porting all of them to Swift and
  then keeping two copies honest. The notes travel as FACTS and each surface
  writes its own sentences. The options importer drives the CASCADE rather
  than filling fields: setting the underlying fetches the real chain, so a
  misread strike ends as an unselected picker rather than a saved lot nobody
  holds.

  **Dividends** arrived read-only and stopped being so in the migration pass
  below. The first-visit sync moved into `src/lib/dividends/view.ts` with the scope and
  symbol resolution: it is the only thing that fills the history (there is no
  cron), and a mobile route that skipped it would have shown a permanently
  empty tab on a fresh install while the browser filled itself. The two
  unrated counts stay apart on the wire and on screen — `awaitingFx` is a row
  the next NBP sync can rate, `fxUnsupported` never will be, and one number
  would turn a permanent gap into one that looks like it is arriving.

  **News** needed two asset twins (`/api/mobile/v1/news/image/[id]`,
  `/publisher-logo/[id]`) over one shared body in `src/lib/news/assets.ts`.
  The proxying is the point: `hasImage` / `hasPublisherLogo` booleans cross
  the wire and the URL never does, so the device makes no request the server
  did not mediate and the publisher hosts stay unnamed on the client.
  `degraded` renders as a caption, never as an error — stale rows with a
  disclosure beat an empty screen, which would claim there is no news.

  `LogoLoader`'s two-cache algorithm became `RemoteImageCache`: remembering a
  MISS is the load-bearing half (most holdings have no vendor icon, most
  publishers no usable logo), and news needed exactly the same thing.
  `NavRow` came out of the same pass — Transactions, Dividends and News all
  light no tab, because all four tab slots hold the same four the web's `NAV`
  does, so each is reached from the screen it belongs beside.

  *The app icon (2026-08-18, `ios/StockHODL/Assets.xcassets/`).* The project
  had asked for `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` since it was
  created and there was no asset catalog to answer, so the phone showed the
  blank placeholder. The catalog is a committed illustrated 1024 RGB-no-alpha
  composite of the bull on the dark `--surface-0` plate; `scripts/gen-icons.mjs`
  (`pnpm gen:icons`) verifies that file and rewrites Contents.json rather than
  drawing it. One 1024 `universal` entry — Xcode derives every springboard,
  spotlight and settings size — written as RGB with NO alpha channel, since
  iOS rejects an app icon carrying one even when every pixel in it is opaque.
  `ios/StockHODL` is a file-system-synchronized group, so the folder existing
  on disk is the whole wiring; `project.pbxproj` did not change.

  `ErrorBody` gained the `{ error }` shape while wiring this. There are two
  servers behind one base URL — Better Auth answers `{ message, code }` and
  our own handlers answer `{ error }` (`jsonError`) — and reading only the
  first meant every sentence a mobile route wrote by hand was discarded on
  arrival and replaced by a generic one.

  *Closing the web→iOS gaps (2026-08-18).* Six things the browser could do
  and the phone could not, done in one pass. What each one cost is the
  interesting part, and it varied by an order of magnitude.

  **Portfolio management cost no server work at all.** `POST /portfolios`,
  `PATCH`/`DELETE /portfolios/[id]` and `POST /portfolios/reorder` had existed
  since S1 and the phone was calling only the `GET`. So the whole feature was
  `PortfoliosStore` plus a `⋯` menu — and one bug found on the way: `scopeChips`
  joined `bootstrap.portfolios` against `bootstrap.scopes`, which is composed
  only for portfolios holding rows, so an EMPTY portfolio had no chip. Creating
  one on the phone would have produced something that could not then be
  selected, renamed or deleted. It reads `portfolios` directly now.

  **The Value/Return toggle turned out to be a missing chart.** `chartPointSchema`
  has carried `r` all along and `ChartPoint` decoded it, so the toggle itself is
  free — both curves ride one payload and switching costs no request. But the
  phone had no portfolio chart to put it on: `/api/mobile/v1/series/portfolio`
  existed and nothing called it. `PortfolioChartStore` is deliberately NOT part
  of `LiveStore`: that store re-renders on every streamed tick, and a chart
  reloading with it would refetch a five-year walk once a second. The options
  charts got the same toggle over `OptionsStore.chartMode`, remembered under its
  own key — the web keys `MODE_STORAGE_KEYS` per surface for the same reason.

  **Candles were the only genuinely new drawing.** `o`/`h`/`l` were already in
  the contract and already produced for daily ranges, so this is client-side
  too, but a candle is not a line with extra properties: `yDomain` had to start
  fitting the WICKS (a domain fitted to closes clips the highs the view was
  switched on to see), and the bars are thick `RuleMark`s rather than
  `RectangleMark`s because a rectangle needs a width in DATA units — 1 on the
  categorical intraday axis, 86 400 000 on the continuous daily one, while a
  line width in points is the same bar at both scales. A range whose bars carry
  no OHLC falls back to the line; a Candles tab drawing an empty frame would
  look broken rather than honest.

  **Dividend writes were the only gap needing server work**, and it was an
  extraction rather than new logic: `src/lib/dividends/mutations.ts` now owns
  the portfolio-ownership check, the transacted-instrument check, the
  vendor-row portfolio lock and the revalidation list, and BOTH the Server
  Actions and the four new mobile routes call it. The
  `src/lib/portfolios/mutations.ts` precedent, applied to a record the user may
  file taxes from — which is exactly the kind of thing that must not have two
  implementations. Validation is `src/lib/dividends/validation.ts` unchanged,
  parsed from a JSON body instead of `FormData`; the optional fields matter,
  because its `z.preprocess` turns `''` into absent but refuses `null`, and
  Swift's `JSONEncoder` omitting a nil is precisely the encoding it wants.
  `/dividends/instruments` is the phone's version of the web form's two
  dropdowns, as one read.

  **The instrument screen had the most holes and the fewest surprises.**
  `watched` already rode in the payload with no control attached; the watch
  toggle is optimistic because the server's answer is already known (a
  successful POST means watched) and waiting for a reload would make a one-bit
  toggle feel like a form submission. `dayStats` and `cachedPrice` are new on
  the contract, and `dayStatsFigures` was extracted from `day-stats.tsx` so the
  web row and the phone row cannot round differently — the component now
  renders that function's output rather than formatting its own. News and
  dividends are LINKS rather than embedded sections: both are their own
  endpoints, and folding them into this payload would make every instrument
  open pay for data a user may never scroll to. The web embeds them because a
  page load is one round trip; a phone screen is not.

  **Settings is two facts the device cannot derive.** `GET /api/mobile/v1/settings`
  runs the same uncached `checkKeyHealth()` probe `/settings` does, so it is
  opened rather than polled — and it carries `recoveryMode`, which is the
  reason the endpoint exists at all: while that flag is on, a password is
  enough to reach the account, and a phone that could not say so would leave
  the user with no way to learn it.

  One shared-code note: `FormField` became generic over its field enum rather
  than being copied for the dividend form, and `dayStatsSchema` spells its
  second field `dayOpen` — `open` is a Swift declaration modifier, and
  quicktype answers one with a mangled `dayStatsOpen` property.

  The **Dashboard** (C7) needs NO server surface: `getHoldingsView` already
  feeds both `/api/mobile/v1/bootstrap` and the web page, so `DashboardView`
  is a second view over the SAME `LiveStore` the Holdings tab reads — no
  second stream, no second poll, no request of its own. It shows every
  portfolio, ignoring the scope chips, exactly as the web Dashboard does.
  `HoldingsSort.swift` (six orderings, raw decimal keys, unknown as its own
  bucket — its TypeScript original was retired 2026-09-23) gives BOTH screens the sort picker the
  phone had nowhere; each remembers separately, as on the web.

  **Options on the phone (S3, 2026-08-18)** needed five bearer routes, all
  thin twins over the existing server code: `/api/mobile/v1/options`
  (GET payload + POST add), `/options/[id]` (PATCH/DELETE a LOT),
  `/options/expirations`, `/options/strikes`, and `/series/options`. Two
  extractions made that possible and are the only web-behaviour changes:
  `src/lib/options/portfolio-series.ts` (the two series actions' bodies) and
  `src/lib/options/mutations.ts` (the three lot writes), both now shared by
  the actions and the routes so two doors into `option_positions` cannot
  enforce two different rule sets. Writes parse `optionPositionAddSchema` /
  `optionPositionEditSchema` verbatim; the chain lookups DEGRADE rather than
  5xx, because a vendor hiccup mid-add must leave the form usable.
  `optionsPayloadSchema` + `options-contract.test.ts` are the anti-drift pair
  for a 30+-field card, the `live-payload-contract.test.ts` arrangement.
  `?ticker=` on the series route is the OCC ticker, NOT the card `key` — a
  card can be a `ticker#rowId` group, which matches no row.

  On the client (C8–C9, 2026-08-18) `OptionsStore` is the third store built in
  `SignedInView` and shares NO type with `LiveStore` beyond the display
  primitives — that is the financial isolation made structural, so summing the
  two totals is not a one-line mistake away. It POLLS at 60 s and never
  streams, gated on foreground `scenePhase` AND `market.pollingResumesAtMs`;
  without both, a phone in a pocket over a weekend issues ~1,440 pointless
  requests a day. `OptionCardView` serves the list and the contract screen
  through one `variant`, so those two surfaces cannot drift. Adding a contract
  runs the vendor CASCADE (underlying → expirations → call/put → strikes,
  debounced) and takes its identity from the returned `OptionContractRef` —
  never from typed text, which would name a contract that does not exist.
  Editing is LOT FIELDS ONLY and removal addresses a lot id, both labelled
  with the purchase they touch.

  Three shared pieces were GENERALIZED rather than cloned in the same pass:
  `RangeTabs` over a `ChartRangeOption` protocol (the options chart has five
  daily ranges — `1D`/`5D` would always draw nothing), `SortMenu` over a
  `SortOption` protocol (two comparators, one control, as on the web), and
  `TileFrame`/`TilePrice` shared by the stock and option tiles. `FlowRow` is a
  small `Layout` giving the option card's headline row the `flex-wrap` the web
  gets for free.
- The Watchlist (M6, 2026-08-14, plans/2026-08-13-watchlist-section.md):
  stocks followed but not owned, in the `watchlist` table (composite PK
  `(userId, instrumentId)`, additive migration). It holds the fourth nav slot
  on both shells (like `/transactions`, `/settings` deliberately lights no
  tab — see the top bar below for where it lives now).
  `/holdings/[ticker]` recognizes watched-but-unowned instruments as a second
  session-scoped identity source and renders chart + live header + an
  add-transaction invitation instead of position figures — anything neither
  owned nor watched stays the same indistinguishable 404. Watched charts
  anchor at a FIXED five-year lookback (`watchedAnchorDate` in
  `src/lib/watchlist/anchor.ts` — no first trade exists, and the anchor
  bounds the daily-close backfill), and the `refresh-history` cron tops
  watched instruments up alongside held ones. Buying a watched stock does
  NOT auto-remove it (deliberate; removal is one explicit tap).
- The TOP BAR and the portfolio SCOPE (2026-08-14,
  plans/2026-08-14-top-bar-and-portfolio-integration.md). Both shells gained a
  top bar: the bull mark + wordmark on the left (mobile; on desktop the
  sidebar brand row carries it and the bar holds only the glyph) and a profile
  glyph on the right, linking to `/profile` — which holds identity plus the
  Settings row. `/settings` keeps its route (every passkey/WebAuthn flow and
  deep link is untouched); only its entry point moved, and it gained a
  BackLink to Profile. Both routes light no nav tab; the profile glyph carries
  their active state. On mobile the bar is an in-flow flex child ABOVE the
  scrolling `<main>` — never inside it — which is what preserves
  PullToRefresh's sole-child contract, and it owns the top safe-area inset
  that `<main>` used to carry.
  Portfolios stopped being a screen: it is a SCOPE on Holdings, `/?p=<id>`,
  chosen from a chip row (`All` + one chip per portfolio + `+ New`) that
  scopes the summary, the value chart and the card list. Scope lives in the
  URL and deliberately NOT in localStorage — a sticky invisible filter would
  let a partial total impersonate the whole portfolio. `resolvePortfolioScope`
  (`src/lib/holdings/scope.ts`) is the ONE resolver: a malformed, foreign or
  deleted id silently becomes All, never a 404. Every payload carries every
  scope (`LivePayload.scopes`, composed by the same `composeSlice` as the
  total), so the client SELECTS a scope and `/api/quotes*` keeps its
  no-query-parameters rule. Portfolio CRUD is contextual — it appears only in
  a selected scope, behind the `⋯` menu; drag-reorder retired in favour of
  Move earlier/later. `/portfolios` survives only as a redirect (`?open=<id>`
  → `/?p=<id>`), and saving a transaction now lands on `/?p=<id>`. `/options`
  took the freed nav slot as a deliberate placeholder.
- `server-only` is imported by every module that touches secrets or the DB.
- Accessibility is not optional: direction is never conveyed by color alone,
  tap targets stay ≥44px, focus rings are never removed.
- Nobody commits or pushes on the user's behalf.
