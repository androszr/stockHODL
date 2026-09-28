#!/usr/bin/env python3
"""Print the TestFlight build number for one workflow run: offset + run number.

App Store Connect refuses a build number it has already seen for the same
(bundle id, marketing version). `github.run_number` increases on its own, but
it starts again at 1 in a new repository — and this app's uploads have already
used numbers up to the old repository's last run. So the number is

    IOS_BUILD_NUMBER_OFFSET + github.run_number

where the offset is a repository VARIABLE set once, before the first upload
from that repository, to the highest build number App Store Connect already
holds for this app and version. Moving from a repository whose last upload was
build 29: offset 29, first run 1 → build 30, run 2 → 31. A brand-new app may
say offset 0 — but it has to say it; an unset offset is refused, never read as
zero, because zero is exactly the collision this exists to prevent.

A re-run (`github.run_attempt` above 1) is refused too. It reuses the run
number, and the first attempt may already have uploaded under it; the fix is a
fresh run (Actions → TestFlight → Run workflow), never a re-run.

No network, no signing, no environment reads: the workflow passes the three
values as arguments, and this runs before any key or certificate is touched.

    scripts/ios-build-number.py --offset 29 --run-number 1 --run-attempt 1   # → 30

Exit codes: 0 printed the number, 1 refused (the message says why and what to
do), 2 usage.
"""

from __future__ import annotations

import argparse
import re
import sys

# CFBundleVersion allows more, but this app will never honestly need five
# digits; a number past this is a mistyped offset far more often than a real
# release, and it is far easier to refuse than to take back.
MAX_BUILD = 9999

NON_NEGATIVE = re.compile(r'0|[1-9][0-9]{0,8}')
POSITIVE = re.compile(r'[1-9][0-9]{0,8}')


class Refused(Exception):
    pass


def parse(name: str, raw: str | None, pattern: re.Pattern[str], what: str, hint: str) -> int:
    if raw is None or raw == '':
        raise Refused(f'{name} is empty. {hint}')
    if not pattern.fullmatch(raw):
        raise Refused(f'{name} is {raw!r}, which is not {what}. {hint}')
    return int(raw)


def build_number(offset: str | None, run_number: str | None, run_attempt: str | None) -> int:
    off = parse(
        '--offset', offset, NON_NEGATIVE,
        'a plain whole number (0 or more, no sign, no spaces, no leading zero)',
        'Set the repository variable IOS_BUILD_NUMBER_OFFSET (Settings → Secrets and '
        'variables → Actions → Variables) to the highest build number App Store Connect '
        'already has for this app and version — or 0 for a brand-new app. See docs/publishing.md.',
    )
    run = parse(
        '--run-number', run_number, POSITIVE,
        'a positive whole number',
        'Pass github.run_number.',
    )
    attempt = parse(
        '--run-attempt', run_attempt, POSITIVE,
        'a positive whole number',
        'Pass github.run_attempt.',
    )
    if attempt != 1:
        raise Refused(
            f'this is attempt {attempt} of run {run}. A re-run reuses the run number, and an '
            'earlier attempt may already have uploaded that build. Start a fresh run instead: '
            'Actions → TestFlight → Run workflow.'
        )
    result = off + run
    if result > MAX_BUILD:
        raise Refused(
            f'offset {off} + run {run} = {result}, above the ceiling of {MAX_BUILD}. Check '
            'IOS_BUILD_NUMBER_OFFSET for a typo; if the number is genuine, raise the marketing '
            'version (which restarts the count) or raise MAX_BUILD in this script on purpose.'
        )
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--offset', required=True)
    parser.add_argument('--run-number', required=True)
    parser.add_argument('--run-attempt', required=True)
    args = parser.parse_args(argv)
    try:
        number = build_number(args.offset, args.run_number, args.run_attempt)
    except Refused as refused:
        print(f'ios-build-number: {refused}', file=sys.stderr)
        return 1
    print(number)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
