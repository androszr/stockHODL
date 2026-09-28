# Publishing

This repository is public, and it is the one you work in. There is no
separate private copy to export from any more: every commit pushed to `main`
is published the moment it lands, and it deploys.

- `origin` is `androszr/stockhodl`, public. Its history starts at one
  "Initial public release" commit; nothing from before it is here.
- The old private repository is `androszr/stockhodl-archive`, archived
  (read-only) with every workflow switched off. A checkout that moved over
  in place keeps it as the remote `archive` and its full history in a local
  branch `private-main`. Nothing is ever pushed to it again.

## Before every push

A push is a publication, and a public push cannot really be taken back —
clones and caches keep what they saw. So before `git push`, rehearse the
export; it runs the same checks the first public copy passed:

```bash
scripts/export-public.sh --dry-run --check-only
```

Expect `export-public: check-only — every check passed; no repository was
created and nothing was committed`. It copies the tree to a temporary folder
and scans it: the forbidden-content scan against `.private-strings` (the
git-ignored file listing your real figures and handles, one per line),
Gitleaks with the repository's `.gitleaks.toml`, and the structural checks
(no `plans/`, `.gitnexus/`, `.dark-army/`, `.env` or `.private-strings` in
the tree). Gitleaks is required: `brew install gitleaks` if it stops with
exit 4.

If it stops with `forbidden content in the copy`, it prints every offending
line with its file. Fix those before pushing.

Pictures are not scanned. A screenshot of the real portfolio passes every
check above, so keep captures made from real data in `docs/design/`, which
is git-ignored, and let only the invented-book pictures under `docs/images/`
be tracked.

## What a push to `main` sets off

- **CI** and **Deploy** — every push that touches anything outside `ios/`.
  Deploy runs the migrations against `DATABASE_URL`, then the production
  deploy to Vercel. A change to a Vercel environment variable only takes
  effect on the next deploy.
- **iOS** — every push that touches `ios/`.
- **TestFlight** — every push that touches `ios/`, its own workflow file or
  the two build-number scripts, and **Run workflow** on the Actions tab.
  It refuses to upload until Deploy has put the server side of the same
  commit in production (waiting for a Deploy still running), so the phone
  never runs ahead of the API it speaks.
- **Price alerts** — on its schedule, not on a push. GitHub switches
  scheduled workflows off in a public repository after 60 days without a
  push; a push, or re-enabling it on the Actions tab, turns it back on.

## Secrets come from their source

[docs/setup.md](setup.md) §6 lists every secret and variable and where each
one comes from. Take each value from that source, never from
`.env.production.local`: `vercel env pull` writes the same short
placeholder for every variable marked Sensitive in Vercel, including
`DATABASE_URL` and `CRON_SECRET`, and a secret copied from it fails at
run time rather than when it is set. In particular:

- `APPLE_TEAM_ID` is the ten-character team in brackets on your Apple
  Distribution certificate, the same value as `DEVELOPMENT_TEAM` in
  `ios/Config/Base.xcconfig`.
- `DATABASE_URL` is the pooled connection string (host ending in `-pooler`)
  for the production branch, from the Neon console's **Connect** dialog.
- `CRON_SECRET` cannot be read back from Vercel. To replace it, generate a
  new one and set it in both places, then deploy:

  ```bash
  NEW=$(openssl rand -hex 32)
  printf '%s' "$NEW" | gh secret set CRON_SECRET -R androszr/stockhodl
  vercel env rm CRON_SECRET production --yes
  printf '%s' "$NEW" | vercel env add CRON_SECRET production
  unset NEW
  ```
- `ASC_KEY_ID` and `ASC_PRIVATE_KEY` must be the same key: the ID is the
  part of the `.p8` file's name after `AuthKey_`.

## The TestFlight build number

The build number is `IOS_BUILD_NUMBER_OFFSET` plus the workflow's run
number, and App Store Connect refuses a number it already holds. The
workflow refuses to run with the variable unset.

- **Set it once per repository.** A repository taking over an existing app
  sets it to the highest build number App Store Connect already holds for
  the current version (App Store Connect → the app → **TestFlight**; open
  **Build Uploads** too, since builds still processing count). A brand-new
  app sets `0`, explicitly. `androszr/stockhodl` took over at 34.
- **Leave it alone afterwards.** Change it only when the run counter starts
  again at 1 — another new repository, or the workflow deleted and
  recreated — and then by the same rule.
- **Only one repository uploads at a time.** Before another repository takes
  over, disable TestFlight in the one handing over (**Actions → TestFlight →
  ⋯ → Disable workflow**); two would hand out the same numbers.
- **Retry with a new run, never a re-run.** A re-run reuses the run number,
  and the failed attempt may already have uploaded under it, so the
  workflow refuses it (`this is attempt 2 …`). After a failure press
  **Actions → TestFlight → Run workflow**. A number used by a failed run is
  simply skipped.

## The doors a public repository opens

Both are set on `androszr/stockhodl`; check them again if the repository is
ever recreated.

- **Settings → Advanced Security** → **Private vulnerability reporting** on,
  which is where [SECURITY.md](../SECURITY.md) sends people.
- **Settings → Actions → General** → *Fork pull request workflows from
  outside collaborators* → **Require approval for all outside
  collaborators**.

## Screenshots

The README's pictures are drawn from an invented portfolio (about 70 238 zł,
eight stocks, two calls). Retake them when the screens change, from the
repository root:

```bash
python3 tools/demo_shots.py all
```

Expect four pictures under `docs/images/` and `check: invented book`. The
simulator it creates is deleted when the run finishes. Never point it at the
real portfolio.
