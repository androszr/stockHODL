<!-- BEGIN DARK ARMY PACK — managed, edits here are overwritten -->
# Review profile — stock-follow

Read by the `/review` skill. Names this project's reviewer and what "risky"
means here, so a review is about *this* codebase rather than generic.

```yaml
reviewer_agent: sf-app-reviewer
gitnexus_repo: finance-app
```

**`gitnexus_repo` is the name GitNexus indexed this project under** — the git
remote's name, which is often not the folder name. A GitNexus call made
against the wrong name finds nothing and looks exactly like a clean review.
`npx gitnexus analyze` prints the name it used; `list_repos` confirms it.

## Risk domains

These are the project's own conventions (`docs/context.md`). A change that
weakens one is a finding even when the tests pass.

- **Money is never a `Double`.** Amounts go through the money module to
  `Decimal`. **Lead with this one**: the damage is silent and cumulative.
  Plain-language framing: "the numbers would be slightly wrong in a way
  nobody notices until they do not add up."
- **Entitlements and plists in pairs.** Debug and Release twins that drift ship
  a distribution build quietly missing a capability — the widget stops seeing
  the keychain, a passkey ceremony fails, with no error anywhere.
- **Privacy strings.** An undeclared, reachable TCC gate is an app that
  vanishes mid-typing.
- **ATS exceptions.** Cleartext in a shipping plist is a rejected review or a
  silent downgrade.
- **Persisted state, both directions.** A new key without a default, a
  keychain shape changed without migration — one absent field blanks the
  screen.
- **Background work.** An unregistered task never runs; a handler that never
  completes gets the app throttled.
- **Push.** The sandbox APNs entitlement in a distribution build uploads fine
  and silently receives nothing.
- **Main-actor discipline.** A blocking wait on the main actor is a frozen
  screen that reads as an ignored tap.


## Notes for the reviewer

- `never_ship_without`: a test that fails before the fix, for anything in the
  hermetic half; a stated manual check, written as steps, for the rest.
- The house style is **fail closed**: ambiguity refuses rather than guesses. A
  change that makes an ambiguous case resolve to "first match" is a finding.
<!-- END DARK ARMY PACK -->

# Review profile — stock-follow

Read by the `/review` skill. Names this project's reviewer and what "risky"
means here, so a review is about *this* codebase rather than generic.

```yaml
reviewer_agent: sf-security-reviewer
gitnexus_repo: finance-app
```

**`gitnexus_repo` is not the folder name here** — this project is indexed as
`finance-app`. A GitNexus call made against `stock-follow` finds nothing and
looks exactly like a clean review.

## Risk domains

These are the project's own non-negotiables (`CLAUDE.md`). A change that weakens
one is a finding even when the tests pass.

- **Money is never a float.** Postgres `numeric` → string → `decimal.js` through
  `src/lib/money.ts`. A `parseFloat` or `Number()` on a price, quantity, fee or
  FX rate is a bug, full stop. **Lead with this one**: the damage is silent and
  cumulative — rounding that looks right on screen and drifts in the totals.
  Plain-language framing: "the numbers would be slightly wrong in a way nobody
  notices until they do not add up."
- **Market data is server-mediated.** A client component calling Massive, NBP or
  any other vendor directly. That is both a key-exposure and a rate-limit
  problem in one.
- **The two allowlist gates in `src/lib/auth.ts` stay intact.** This app has
  exactly one user, forever. Any change that widens who can get in is the most
  serious thing a review here can find.
- **`server-only` on anything reading `process.env` or the database.** Its
  absence is how a secret reaches the client bundle.
- **Migrations are additive.** They run *before* the new code deploys, so a
  destructive change has to be split across two deploys. A single-deploy
  destructive migration is a production outage with data loss, not a style
  point.
- **Secrets and injection.** Keys or tokens in the client bundle, unparameterised
  SQL, unvalidated input reaching a vendor call.
- **Cookie flags, CSP and headers.** Regressions here are invisible until they
  are exploited.
- **One human surface.** A UI change works on every iPhone size the app supports; there is no second shell to keep in step.
- **No hardcoded colors.** `src/styles/tokens.css` is the only file allowed a
  color literal.

## Notes for the reviewer

- `never_ship_without`: for anything touching money or auth, a test that fails
  before the fix.
- Auth and money findings are worth a card even when small. Everything else
  should clear the "concrete input → wrong output" bar like any other finding.
