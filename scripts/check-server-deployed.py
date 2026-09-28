#!/usr/bin/env python3
"""Refuse to upload a phone build whose server is not in production yet.

The phone and the API ship through two workflows that do not wait for each
other: Deploy for everything outside `ios/`, TestFlight for the binary. On
2026-09-28 the push carrying the tile-grid Dashboard ran CI and iOS but no
Deploy, and a manually dispatched TestFlight shipped its build anyway. The new
build's contract bump renamed its disk cache, so it opened empty, and the old
server's closed-market stream sent only `idle` with no payload — every holding
showed no value, and the value sort fell back to ticker order, until the next
push deployed the server an hour later.

The rule: the newest commit at or below HEAD that touches anything outside
`ios/` (exactly what Deploy's `paths-ignore` watches) must be an ancestor of,
or equal to, a commit a successful Deploy run shipped. A commit that touches
both trees starts Deploy and TestFlight together, so while a Deploy run is
still queued or running the guard waits for it rather than failing.

`--deployed` replaces the GitHub lookup with a fixed list of shas, and
`--pending 0` with no pending runs — that is how the tests bite without a
network.
"""

import argparse
import json
import subprocess
import sys
import time


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', *args], capture_output=True, text=True)


def server_commit(head: str) -> str | None:
    """The newest commit at or below `head` that Deploy would have deployed."""
    out = git('log', '-1', '--format=%H', head, '--', '.', ':(exclude)ios')
    if out.returncode != 0:
        raise SystemExit(f'git log failed: {out.stderr.strip()}')
    return out.stdout.strip() or None


def is_ancestor(older: str, newer: str) -> bool:
    return git('merge-base', '--is-ancestor', older, newer).returncode == 0


def deploy_runs() -> tuple[list[str], int]:
    """(shas of successful production deploys, count of runs still going)."""
    out = subprocess.run(
        ['gh', 'run', 'list', '--workflow', 'deploy.yml', '--branch', 'main',
         '--event', 'push', '--limit', '50', '--json', 'headSha,status,conclusion'],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f'gh exited {out.returncode}')
    runs = json.loads(out.stdout)
    done = [r['headSha'] for r in runs if r['status'] == 'completed' and r['conclusion'] == 'success']
    going = sum(1 for r in runs if r['status'] != 'completed')
    return done, going


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--deployed', nargs='*', help='successful deploy shas (skips gh)')
    parser.add_argument('--pending', type=int, help='runs still going (with --deployed)')
    parser.add_argument('--wait-minutes', type=float, default=20)
    parser.add_argument('--poll-seconds', type=float, default=30)
    args = parser.parse_args(argv)

    needed = server_commit(args.head)
    if needed is None:
        print('No server commit at or below HEAD; nothing to wait for.')
        return 0

    # A failed lookup is retried until the deadline rather than ending the
    # run: TestFlight refuses re-runs, so one API hiccup would otherwise cost
    # a whole fresh archive.
    deadline = time.monotonic() + args.wait_minutes * 60
    while True:
        if args.deployed is not None:
            deployed, going = args.deployed, args.pending or 0
        else:
            try:
                deployed, going = deploy_runs()
            except (RuntimeError, ValueError) as error:
                if time.monotonic() >= deadline:
                    print(f'::error::Could not list Deploy runs: {error}')
                    return 1
                print(f'Could not list Deploy runs ({error}); retrying…')
                time.sleep(args.poll_seconds)
                continue
        covering = next((sha for sha in deployed if is_ancestor(needed, sha)), None)
        if covering:
            print(f'Server {needed[:7]} is in production (deployed with {covering[:7]}).')
            return 0
        if going == 0 or time.monotonic() >= deadline:
            print(
                f'::error::Server commit {needed[:7]} has not been deployed to production. '
                'This build would reach the phone ahead of the API it speaks and show no '
                'holdings values. Get Deploy green for that commit (push again, or re-run '
                'Deploy on the Actions tab), then run TestFlight.'
            )
            return 1
        print(f'Waiting for {going} Deploy run(s) still in progress…')
        time.sleep(args.poll_seconds)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
