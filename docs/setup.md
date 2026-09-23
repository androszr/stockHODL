# Setup — from clone to signed in

Everything in the repository is done; these are the steps that need your own
accounts. Roughly 30 minutes for the server, longer the first time for the
Apple side. You need Node 24 with pnpm 11, and a Mac with Xcode 26 for the
iPhone app.

Clone it first — step 4 is where your copy gets its own GitHub repository:

```bash
git clone https://github.com/<you>/stockhodl.git && cd stockhodl
pnpm install
```

## 1. Local

```bash
cp .env.example .env
openssl rand -base64 48        # → BETTER_AUTH_SECRET
openssl rand -hex 24           # → CRON_SECRET
```

Set `ALLOWED_EMAIL` to your address — it is the only email that can ever hold
an account. Leave `BETTER_AUTH_URL=http://localhost:3000` and `RECOVERY_MODE=0`
for now.

> `.env` vs `.env.local`: both work, and `.env.local` wins when a variable is
> in both — for `pnpm dev` (Next.js) **and** for `pnpm db:migrate`
> (`drizzle.config.ts` loads them in the same order). Keep `DATABASE_URL` in
> one place so the app and migrations can never point at different databases.

## 2. Neon

1. neon.tech → new project, in the region closest to the Vercel region you
   will pick (the author uses **eu-central-1**, Frankfurt, beside Vercel's
   **fra1**).
2. Copy the **pooled** connection string into `DATABASE_URL` in `.env`.
3. Apply the schema:

```bash
pnpm db:migrate
```

That creates every table from the migrations under `drizzle/`.

## 3. First passkey (locally, before deploying)

There is no sign-up form by design — the first session comes from the break-glass
script, finished on the iPhone.

```bash
pnpm recover 'pick-a-long-throwaway-password'
```

Then set `RECOVERY_MODE=1` in `.env`, and:

```bash
pnpm dev
```

Run the iPhone app on the simulator (its Debug build talks to
`http://localhost:3000`) → **Emergency password** with your allowlisted email
and that password → **Settings → Passkeys → Add a passkey**. Then set
`RECOVERY_MODE=0` and restart. Password sign-in is now gone; the passkey works.

> A computer browser and a phone browser both show a blank not-found page.
> There is no website login.

## 4. Fork or clone

Your copy needs its own GitHub repository so the workflows run against your
secrets. Either fork it on GitHub, or create an empty repository and push the
clone to it:

```bash
gh repo create stockhodl --source=. --remote=origin --push   # or create it in the web UI
```

(`gh` is GitHub's command-line tool — `brew install gh` — or use the web UI and
`git remote set-url origin <your repository URL>` followed by `git push -u origin main`.)

## 5. Vercel

1. vercel.com → Add New → Project → pick your repository. The framework is
   detected as Next.js. Deployments are done by the `Deploy` workflow, not by
   Vercel's Git integration (`vercel.json` switches that off for `main`).
