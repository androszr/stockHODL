import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/* ==========================================================================
 * Better Auth tables
 *
 * Shape is dictated by Better Auth's core + passkey plugin — do not rename
 * columns. IDs are `text`, not `uuid`: Better Auth generates its own ids and
 * fighting that buys nothing. The MVP sketch had uuid; text is the deliberate
 * correction.
 * ========================================================================== */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const passkey = pgTable('passkey', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull(),
  counter: integer('counter').notNull(),
  deviceType: text('device_type').notNull(),
  backedUp: boolean('backed_up').notNull(),
  transports: text('transports'),
  aaguid: text('aaguid'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/* ==========================================================================
 * Domain tables
 *
 * Every money / quantity column is `numeric`, never float. Drizzle returns
 * numeric as a string, which is exactly what we want: it goes straight into
 * decimal.js without ever passing through a JS number.
 * ========================================================================== */

export const portfolios = pgTable(
  'portfolios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_portfolio_user_name').on(t.userId, t.name)],
);

export const instruments = pgTable('instruments', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Provider symbol, e.g. 'CDR.WA', 'AAPL'. The join key to all market data. */
  symbol: text('symbol').notNull().unique(),
  displayName: text('display_name').notNull(),
  exchange: text('exchange').notNull(),
  /** Trading currency — NOT the display currency (PLN). */
  currency: char('currency', { length: 3 }).notNull(),
  type: text('type').notNull().default('equity'),
  /**
   * Vendor classification, backfilled by `src/lib/instruments/profile.ts` —
   * the ONLY writer of these columns. All nullable and all additive: the
   * migration adds them empty and nothing reads them until the code that
   * fills them deploys.
   *
   * `profileSyncedAt` is what disambiguates a null `sector` (and a null
   * description / employees / homepage / shares outstanding). On its own
   * that null is unreadable — "never asked" and "the vendor has none" are
   * different facts with different costs, and without the timestamp a
   * permanently unclassifiable ticker would be re-asked on every page load
   * forever. Same reasoning as `price_history_coverage`.
   */
  sector: text('sector'),
  /**
   * INTENTIONALLY NEVER WRITTEN, and never read. Kept because dropping it
   * would be a destructive migration (non-negotiable #7) for no gain.
   *
   * The market-data provider has no domicile field: `address.country` is
   * never populated and `locale` is the LISTING market — `'us'` for every
   * ticker it serves, including Canadian and Dutch issuers. Filling this from
   * `locale` would state a confident falsehood that nothing on screen would
   * look missing. No second vendor is permitted, so it stays empty.
   */
  country: char('country', { length: 2 }),
  /** US SIC code as the vendor states it — a code, not a number. */
  sicCode: text('sic_code'),
  description: text('description'),
  totalEmployees: integer('total_employees'),
  homepageUrl: text('homepage_url'),
  /**
   * Share count as a numeric string — multiplied by price for market cap,
   * so it must never pass through a JS number. Same writer as `sector`.
   */
  sharesOutstanding: numeric('shares_outstanding', { precision: 24, scale: 0 }),
  profileSyncedAt: timestamp('profile_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    side: text('side').notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 8 }).notNull(),
    /** Per share, in the instrument's trading currency. */
    price: numeric('price', { precision: 20, scale: 8 }).notNull(),
    fees: numeric('fees', { precision: 20, scale: 8 }).notNull().default('0'),
    tradeDate: date('trade_date').notNull(),
    /** NBP mid rate on trade_date; exactly 1 for PLN instruments. Frozen at
     *  entry so historical cost basis never drifts when rates move. */
    fxRateToBase: numeric('fx_rate_to_base', { precision: 20, scale: 10 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_tx_portfolio_instrument').on(t.portfolioId, t.instrumentId),
    index('ix_tx_instrument_date').on(t.instrumentId, t.tradeDate),
  ],
);

/** Server-side quote cache. One row per instrument, overwritten on refresh. */
export const latestQuotes = pgTable('latest_quotes', {
  instrumentId: uuid('instrument_id')
    .primaryKey()
    .references(() => instruments.id, { onDelete: 'cascade' }),
  price: numeric('price', { precision: 20, scale: 8 }).notNull(),
  prevClose: numeric('prev_close', { precision: 20, scale: 8 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  marketState: text('market_state').notNull(),
  /** Provider-reported delay in seconds — contract data only; the UI renders
   *  no delay label (decision of 2026-08-10). */
  quoteDelayS: integer('quote_delay_s').notNull().default(0),
  source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
});

export const priceSnapshots = pgTable(
  'price_snapshots',
  {
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    asOf: date('as_of').notNull(),
    close: numeric('close', { precision: 20, scale: 8 }).notNull(),
    /**
     * Session OHLV (2026-08-16, massive-tier0 plan) — nullable, additive:
     * rows written before the columns existed hold NULL (the one-off repair
     * CLI that filled them was retired 2026-09-23, and coverage blocks the
     * read path from ever re-asking, so a null bar draws as line only).
     * `close` stays the immutable record.
     */
    open: numeric('open', { precision: 20, scale: 8 }),
    high: numeric('high', { precision: 20, scale: 8 }),
    low: numeric('low', { precision: 20, scale: 8 }),
    /**
     * Share COUNT, not money — numeric only to keep `Candle.volume`'s
     * decimal-string round-trip through Drizzle; it never enters `dec()`
     * arithmetic and is formatted with `Intl.NumberFormat`, never `fmtMoney`.
     */
    volume: numeric('volume', { precision: 20, scale: 8 }),
    currency: char('currency', { length: 3 }).notNull(),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.asOf] })],
);

/**
 * Book-keeping for the daily price-history cache: the inclusive span of days
 * we have ALREADY ASKED the provider about, per instrument. `price_snapshots`
 * alone cannot answer that — a missing row is ambiguous (non-trading day vs
 * never asked), and without this table every chart view would re-query the
 * provider for holes that can never fill (weekends, and non-US instruments
 * that have no history at all). One interval suffices: every chart window
 * ends "today", so coverage only ever extends left or right, never as a
 * disjoint island — and it is extended ONLY after a hole was fully fetched
 * and persisted (see `src/lib/history/price-history.ts`).
 */
export const priceHistoryCoverage = pgTable('price_history_coverage', {
  instrumentId: uuid('instrument_id')
    .primaryKey()
    .references(() => instruments.id, { onDelete: 'cascade' }),
  /** Earliest and latest day the provider has been asked about (inclusive). */
  coveredFrom: date('covered_from').notNull(),
  coveredTo: date('covered_to').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fxRates = pgTable(
  'fx_rates',
  {
    base: char('base', { length: 3 }).notNull(),
    quote: char('quote', { length: 3 }).notNull(),
    asOf: date('as_of').notNull(),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    source: text('source').notNull().default('nbp'),
  },
  (t) => [primaryKey({ columns: [t.base, t.quote, t.asOf] })],
);

/**
 * Local mirror of Nasdaq Trader's `nasdaqtraded.txt` — every US-listed stock
 * and ETF (~13k rows), refreshed daily by `/api/cron/refresh-symbols`. The
 * offline fallback for `/api/symbols/search`: Massive is the primary source,
 * this table answers when it is degraded. Deliberately separate from
 * `instruments`: that table is user-facing and first-write-wins; this one is
 * bulk-replaced machinery. All rows are USD by definition of the source file.
 */
export const symbolDirectory = pgTable('symbol_directory', {
  /** Exactly as the source file gives it (e.g. `BRK/A` stays unnormalised). */
  symbol: text('symbol').primaryKey(),
  name: text('name').notNull(),
  /** Human-readable, mapped from the file's one-letter code at parse time. */
  exchange: text('exchange').notNull(),
  type: text('type').notNull(),
  /** Stamped with the refresh run's start; rows older than a run get pruned. */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The NYSE holiday / early-close calendar, made durable. The vendor's
 * `/v1/marketstatus/upcoming` endpoint is FUTURE-only — once a closure date
 * passes it vanishes from the feed — but the backward scans over the trading
 * calendar (`extendedAttribution`, `lastCompletedSessionDateISO`) need the
 * PAST: without a durable record, the morning after Labor Day reads as an
 * ordinary trading session and a stale after-hours figure gets stamped to a
 * day the market never traded. Rows are captured write-through while the
 * vendor still advertises them and RETAINED after their date passes
 * (`src/lib/market-data/calendar-store.ts` is the only writer). Calendar
 * metadata only — timestamps and status words, never money.
 */
export const marketCalendar = pgTable('market_calendar', {
  /** NY calendar date the exception applies to, 'YYYY-MM-DD'. */
  date: date('date').primaryKey(),
  /** `'closed' | 'early-close'` — the `CalendarOverride` statuses, verbatim. */
  status: text('status').notNull(),
  /** Explicit UTC instants; the vendor publishes them for early-close days only. */
  openAt: timestamp('open_at', { withTimezone: true }),
  closeAt: timestamp('close_at', { withTimezone: true }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Since when the stored calendar can vouch for the past — the
 * `price_history_coverage` precedent: an absent `market_calendar` row is
 * otherwise ambiguous ("no closure that day" vs "never recorded"). One row
 * per market (only `'us-equities'` exists). `known_from` is SET-ONCE and
 * never moves backward: moving it would retroactively vouch for dates the
 * store never observed — attributed sessions dated before this horizon render
 * with no timestamp rather than a guessed one.
 */
export const marketCalendarCoverage = pgTable('market_calendar_coverage', {
  market: text('market').primaryKey(),
  knownFrom: date('known_from').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Stocks the user follows but does not own (M6): pure membership — ticker +
 * live price only, no target price, no notes (deliberately deferred). The
 * composite PK makes re-adding idempotent, and both FKs cascade: deleting the
 * user or the instrument silently drops the row. No money columns — the
 * instrument row carries identity, quotes stay live-only.
 */
export const watchlist = pgTable('watchlist', {
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  instrumentId: uuid('instrument_id')
    .notNull()
    .references(() => instruments.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.instrumentId] })]);

/**
 * Registered APNs device tokens (plans/2026-08-20-price-move-push-alerts.md).
 * A device may re-register — after a reinstall, or when APNs rotates the
 * token — so `POST /api/mobile/v1/push-token` upserts on the unique `token`
 * column rather than erroring. Multiple rows per user are allowed: more than
 * one device can hold the same passkey, the same way `session` allows more
 * than one concurrent session per user. `environment` is what the device
 * itself claims (sandbox for a Debug build, production otherwise) — informal
 * bookkeeping, not what selects the APNs host `src/lib/push/apns.ts` sends
 * to, since exactly one deployed environment exists.
 */
export const pushTokens = pgTable('push_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  environment: text('environment').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ix_push_tokens_user').on(t.userId)]);

/**
 * Per-user notification preferences (plans/2026-09-05-daily-portfolio-summary-push.md).
 * One row per user who has ever expressed a choice; a MISSING row means both
 * off — uniformly, forever. The backfill migration inserted a
 * `price_alerts = true` row for every `user_id` in `push_tokens`, so a device
 * registered before this table existed keeps its alerts flowing with no
 * "token exists" fallback special case for future readers to know about.
 * `daily_summary_last_sent_day` is the never-twice marker for the evening
 * summary: the NY-calendar ISO date of the last summary actually DELIVERED
 * (at least one APNs `delivered` outcome) — never merely attempted.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  priceAlerts: boolean('price_alerts').notNull().default(false),
  dailySummary: boolean('daily_summary').notNull().default(false),
  dailySummaryLastSentDay: date('daily_summary_last_sent_day'),
  morningBriefLastSentDay: date('morning_brief_last_sent_day'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Generate-once prose for one user/day/scope/report half. */
export const dayReports = pgTable(
  'day_reports',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    scopeKey: text('scope_key').notNull(),
    kind: text('kind').notNull(),
    portfolioId: uuid('portfolio_id').references(() => portfolios.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    portfolioNarrative: text('portfolio_narrative'),
    eventsNarrative: text('events_narrative'),
    macroNarrative: text('macro_narrative'),
    sources: jsonb('sources').$type<unknown>(),
    factsFingerprint: text('facts_fingerprint').notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The headline the report showed when written; read by `history.ts`,
     * never re-derived. `figure_day` is the session the figure describes
     * (the report day for `close`, the PREVIOUS session for `morning`).
     * All nullable/defaulted: a row written before these columns existed
     * lists with a dash, never a zero.
     */
    figureDay: date('figure_day'),
    dayChangePln: numeric('day_change_pln', { precision: 20, scale: 8 }),
    dayChangePct: numeric('day_change_pct', { precision: 20, scale: 8 }),
    figurePartial: boolean('figure_partial').notNull().default(false),
    /**
     * What the WRITER found (2026-09-21): a dated list of the week's events
     * for the held names and the market — earnings, ex-dividends, expiries,
     * central-bank dates, summits — and a one-line "what to watch today"
     * for the morning push. Both nullable: rows written before these columns
     * existed simply carry none.
     */
    events: jsonb('events').$type<unknown>(),
    todayLine: text('today_line'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day, t.scopeKey, t.kind] })],
);

/**
 * Hysteresis dedupe state for the 5%-in-12h price-move alert, one row per
 * (instrument, direction) that has ever been evaluated. Deliberately holds NO
 * price history — that stays fetched fresh from the vendor's intraday bars
 * each run (`src/lib/alerts/price-move.ts`), following the existing
 * intraday-bars-are-never-persisted precedent (docs/context.md §Market data).
 * `armed = true` means the next ≥5% crossing fires a push; a push flips it to
 * `false`, and only a retrace below 3% flips it back
 * (`src/lib/alerts/dedupe.ts`). A missing row is read as armed — a
 * symbol seen for the first time must be able to fire immediately, not be
 * mistaken for one that already has. No `userId`: this is a fact about the
 * instrument's recent price action, not about who is watching it.
 */
export const priceAlertState = pgTable(
  'price_alert_state',
  {
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    /** `'up' | 'down'` — validated at the write boundary; text like `side`. */
    direction: text('direction').notNull(),
    armed: boolean('armed').notNull().default(true),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.direction] })],
);

/**
 * User-set price targets (plans/2026-09-05-price-target-alerts.md): "tell me
 * when this stock reaches X", one row per line the user has drawn. Unlike
 * `price_alert_state` this IS per-user — a target is an explicit standing
 * order, not a fact about the instrument. `direction` is derived from the
 * current price at CREATION and persisted, so the cron check never has to
 * infer which way the line was meant to be crossed (a stock that gaps past
 * an 'up' target must still fire as 'up'). `hit_at` NULL means pending; it is
 * set once — only after an APNs `delivered` outcome — and never cleared,
 * which is what "a hit target never fires twice" is made of. Deletion is the
 * only way a row leaves this table.
 */
export const priceTargets = pgTable(
  'price_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    targetPrice: numeric('target_price', { precision: 20, scale: 8 }).notNull(),
    /** `'up' | 'down'` — validated at the write boundary; text like `side`. */
    direction: text('direction').notNull(),
    /** NULL = pending. Written only after a delivered push; never cleared. */
    hitAt: timestamp('hit_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_price_targets_user_instrument').on(t.userId, t.instrumentId)],
);

