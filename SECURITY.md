# Security

StockHODL is a single-user portfolio tracker: an iPhone app over a small API
host on Vercel, holding one person's trades. This page says what the server
answers, how a caller proves who it is, what it sends out, what it stores, and
how to report a problem. The architecture behind each point is in
[docs/context.md](docs/context.md).

## Reporting a problem

If you find a way past any boundary on this page, please report it privately
through GitHub's **Report a vulnerability** button on the repository's
Security tab, rather than in a public issue. Say what you did, what you
expected and what happened; a short reproduction is the most useful thing you
can send, and please give a fix time to ship before sharing the details
publicly.

## What listens

- **A JSON surface and nothing else.** The server answers `/api/auth/*`
  (Better Auth), `/api/mobile/v1/*` (the phone's API), `/api/cron/*` (the
  scheduled jobs) and the Associated Domains file at
  `/.well-known/apple-app-site-association`. There is no website: apart from
  Next's own build assets under `/_next/`, every other path answers 404 — with an empty body when no session cookie is sent, and
  with a blank page (the root layout around a not-found that renders
  nothing) when one is.
- **Every door checks for itself.** `src/proxy.ts` is only an optimistic
  cookie check in front of the rest; each handler under `/api/mobile/v1/*`
  resolves the session itself and answers 401 without one, with
  `Cache-Control: private, no-store` on every answer.
- **Unsafe writes are origin-checked.** A cookie-authenticated write that does
  not name this exact origin is refused (`isCrossSiteWrite`); bearer requests
  are exempt because a browser never attaches that header by itself.

## How a caller is authenticated

- **Passkey-only.** Better Auth with the passkey plugin. There is no password
  and no second factor in normal operation, so there is no standing credential
  to phish, stuff or reuse.
- **One user, ever.** `ALLOWED_EMAIL` is enforced by two independent gates in
  `src/lib/auth.ts` — a request hook and a database hook — plus a refusal of any
  second user row. Either gate alone is sufficient.
- **The phone holds a signed bearer token in the Keychain.** The token is the
  signed `set-auth-token` value (`bearer({ requireSignature: true })`), so the
  raw session id stored in the database does not authenticate on its own.
  Sign-out revokes the session on the server and purges the Keychain whether
  or not the revoke reached the server.
- **Scheduled jobs use `CRON_SECRET`.** Every `/api/cron/*` route goes through
  one shared gate (`src/lib/api/cron/gate.ts`): 503 when the secret is not
  configured, 401 unless the `Authorization` header is exactly
  `Bearer <secret>`, compared as SHA-256 digests under `timingSafeEqual`. A
  test fails if a cron route stops using the gate.
- **Break-glass is a local CLI, not a route.** `scripts/recover.ts` sets a
  temporary password offline; `RECOVERY_MODE=1` (read at build time, so it
  takes a redeploy) turns password sign-in on only for as long as it takes to
  enroll a new passkey. At `RECOVERY_MODE=0` the password path is disabled.
- **Sign-in attempts are rate-limited** by Better Auth's built-in limiter,
  in memory per serverless instance.

## What reaches out

All from the server; the phone never contacts a vendor.

- **Massive** (`api.massive.com`) for 15-minute-delayed US quotes, bars, search
  and news, with the `STOCK_API` key. Brand logos and news images are proxied
  through the API host so the key and the vendor hosts never reach the phone.
- **NBP** (`api.nbp.pl`) for the USD/PLN mid rate.
- **Anthropic** (optional, `ANTHROPIC_API_KEY`) for screenshot import and the
  day report's written sections. A screenshot you import is sent to it; nothing
  else from your portfolio is, apart from the figures the day report is
  written from.
- **Apple Push Notification service** (optional, `APNS_*`) for price alerts,
  the morning brief and the close summary. A push carries the ticker or the
  day's figure you asked to be told about, in plaintext as far as Apple.

## What is stored

- **On the server (Neon Postgres):** your trades, option lots, dividends,
  portfolios, watchlist, price targets, the written day reports, notification
  preferences, push device tokens, the Better Auth user, session and passkey
  rows, and caches of public market data (daily closes, NBP rates, the symbol
  directory, the market calendar).
- **On the phone:** the session token in the Keychain (shared with the widget
  extension through one access group), the last live payload in the App Group
  container for the widgets, and re-fetchable disk caches. Sign-out clears all
  three.

## Single user by design

There is no sign-up, no second account and no admin role, and there never will
be. A change that widens who can get in is the most serious bug this project
can have.

## Headers and CSP

Set in `next.config.ts`: a strict Content-Security-Policy (`default-src
'self'`, `connect-src 'self'`, `frame-ancestors 'none'`), HSTS with preload,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, a minimal
`Permissions-Policy` and `X-DNS-Prefetch-Control: off`.

## Secrets

Only in the Vercel project environment and GitHub Actions secrets. None is
ever in the repository, and every module that reads one imports `server-only`,
so it cannot end up in a client bundle. [.env.example](.env.example) lists
every setting the server reads, with placeholder values.
