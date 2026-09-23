#!/usr/bin/env bash
# export-public.sh — build a clean, single-commit copy of this repository for
# publishing, in a folder beside it. The private repository is never touched:
# nothing here commits, pushes, rewrites history or edits a tracked file.
#
#   scripts/export-public.sh [--out DIR] [--dry-run]
#
#   --out DIR   where to build the copy (default: ../stockhodl, a sibling of
#               this checkout). Refused if DIR exists and is not empty.
#   --dry-run   build into a fresh temporary folder instead and print its path
#               at the end; nothing is left beside the checkout.
#
# What is copied: every file git tracks or would track (tracked, plus
# untracked-and-not-ignored) that is present on disk — so a file removed with
# a plain `rm` counts as deleted without staging — minus EXCLUDES below.
#
# Then a forbidden-content scan over the copy. Any hit prints every hit and
# exits 2 BEFORE `git init`: a leak never reaches a commit. The copy must also
# carry README.md, LICENSE and SECURITY.md and must not carry plans/,
# .gitnexus/, .dark-army/, .env, .private-strings or PLAN.md (exit 3 otherwise).
#
# Last, one commit, "Initial public release of StockHODL", authored as
# EXPORT_AUTHOR_NAME / EXPORT_AUTHOR_EMAIL (default: the GitHub no-reply
# address, so no personal email lands in the public history).
#
# Exit codes: 0 built, 1 usage or refused output folder, 2 forbidden content,
# 3 structural check failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(git -C "$ROOT" rev-parse --show-toplevel)"

OUT=""
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --out)
            [ $# -ge 2 ] || { echo "export-public: --out needs a folder" >&2; exit 1; }
            OUT="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "export-public: unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [ "$DRY_RUN" -eq 1 ]; then
    [ -z "$OUT" ] || { echo "export-public: --dry-run picks its own folder; drop --out" >&2; exit 1; }
    OUT="$(mktemp -d)/stockhodl"
fi
[ -n "$OUT" ] || OUT="$ROOT/../stockhodl"

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
    echo "export-public: $OUT exists and is not empty — pick another --out or empty it" >&2
    exit 1
fi
# Refuse an output inside the repository before creating anything, then again
# once the path is resolved (a `..` or a symlink can hide the first time).
case "$OUT" in /*) out_abs="$OUT" ;; *) out_abs="$PWD/$OUT" ;; esac
case "$out_abs/" in
    "$ROOT/"*) echo "export-public: $OUT is inside the repository; export beside it" >&2; exit 1 ;;
esac
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
case "$OUT/" in
    "$ROOT/"*) echo "export-public: $OUT is inside the repository; export beside it" >&2; exit 1 ;;
esac

# Paths never published. A trailing `/` excludes a whole folder; anything else
# is an exact path. `.env` and `.env.*` (except `.env.example`) are refused by
# name wherever they sit, below.
EXCLUDES=(
    "plans/"
    "docs/research/"
    ".gitnexus/"
    ".dark-army/"
    ".bob-companion/"
    ".vercel/"
    ".claude/RESUME.md"
    ".claude/scheduled_tasks.lock"
    "assets/illustrated/look-reference.jpg"
    "docs/redesign-propositions/"
    "skills-lock.json"
    ".private-strings"
    "next-env.d.ts"
)

excluded() {
    local path="$1" base entry
    base="${path##*/}"
    if [ "$base" = ".env" ] || { [[ "$base" == .env.* ]] && [ "$base" != ".env.example" ]; }; then
        return 0
    fi
    for entry in "${EXCLUDES[@]}"; do
        case "$entry" in
            */) [[ "$path" == "$entry"* ]] && return 0 ;;
            *) [ "$path" = "$entry" ] && return 0 ;;
        esac
    done
    return 1
}

# --- Copy -------------------------------------------------------------------
copied=0
while IFS= read -r -d '' path; do
    # Present on disk (a symlink counts even when its target is absent).
    [ -e "$ROOT/$path" ] || [ -L "$ROOT/$path" ] || continue
    excluded "$path" && continue
    mkdir -p "$OUT/$(dirname "$path")"
    cp -P -p "$ROOT/$path" "$OUT/$path"
    copied=$((copied + 1))
done < <(git -C "$ROOT" ls-files --cached --others --exclude-standard -z)