2. Region: the one beside your Neon database (**fra1** for Frankfurt).
3. Environment variables (Production):
   - required: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ALLOWED_EMAIL`,
     `STOCK_API` (your Massive key — the build fails without it),
     `RECOVERY_MODE=0` and `BETTER_AUTH_URL=https://<your-domain>`;
   - `CRON_SECRET` — without it every scheduled job answers "not configured";
   - optional: `ANTHROPIC_API_KEY` (screenshot import and the day report's
     written sections), `APPLE_APP_ID` (`<Team ID>.<bundle id>`, once you have
     an Apple Developer account — it switches on the Associated Domains file
     the phone's passkeys need), and the five push keys `APNS_KEY_ID`,
     `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`.
   [.env.example](../.env.example) says what each one is.
4. Link the project locally once, which writes `.vercel/project.json` with the
   two ids step 6 needs:

```bash
vercel link
```

> **`BETTER_AUTH_URL` is the WebAuthn relying party ID.** Changing the domain
> later invalidates every passkey you have registered. Decide on the final
> hostname now — including whether you want a custom domain — rather than
> enrolling passkeys against `*.vercel.app` and migrating later.

> **Massive key.** The Starter tier is enough: unlimited REST and
> 15-minute-delayed data. Indices are not included on it, which is why the
> market strip shows SPY, QQQ and DIA instead of the S&P 500, Nasdaq and Dow.

## 6. CI/CD secrets

In GitHub → Settings → Secrets and variables → Actions:

| Kind | Name | Where to get it | Used by |
|---|---|---|---|
| Secret | `VERCEL_TOKEN` | Vercel → Account Settings → Tokens | `deploy.yml` |
| Secret | `VERCEL_ORG_ID` | `.vercel/project.json` after `vercel link` | `deploy.yml` |
| Secret | `VERCEL_PROJECT_ID` | same file | `deploy.yml` |
| Secret | `DATABASE_URL` | Neon pooled string | `deploy.yml` (migrations) |
| Secret | `NEON_API_KEY` | Neon → Account settings → API keys | `deploy.yml` (a branch database per pull request) |
| Variable | `NEON_PROJECT_ID` | Neon project dashboard | `deploy.yml` |
| Secret | `CRON_SECRET` | the same value as in Vercel | `price-alerts.yml` |
| Secret | `ASC_KEY_ID` | App Store Connect → Users and Access → Integrations → a key with the **Admin** role | `testflight.yml` |
| Secret | `ASC_ISSUER_ID` | the same page | `testflight.yml` |
| Secret | `ASC_PRIVATE_KEY` | the `.p8` file of that key | `testflight.yml` |
| Secret | `IOS_DIST_P12` | one `.p12` exported from Keychain Access holding BOTH your Apple Development and Apple Distribution certificates, base64-encoded | `testflight.yml` |
| Secret | `IOS_DIST_P12_PASSWORD` | the password you gave that export | `testflight.yml` |

Then create the **`production`** environment: Settings → Environments → New
environment → `production`. The production deploy job runs in it.

`ci.yml` runs on every push to `main` and every pull request and needs none of these.
`deploy.yml` needs the first six; `testflight.yml` the five App Store ones;
`price-alerts.yml` only `CRON_SECRET`.

## 7. Enroll a passkey on your phone

Open the iPhone app. If the passkey synced via iCloud Keychain it will just
work; otherwise use Emergency password (with `RECOVERY_MODE=1`) then
Settings → Passkeys → Add a passkey.

**Register at least two devices.** Passkey-only means no fallback in normal
operation — with two enrolled, losing a phone is an inconvenience. With one, it
means running `scripts/recover.ts` against production.

## 8. Make it yours

The repository is wired to the author's production host
(`sawa-finance.vercel.app`), Apple team and bundle id. Change each of these to
yours before a device build or a deploy of your own:

| Where | What to change |
|---|---|
| `ios/Config/Base.xcconfig` | `DEVELOPMENT_TEAM`, `KEYCHAIN_ACCESS_GROUP`, `KEYCHAIN_SERVICE`, `APP_GROUP` |
| `ios/StockHODL.xcodeproj/project.pbxproj` | `PRODUCT_BUNDLE_IDENTIFIER` for the app, the widgets and the tests (or set them in Xcode's Signing & Capabilities) |
| `ios/Config/Debug.xcconfig` | `API_BASE_URL[sdk=iphoneos*]` — the host a Debug build on a real phone talks to |
| `ios/Config/Release.xcconfig` | `API_BASE_URL` — the host TestFlight builds talk to |
| `ios/Config/Info.plist`, `ios/Config/Info-Debug.plist` | the URL-type identifier (`…pushdeeplink`) |
| `ios/Config/StockHODL.entitlements`, `ios/Config/StockHODL-Release.entitlements` | `webcredentials:<your host>` and the App Group |
| `ios/Config/StockHODLWidgets.entitlements` | the App Group |
| `ios/Config/ExportOptions.plist` | `teamID` |
| `ios/StockHODL/Auth/PasskeyController.swift`, `ios/StockHODL/Notifications/PushDeepLink.swift` | comments naming the host (documentation only) |
| `.github/workflows/price-alerts.yml` | the host in the `url = …` line |
| Vercel env | `BETTER_AUTH_URL` and `APPLE_APP_ID` |
| `ios/StockHODLTests/APIClientTests.swift`, `AuthFlowTests.swift`, `PasskeysStoreTests.swift`, `WebAuthnTests.swift`, `WidgetDataSourceTests.swift` | the host the tests pin |

`python3 scripts/check-entitlements.py` then confirms the Debug and Release
entitlements still agree.

## Checking it worked

```bash
curl -sI https://<your-domain>/ | grep -Ei 'strict-transport|content-security-policy'
curl -sI https://<your-domain>/ | grep -Ei '^HTTP/'   # → 404 when signed out
gh run list --limit 4                                   # CI and Deploy green
```

Both headers present, unauthenticated `/` a blank not-found (not a sign-in
form), a passkey sign-in working on the iPhone, and `CI` plus `Deploy` green
after a push to `main`.
