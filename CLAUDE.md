<!-- BEGIN DARK ARMY PACK — managed, edits here are overwritten -->
@AGENTS.md

<!-- The contract lives in AGENTS.md so that Codex, which never opens this
     file, reads the same text as Claude and Grok. Put only Claude-specific
     notes below this line. -->

## Claude-only notes

- Dark Army's board tools (`dark_army_add_card`, `dark_army_attach_plan`,
  `dark_army_close_card`, `dark_army_needs_manual_check`) arrive in every
  session once Dark Army is installed; its channel only in a session started
  with `claude --dangerously-load-development-channels server:dark-army`.
  Their absence is an ordinary state, not a fault — the skills say what to do
  without them. A session started before the rename carries the same verbs as
  `bob_*`; a session keeps the tool list it was born with.
- Sub-agents are spawned with the `Agent` tool by the `name` in their
  frontmatter under `.claude/agents/`.
<!-- END DARK ARMY PACK -->

# StockHODL (stock-follow)

A personal US-stock portfolio tracker: a SwiftUI iPhone app (with Home Screen
widgets) over a small Next.js API host on Vercel, Neon Postgres for storage,
Massive for 15-minute-delayed market data and NBP for FX. Passkey-only sign-in,
exactly one user.

**Read [`docs/context.md`](docs/context.md) before making changes.** It is the
architecture ground truth. [`docs/ios-native.md`](docs/ios-native.md) is the
iPhone architecture document; [`docs/setup.md`](docs/setup.md) is how to run
your own copy.

## Commands

```bash
pnpm dev          # dev server
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm build        # next build
pnpm db:generate  # generate a migration from schema.ts
pnpm db:migrate   # apply migrations
pnpm ios:gen      # regenerate the Swift contracts and tokens
```

All four gates (`lint`, `typecheck`, `test`, `build`) must pass before handoff,
plus the iOS gates in the managed Identity table when `ios/` is touched.

## Non-negotiables

1. **No float money math.** Postgres `numeric` → string → `decimal.js` via
   `src/lib/money.ts` (and `Money.swift` on the phone). `parseFloat`/`Number()`
   on a price, quantity, fee or FX rate is a bug.
2. **No hardcoded colors.** `src/styles/tokens.css` is the only file allowed a
   color literal; the phone reads the generated Swift tokens
   (`pnpm tokens:gen`).
3. **One human surface.** Every iPhone size the app supports; there is no web
   shell.
4. **Market data is server-mediated.** The phone never calls a market-data
   vendor (Massive, NBP, or any other).
5. **Two allowlist gates stay intact** in `src/lib/auth.ts`. This app has exactly
   one user, forever.
6. **`server-only` on anything reading `process.env`** or the database.
7. **Migrations are additive.** They run before the new code deploys, so a
   destructive change must be split across two deploys.
8. **Never commit or push** unless explicitly asked.

## Reviewing a change

`/review` reviews the working tree (no argument), a commit (`/review <sha>`) or a
pull request (`/review #42`). It reads the GitNexus graph for blast radius,
explains the risk and the fix in **plain language**, and offers what it finds as
Backlog cards on Dark Army's board. `.claude/review.md` in this repo tells it
what counts as risky here and which reviewer to hand a deep pass to.

It is not `/code-review`, which is the deep line-by-line correctness sweep and
can apply fixes. `/review` is the graph-aware, plain-spoken one that ends in
cards.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **finance-app** (17080 symbols, 93063 relationships, 828 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/finance-app/context` | Codebase overview, check index freshness |
| `gitnexus://repo/finance-app/clusters` | All functional areas |
| `gitnexus://repo/finance-app/processes` | All execution flows |
| `gitnexus://repo/finance-app/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