# --- Forbidden-content scan ---------------------------------------------------
# Each pattern is a POSIX ERE for `grep -E`; a literal is written with one
# character in brackets (`[,]`) so this file does not match its own list.
# Private literals (real figures, handles) are NOT listed here — publishing
# them in the guard would publish them. They live one per line in the
# git-ignored `.private-strings` and are matched as fixed strings below.
# ALLOW entries are cut out of each hit line before it is re-checked; each must be as
# narrow as the placeholder it names — never a whole file.
PATTERNS=(
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}'
    '/Users/[A-Za-z]+/'
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'
    'sk-ant-[A-Za-z0-9_-]{8,}'
    'ghp_[A-Za-z0-9]{20,}'
    'github[_]pat_'
    'xox[abp]-'
    'AKIA[0-9A-Z]{16}'
    'npg_[A-Za-z0-9]{8,}'
    'postgres(ql)?://[^[:space:]:]+:[^[:space:]@]+@'
)
ALLOW=(
    '@example\.com'
    'users\.noreply\.github\.com'
    'password@ep-xxx'
    'user:password@ep-xxx'
    'postgresql://ci:ci@localhost:5432/ci'
)

hits_file="$(mktemp)"
trap 'rm -f "$hits_file"' EXIT
# A hit survives when the pattern still matches after every allowed
# placeholder is cut out of the line — so a line carrying both an allowed
# address and a real one is still caught.
allow_re="$(IFS='|'; echo "${ALLOW[*]}")"
for pattern in "${PATTERNS[@]}"; do
    (cd "$OUT" && grep -rIn -E --exclude-dir=.git -e "$pattern" . 2>/dev/null || true) |
        while IFS= read -r line; do
            stripped="$(printf '%s\n' "$line" | sed -E "s#${allow_re}##g")"
            if printf '%s\n' "$stripped" | grep -q -E -e "$pattern"; then
                printf '%s\n' "$line"
            fi
        done >> "$hits_file"
done
PRIVATE_STRINGS="$ROOT/.private-strings"
if [ -f "$PRIVATE_STRINGS" ]; then
    while IFS= read -r word || [ -n "$word" ]; do
        word="$(printf '%s' "$word" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
        case "$word" in ''|'#'*) continue ;; esac
        (cd "$OUT" && grep -rIn -F --exclude-dir=.git -e "$word" . 2>/dev/null || true) >> "$hits_file"
    done < "$PRIVATE_STRINGS"
else
    echo "export-public: no .private-strings — private figures are not being checked" >&2
fi
if [ -s "$hits_file" ]; then
    echo "export-public: forbidden content in the copy — nothing was committed:" >&2
    sort -u "$hits_file" | sed 's#^\./##' >&2
    echo "export-public: the copy is left at $OUT for inspection" >&2
    exit 2
fi

if command -v gitleaks >/dev/null 2>&1; then
    if ! gitleaks detect --source "$OUT" --no-git >&2; then
        echo "export-public: gitleaks found a secret in the copy — nothing was committed" >&2
        exit 2
    fi
fi

# --- Structural checks ----------------------------------------------------------
for must_not in plans docs/research .gitnexus .dark-army .env .private-strings PLAN.md; do
    if [ -e "$OUT/$must_not" ]; then
        echo "export-public: $must_not must not be in the copy" >&2
        exit 3
    fi
done
for must in README.md LICENSE SECURITY.md; do
    if [ ! -f "$OUT/$must" ]; then
        echo "export-public: $must is missing from the copy" >&2
        exit 3
    fi
done

# --- One commit ------------------------------------------------------------------
git -C "$OUT" init -q -b main
git -C "$OUT" add -A
git -C "$OUT" \
    -c user.name="${EXPORT_AUTHOR_NAME:-Robert Androsz}" \
    -c user.email="${EXPORT_AUTHOR_EMAIL:-13721474+androszr@users.noreply.github.com}" \
    -c commit.gpgsign=false \
    commit -q -m "Initial public release of StockHODL"

sha="$(git -C "$OUT" rev-parse HEAD)"
commits="$(git -C "$OUT" rev-list --count HEAD)"
echo "export-public: files: $copied"
echo "export-public: commit: $sha"
if [ "$DRY_RUN" -eq 1 ]; then
    echo "export-public: dry run — the copy is at $OUT (temporary)"
else
    echo "export-public: out: $OUT"
fi
echo "export-public: commits: $commits"
