"""Pins ios/Config/StockHODL-macOS.entitlements against the iPhone's.

The Mac build signs with its own entitlements file (one file for both
configurations in stage 1, plans/2026-09-28-native-mac-app-stage-1.md), and
scripts/check-entitlements.py pairs only the two iPhone files. So nothing else
notices if the Mac file drifts from the phone on the three values the two
platforms must share: the App Group (the snapshot and widget cache), the
keychain scope (the session token) and the associated domain (the passkey).
A drift there signs the Mac out, or splits it from the phone, with no error.
"""

import os
import plistlib
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MAC = os.path.join(REPO_ROOT, 'ios', 'Config', 'StockHODL-macOS.entitlements')
IOS_DEBUG = os.path.join(REPO_ROOT, 'ios', 'Config', 'StockHODL.entitlements')

SHARED_KEYS = (
    'com.apple.security.application-groups',
    'keychain-access-groups',
    'com.apple.developer.associated-domains',
)
SANDBOX_KEYS = (
    'com.apple.security.app-sandbox',
    'com.apple.security.network.client',
    'com.apple.security.files.user-selected.read-only',
)


def load(path: str) -> dict:
    with open(path, 'rb') as handle:
        return plistlib.load(handle)


class MacEntitlementsTests(unittest.TestCase):
    def test_mac_file_exists_and_parses(self) -> None:
        self.assertTrue(os.path.isfile(MAC), f'{MAC} is missing')
        self.assertIsInstance(load(MAC), dict)

    def test_shared_values_equal_the_iphone_debug_file(self) -> None:
        mac, ios = load(MAC), load(IOS_DEBUG)
        for key in SHARED_KEYS:
            with self.subTest(key=key):
                self.assertIn(key, ios, f'the iPhone file lost {key}')
                self.assertEqual(mac.get(key), ios[key])

    def test_sandbox_network_and_file_picker_are_granted(self) -> None:
        mac = load(MAC)
        for key in SANDBOX_KEYS:
            with self.subTest(key=key):
                self.assertIs(mac.get(key), True)

    def test_push_uses_the_macos_spelling_with_development(self) -> None:
        self.assertEqual(load(MAC).get('com.apple.developer.aps-environment'), 'development')

    def test_the_ios_push_key_is_absent(self) -> None:
        self.assertNotIn('aps-environment', load(MAC))

    def test_no_key_beyond_the_seven_planned(self) -> None:
        expected = set(SHARED_KEYS) | set(SANDBOX_KEYS) | {'com.apple.developer.aps-environment'}
        self.assertEqual(set(load(MAC)), expected)


if __name__ == '__main__':
    unittest.main()