/**
 * Per-portfolio target weights (plans/2026-09-05-target-weights-drift.md):
 * "this stock should be 30% of this portfolio". One row per
 * (portfolio, instrument) that HAS a target — a blank target is an ABSENT
 * row, never a `0` row (a zero target would read as "sell everything",
 * which is the opposite of "no opinion"). Writes are a bulk replace through
 * `src/lib/targets/store.ts` (`db.batch` delete+inserts, the
 * `reorderPortfolios` atomicity pattern); the Analytics drift card is the
 * only reader. `numeric(7,4)` holds 0.0001–100 with the two decimal places
 * the input allows plus headroom; like every numeric it travels as a string
 * into `decimal.js`. No `userId`: ownership flows through
 * `portfolios.userId`, exactly as `transactions` does. The portfolio FK
 * cascades (deleting a portfolio takes its targets); the instrument FK does
 * not cascade a delete because instruments are never deleted.
 */
export const portfolioTargets = pgTable(
  'portfolio_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    /** Percent of the portfolio, 0 < x ≤ 100 — a share, never money. */
    targetPct: numeric('target_pct', { precision: 7, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_target_portfolio_instrument').on(t.portfolioId, t.instrumentId)],
);

/**
 * Tracked option contracts — the Options tab's ONLY positions table,
 * deliberately a standalone island: option rows never enter `instruments` or
 * `transactions`, so the position engine, Holdings, the portfolio chart,
 * `latest_quotes`, `price_snapshots` and the watchlist cannot reach them BY
 * CONSTRUCTION (every one of those walks `instruments`/`transactions` joins).
 * One row = one tracked lot; two lots of the same contract are two rows, each
 * with its own P/L — hence no unique constraint. USD-only by decision (the
 * tab's P/L is deliberately non-comparable with portfolio totals, so there is
 * no `fx_rate_to_base` and no NBP lookup). Quotes were live-only until
 * 2026-08-15 (options-summary-and-dashboard plan, user decision): real daily
 * closes are now recorded forward-only in `option_daily_closes` below — the
 * EQUITY cache tables still never hold an option price — and the
 * refresh-history cron now reaches options DELIBERATELY, best-effort, after
 * its equity loop. The island holds for option rows themselves, but since
 * 2026-08-17 the UNDERLYING equity may gain an `instruments` row, minted by
 * the ticker page's options-underlying branch through the shared
 * `resolveOrCreateInstrument` path.
 */
export const optionPositions = pgTable(
  'option_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** OCC-form vendor ticker, e.g. `O:AAPL260904C00220000`. */
    ticker: text('ticker').notNull(),
    /** Underlying stock symbol, e.g. `AAPL`. */
    underlying: text('underlying').notNull(),
    /** `'call' | 'put'` — validated at the action boundary; text like `side`. */
    contractType: text('contract_type').notNull(),
    strikePrice: numeric('strike_price', { precision: 20, scale: 8 }).notNull(),
    expirationDate: date('expiration_date').notNull(),
    /** A quantity — numeric per the money rule, never integer. */
    sharesPerContract: numeric('shares_per_contract', { precision: 20, scale: 8 })
      .notNull()
      .default('100'),
    quantity: numeric('quantity', { precision: 20, scale: 8 }).notNull(),
    /** Per share, USD — the vendor quotes per-share premiums. */
    entryPrice: numeric('entry_price', { precision: 20, scale: 8 }).notNull(),
    tradeDate: date('trade_date').notNull(),
    /**
     * Total lot costs in USD — commission + exchange fee (+ any other broker
     * charge), summed (decision, plans/2026-08-15-options-screenshot-import).
     * The P/L amount renders net of this; the percent and break-even stay
     * entry-price-only. Default '0' keeps every pre-existing row valid.
     */
    fees: numeric('fees', { precision: 20, scale: 8 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_option_positions_user').on(t.userId)],
);

/**
 * Real end-of-day option prints, recorded forward-only from 2026-08-15 (the
 * options-summary-and-dashboard plan — a deliberate REVERSAL of the original
 * "quotes are live-only" decision, and deliberately NOT named anything
 * containing `price_snapshots` so the equity-cache isolation greps stay
 * clean). One row = one contract's FINAL close on one NY trading date; a date
 * with no row means the contract did not trade that day — never interpolated,
 * never synthesized (aggregate-based recording is holiday-safe by
 * construction: no trades → no bar → no row). No `userId` (contracts are
 * global; single user by design) and no FK into `instruments` (options have
 * none — the wall). `src/lib/options/close-sync.ts` is the ONLY writer.
 */
/**
 * Since 2026-08-15 (the option-model-pricing plan) `option_daily_closes` is
 * the FALLBACK/DATING record, not the pricing record: the cards, the totals
 * and the value chart read the model MARKS in `option_daily_marks` below,
 * while these real prints keep dating a thin contract's last trade and keep
 * pricing any contract no mark could be produced for. Both tables stay;
 * `close-sync.ts` remains the only writer of this one.
 */
export const optionDailyCloses = pgTable(
  'option_daily_closes',
  {
    /** OCC-form vendor ticker, e.g. `O:ACME270319C00260000`. */
    ticker: text('ticker').notNull(),
    /** NY calendar date of the completed session, 'YYYY-MM-DD'. */
    asOf: date('as_of').notNull(),
    close: numeric('close', { precision: 20, scale: 8 }).notNull(),
    source: text('source').notNull().default('massive'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticker, t.asOf] })],
);

/**
 * One MODEL MARK per contract per completed NY session (2026-08-15, the
 * option-model-pricing plan): a Black-Scholes estimate built on the vendor's
 * own implied volatility and delta, which is what the cards, the totals and
 * the options value chart are priced from. Never a traded price — a mark is
 * an ESTIMATE and is labelled as one on every surface.
 *
 * The INPUTS are stored beside the mark deliberately: a number nobody can
 * reconstruct is not an honest record, so a past mark can be audited from the
 * spot, the IV, the delta and the recovered carry rate it came from. No
 * `userId` (contracts are global; single user by design) and no FK into
 * `instruments` (options have none — the wall). A session with no row means no
 * mark could be produced that night — an honest hole, never interpolated.
 * `src/lib/options/mark-sync.ts` is the ONLY writer.
 */
export const optionDailyMarks = pgTable(
  'option_daily_marks',
  {
    /** OCC-form vendor ticker, e.g. `O:ACME270319C00260000`. */
    ticker: text('ticker').notNull(),
    /** NY calendar date of the completed session, 'YYYY-MM-DD'. */
    asOf: date('as_of').notNull(),
    /** The model mark, per share, USD. */
    mark: numeric('mark', { precision: 20, scale: 8 }).notNull(),
    /** The underlying's spot the mark was priced from. */
    underlyingPrice: numeric('underlying_price', { precision: 20, scale: 8 }).notNull(),
    /** The vendor's IV as a fraction (0.45 = 45%). */
    impliedVolatility: numeric('implied_volatility', { precision: 20, scale: 8 }),
    /** The vendor's delta the carry rate was recovered from. */
    delta: numeric('delta', { precision: 20, scale: 8 }),
    /** The RECOVERED carry rate as a fraction — legitimately negative on a
     *  dividend-heavy name (ZORA measured −0.22%). */
    rate: numeric('rate', { precision: 20, scale: 8 }),
    source: text('source').notNull().default('bs-model'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticker, t.asOf] })],
);

