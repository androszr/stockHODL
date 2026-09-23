#!/usr/bin/env python3
"""Refuse drift between the Debug and Release entitlements.

The two files are the same except for one key. That is the whole point of the
split — a distribution build must claim the PRODUCTION APNs environment or App
Store Connect rejects the upload — but it also means a capability added to one
and not the other ships a Release build quietly missing it. Nothing on the
device would say so: the widget simply stops seeing the keychain, or a passkey
ceremony simply fails.

Parsed rather than diffed, so a comment or a reordering is not a failure and a
real key change is.
"""

import plistlib
import sys

DEBUG = 'ios/Config/StockHODL.entitlements'
RELEASE = 'ios/Config/StockHODL-Release.entitlements'
# The one key the two files are ALLOWED to disagree on, and the value each
# must carry. Sandbox for a cabled build, production for anything signed for
# distribution — they are different token universes and a token from one is
# `BadDeviceToken` at the other's host.
APS = 'aps-environment'
EXPECTED = {DEBUG: 'development', RELEASE: 'production'}


def main() -> int:
    with open(DEBUG, 'rb') as handle:
        debug = plistlib.load(handle)
    with open(RELEASE, 'rb') as handle:
        release = plistlib.load(handle)

    errors = []

    if debug.keys() != release.keys():
        only_debug = sorted(debug.keys() - release.keys())
        only_release = sorted(release.keys() - debug.keys())
        errors.append(
            f'different keys — only in Debug: {only_debug}, only in Release: {only_release}'
        )

    for key in sorted(debug.keys() & release.keys()):
        if key == APS:
            continue
        if debug[key] != release[key]:
            errors.append(f'{key} differs: {debug[key]!r} (Debug) vs {release[key]!r} (Release)')

    for path, value in EXPECTED.items():
        actual = (debug if path == DEBUG else release).get(APS)
        if actual != value:
            errors.append(f'{path}: {APS} is {actual!r}, expected {value!r}')

    for error in errors:
        print(f'::error::entitlements: {error}')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
