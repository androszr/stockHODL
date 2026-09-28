# Publishing a fresh copy of this repository

The public repository is not this one with its history rewritten. It is a
fresh copy with a single "initial" commit, built by `scripts/export-public.sh`
from the working tree, in a folder beside this checkout. The private
repository stays as it is, as the archive.

Every step below is yours to take; the script and this page never push,
never change a repository's visibility and never touch a secret on your
behalf.

1. **Run the gates, rehearse, then export.** In this checkout, run
   `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. Then rehearse
   the export without creating anything:

   ```bash
   scripts/export-public.sh --dry-run --check-only
   ```

   Expect `export-public: check-only — every check passed; no repository was
   created and nothing was committed`. It builds the copy in a temporary
   folder and runs every check on it — the forbidden-content scan, Gitleaks
   (with the copy's own `.gitleaks.toml`, which allows only the invented cron
   test secret in its one test file), and the structural checks — then stops
   before `git init`. Gitleaks is required here: without it the rehearsal
   stops with `gitleaks is not installed` (exit 4) rather than pass without
   a secret scan — `brew install gitleaks`, then run it again. (A normal
   export without Gitleaks carries on but prints `the secret scan was
   SKIPPED`; do not publish on that.) Plain `--dry-run`
   without `--check-only` is not a rehearsal: it still makes the commit, in
   the temporary folder. When the rehearsal is clean:

   ```bash
   scripts/export-public.sh --out ../stockhodl
   ```

   Expect a four-line summary ending in `export-public: commits: 1`, and no
   `no .private-strings` warning — that file (git-ignored, one real figure or
   handle per line) is what the scan checks your private numbers against. If it
   stops with `forbidden content in the copy`, it prints every offending
   line with its file; fix those in this checkout, empty `../stockhodl`, and
   run it again. Nothing was committed. (Pick another folder name with
   `--out` if you like; `--dry-run` builds into a temporary folder instead.)

2. **Check who the commit is from.** Run
   `git -C ../stockhodl log -1 --format=%ae`. Expect
   `13721474+androszr@users.noreply.github.com`, GitHub's no-reply address for
   your account, so no personal email is published. To use another address,
   empty the folder and re-run the export with
   `EXPORT_AUTHOR_EMAIL=<address> scripts/export-public.sh --out ../stockhodl`
   (and `EXPORT_AUTHOR_NAME` for the name).

3. **Create the public repository, without pushing yet.** Run:

   ```bash
   gh repo create stockhodl --public --source=../stockhodl --remote=origin
   ```

   Or on github.com press **New repository**, name it, choose **Public**,
   leave every "Initialize" box unticked, then run only its
   `git remote add origin …` line from inside `../stockhodl`. Do not push
   yet: the first push starts CI, Deploy and TestFlight, and they need the
   secrets, the build-number variable and the environment from steps 4 and
   5 first. Expect an empty
   repository page on GitHub.

4. **Re-add the deployment secrets.** On the new repository open
   **Settings → Secrets and variables → Actions**. Under **Secrets**, press
   **New repository secret** for each of `ASC_ISSUER_ID`, `ASC_KEY_ID`,
   `ASC_PRIVATE_KEY`, `CRON_SECRET`, `DATABASE_URL`, `IOS_DIST_P12`,
   `IOS_DIST_P12_PASSWORD`, `NEON_API_KEY`, `VERCEL_ORG_ID`,
   `VERCEL_PROJECT_ID` and `VERCEL_TOKEN`, with the same values as in the
   private repository. Under **Variables**, add `NEON_PROJECT_ID`, and
   `IOS_BUILD_NUMBER_OFFSET` as step 5 describes. Then open
   **Settings → Environments**, press **New environment** and name it
   `production`. Expect eleven secrets, two variables and one environment
   listed. [docs/setup.md](setup.md) §6 says where each value comes from.

5. **Carry the TestFlight build number over, before the first push.** The
   build number is `IOS_BUILD_NUMBER_OFFSET` + the workflow's run number, and
   the run number starts again at 1 in the new repository — below the builds
   App Store Connect already holds, which it refuses. The workflow refuses to
   run with the variable unset.
   - **The private repository needs the variable too, today.** Before you
     push this change there, add `IOS_BUILD_NUMBER_OFFSET` with the value
     `0` to the private repository (**Settings → Secrets and variables →
     Actions → Variables**) — otherwise its next push under `ios/` stops red
     at "Choose the build number". Zero is right there because its run
     counter already continues past every build it uploaded. The non-zero
     migration offset below is only for a repository whose counter starts
     again at 1.
   - **Stop releases from the old repository first.** In the private
     repository open **Actions → TestFlight → ⋯ → Disable workflow**. Only
     one repository may upload at a time; two would hand out the same
     numbers.
   - **Read the highest build already used.** In App Store Connect open the
     app → **TestFlight**, and read the largest build number under the
     current version (0.1 at the time of writing). Use what it says on the
     day — the last build was 29 when this was written, but do not assume it
     still is.
   - **Set the offset to that number.** In the new repository, under
     **Settings → Secrets and variables → Actions → Variables**, add
     `IOS_BUILD_NUMBER_OFFSET` with it. With 29, the first run uploads build
     30 and the second 31.
   - **Leave it alone afterwards.** The offset is fixed for the life of that
     repository and its TestFlight workflow. Change it only when the run
     counter restarts again (another new repository, or the workflow deleted
     and recreated), and then by the same steps. A brand-new app with no
     builds sets `0` — explicitly; unset is refused.
   - **Retry with a new run, never a re-run.** A re-run reuses the run number,
     and the failed attempt may already have uploaded under it, so the
     workflow refuses it (`this is attempt 2 …`). After a failure — even one
     before signing — press **Actions → TestFlight → Run workflow**.

6. **Lock the doors a public repository opens.**
   - **Settings → Code security** (or *Advanced Security*) → enable
     **Private vulnerability reporting**. Expect a **Report a vulnerability**
     button on the Security tab, which is where [SECURITY.md](../SECURITY.md)
     sends people.
   - **Settings → Actions → General** → under *Fork pull request workflows
     from outside collaborators*, choose **Require approval for all outside
     collaborators**. Expect no workflow to run on a stranger's pull request
     until you approve it.
   - Note: GitHub switches off scheduled workflows (the price-alerts trigger)
     in a public repository after 60 days without a push. A push, or
     re-enabling the workflow on the Actions tab, turns it back on.

7. **Move your working copy over.** Copy the local-only files the export
   leaves out into the new folder:

   ```bash
   cp .env .env.production.local .private-strings ../stockhodl/
   cp assets/illustrated/look-reference.jpg ../stockhodl/assets/illustrated/
   cp -R .vercel .dark-army ../stockhodl/
   cp -R plans ../stockhodl/      # optional — it is ignored there too
   cd ../stockhodl && pnpm install && pnpm ios:gen && git status
   ```

   Expect `git status` to say the working tree is clean: all of these are ignored,
   and the regenerated Swift matches what was committed.

8. **Point Dark Army at the new folder.** In Dark Army open
   **Settings → Projects** → **Enrol a folder…** and pick `../stockhodl`.
   Expect the project's tab on **Agents**, and new cards starting there.

9. **Push, and deploy from the new repository.** If Vercel complains about
   the project link, run `vercel link` inside `../stockhodl` and check that
   `.vercel/project.json` names the same project id as the
   `VERCEL_PROJECT_ID` secret. Then, inside `../stockhodl`, run
   `git push -u origin main`. This first push runs **CI** and **Deploy** (and
   TestFlight, because it contains `ios/`): check with `gh run list --limit 4`
   about two minutes later and expect `CI` and `Deploy` green. Expect the
   repository page showing one commit and the README with the bull icon.
   The TestFlight run's summary names its build: the offset from step 5
   plus 1 (30, with an offset of 29).

10. **Retake the screenshots when the screens change.** They are already
    in the README, drawn from an invented portfolio (about 70 238 zł, eight
    stocks, two calls). From the repository root:

    ```bash
    python3 tools/demo_shots.py all
    ```

    Expect four pictures under `docs/images/` and `check: invented book`.
    The simulator it creates is deleted when the run finishes. Never point
    it at the real portfolio.

11. **Leave the archive alone.** The private archive repository stays
    private and untouched. Optionally add one line to its description saying where the
    public repository lives.

What this runbook does not do: it never pushes, never changes a repository's
visibility and never touches secrets on your behalf. Every one of those is a
step you take above.