/**
 * News articles, persisted at fetch time (2026-08-16, watchlist-news-module
 * plan). Persistence is NOT an optimization: the vendor's news endpoint has
 * no working fetch-by-id (`?id=` is silently ignored and the newest article
 * comes back instead — verified live 2026-08-16), so the moment an article is
 * shown, this table is the ONLY source that can reliably serve that exact
 * article again. The detail page and the image proxy therefore read the
 * database exclusively. `src/lib/news/store.ts` is the ONLY writer (the
 * `calendar-store.ts` rule); rows older than 90 days are pruned on the write
 * path. No money columns anywhere — titles, URLs and timestamps only.
 * `keywords`/`insights` hold the vendor arrays verbatim (validated loosely at
 * write, parsed defensively at read).
 */
export const newsArticles = pgTable('news_articles', {
  /** The vendor's own hex id — the identity the detail route is keyed by. */
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author'),
  publisherName: text('publisher_name'),
  publisherHomepage: text('publisher_homepage'),
  /**
   * Vendor-hosted publisher logo/favicon URLs (2026-08-16, massive-tier0
   * plan), stored verbatim at fetch time — nullable, additive; rows written
   * before the columns existed honestly keep NULL (the 90-day prune retires
   * them). Served ONLY through `/api/news/publisher-logo/[id]`, which
   * enforces the vendor-origin + scheme + content-type gates at fetch time —
   * these URLs never reach a client.
   */
  publisherLogoUrl: text('publisher_logo_url'),
  publisherFaviconUrl: text('publisher_favicon_url'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  articleUrl: text('article_url').notNull(),
  imageUrl: text('image_url'),
  /** The vendor's AI summary — the whole body text; no full article exists. */
  description: text('description'),
  keywords: jsonb('keywords').$type<unknown>(),
  insights: jsonb('insights').$type<unknown>(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per (article, ticker) the vendor tagged — the feed's join surface:
 * "articles about my symbols" is a ticker-indexed lookup here, never a scan
 * of a jsonb column. Cascade delete keeps pruning a single statement.
 */
export const newsArticleTickers = pgTable(
  'news_article_tickers',
  {
    articleId: text('article_id')
      .notNull()
      .references(() => newsArticles.id, { onDelete: 'cascade' }),
    ticker: text('ticker').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.ticker] }),
    index('ix_news_article_tickers_ticker').on(t.ticker),
  ],
);

/**
 * Cash-dividend payments (2026-08-16, dividends plan) — a tax-filing-grade
 * record, so gross and withheld tax are stored SEPARATELY (net is always
 * derived `gross − withheld`, never stored) and the złoty rate is FROZEN per
 * payment at the D-1 NBP rate of `pay_date ?? ex_date` (null until NBP
 * publishes; retried on the next sync, never guessed).
 *
 * `src/lib/dividends/store.ts` is the ONLY reader/writer (the
 * `calendar-store.ts` convention). The overwrite-protection rule lives there:
 * a row with `edited = true` or `source = 'manual'` is NEVER touched by an
 * automatic refresh — the user's correction always wins.
 *
 * `vendor_event_id` is the vendor's own dividend-event id, the dedupe key per
 * portfolio; NULL on manual rows, which the unique constraint exempts by
 * Postgres multi-NULL semantics — duplicate manual entry is the user's own to
 * manage, and no synthetic key is invented.
 */
export const dividendPayments = pgTable(
  'dividend_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    /** The vendor's dividend-event id; null for manually added rows. */
    vendorEventId: text('vendor_event_id'),
    exDate: date('ex_date').notNull(),
    /** Vendor rows can omit it — FX and ordering then use `ex_date`. */
    payDate: date('pay_date'),
    /** Shares held at the end of the day BEFORE the ex-date. */
    quantity: numeric('quantity', { precision: 20, scale: 8 }).notNull(),
    /** Per share, in `currency`. */
    amountPerShare: numeric('amount_per_share', { precision: 20, scale: 8 }).notNull(),
    grossAmount: numeric('gross_amount', { precision: 20, scale: 8 }).notNull(),
    /** Withheld at source. Defaults to 15% of gross at row CREATION only —
     *  a starting value per row, not a law; edited freely thereafter. */
    withheldTax: numeric('withheld_tax', { precision: 20, scale: 8 }).notNull().default('0'),
    currency: char('currency', { length: 3 }).notNull(),
    /** D-1 NBP rate at `pay_date ?? ex_date`, frozen; NULL until published. */
    fxRateToBase: numeric('fx_rate_to_base', { precision: 20, scale: 10 }),
    /** `'massive' | 'manual'` — validated at the write boundary; text like `side`. */
    source: text('source').notNull(),
    /** A human touched this row — the refresh must never overwrite it. */
    edited: boolean('edited').notNull().default(false),
    /**
     * Tombstone (2026-08-16 fix): deleting a VENDOR-sourced payment keeps the
     * row with this flag set, so its `(vendor_event_id, portfolio_id)` key
     * stays occupied and the next sync — whose ledger walk would still derive
     * qty > 0 for that ex-date — can never re-insert what the user removed. A
     * deletion wins over a refetch exactly the way an edit does. Manual rows
     * (null vendor id) hard-delete instead: nothing can ever re-create them.
     * Additive column; the store never surfaces tombstoned rows.
     */
    deleted: boolean('deleted').notNull().default(false),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_dividend_vendor_portfolio').on(t.vendorEventId, t.portfolioId),
    index('ix_dividend_instrument_exdate').on(t.instrumentId, t.exDate),
    index('ix_dividend_portfolio').on(t.portfolioId),
  ],
);

export const schema = {
  user,
  session,
  account,
  verification,
  passkey,
  portfolios,
  instruments,
  transactions,
  latestQuotes,
  priceSnapshots,
  priceHistoryCoverage,
  fxRates,
  symbolDirectory,
  marketCalendar,
  marketCalendarCoverage,
  watchlist,
  pushTokens,
  notificationPreferences,
  dayReports,
  priceAlertState,
  priceTargets,
  portfolioTargets,
  optionPositions,
  optionDailyCloses,
  optionDailyMarks,
  newsArticles,
  newsArticleTickers,
  dividendPayments,
};
