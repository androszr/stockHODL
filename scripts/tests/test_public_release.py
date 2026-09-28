"""Tests for the public-release preparation: build numbers, the exported
bundle check, the Gitleaks allowance and the commit-free export.

Every case works on temporary files. Nothing here reads a real secret, signs,
uploads, or commits: the export cases run the real script from a disposable
fixture checkout with a `git` wrapper on PATH that refuses `init`, `add`,
`commit` and `push`, so the test can see how far the script got without
letting it create a repository.

The scanner and export cases need Gitleaks (8.30.1, the audited version). It
is found through `$GITLEAKS`, then PATH, then /tmp/stockhodl-audit-tools. A
missing binary FAILS these cases locally — a check that silently skips is how
an allowance quietly widens. On a GitHub runner (`GITHUB_ACTIONS=true`, where
`ios.yml` runs this suite with no Gitleaks installed) they skip and say so.

Fake credentials are generated at run time, so this file holds none of them
and never trips the export scan it tests; scanner output is redacted.
"""

from __future__ import annotations

import json
import os
import plistlib
import random
import shutil
import stat
import string
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUILD_NUMBER = os.path.join(REPO_ROOT, 'scripts', 'ios-build-number.py')
BUNDLE_CHECK = os.path.join(REPO_ROOT, 'scripts', 'check-ios-bundle-versions.py')
EXPORT = os.path.join(REPO_ROOT, 'scripts', 'export-public.sh')
GITLEAKS_CONFIG = os.path.join(REPO_ROOT, '.gitleaks.toml')
WORKFLOW = os.path.join(REPO_ROOT, '.github', 'workflows', 'testflight.yml')

FIXTURE_PATH = os.path.join('src', 'lib', 'api', 'cron', 'gate.test.ts')
# The invented value the cron-gate tests use, assembled so this file does not
# carry it as a literal assignment of its own.
DUMMY = '-'.join(['a', 'cron', 'secret', 'of', 'at', 'least', '16', 'chars'])


def fake(length: int = 32, alphabet: str = string.ascii_letters + string.digits) -> str:
    """A throwaway high-entropy string, different on every run."""
    rng = random.SystemRandom()
    while True:
        value = ''.join(rng.choice(alphabet) for _ in range(length))
        if any(c.isdigit() for c in value) and any(c.isupper() for c in value) and any(c.islower() for c in value):
            return value


def find_gitleaks() -> str | None:
    candidates = [os.environ.get('GITLEAKS'), shutil.which('gitleaks'), '/tmp/stockhodl-audit-tools/gitleaks']
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


GITLEAKS = find_gitleaks()


def require_gitleaks(case: unittest.TestCase) -> str:
    if GITLEAKS is None:
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            case.skipTest('gitleaks is not installed on this GitHub runner (ios.yml); run locally')
        case.fail('gitleaks is required for this case and was not found ($GITLEAKS, PATH, '
                  '/tmp/stockhodl-audit-tools/gitleaks) — install gitleaks 8.30.1')
    return GITLEAKS


def write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(content)


def fixture_source(secret: str = DUMMY, extra: str = '') -> str:
    return (
        "import { describe, it } from 'vitest';\n"
        "\n"
        f"const SECRET = '{secret}';\n"
        f"{extra}"
        "\n"
        "describe('gate', () => { it('uses the secret', () => void SECRET); });\n"
    )


# --- Build number ------------------------------------------------------------

def build_number(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, BUILD_NUMBER, *args], capture_output=True, text=True)


def numbered(offset: str, run: str, attempt: str = '1') -> subprocess.CompletedProcess:
    return build_number(f'--offset={offset}', f'--run-number={run}', f'--run-attempt={attempt}')


class BuildNumberTests(unittest.TestCase):
    def assertNumber(self, result: subprocess.CompletedProcess, expected: str) -> None:
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, expected + '\n')

    def assertRefused(self, result: subprocess.CompletedProcess, *words: str) -> None:
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout, '')
        for word in words:
            self.assertIn(word, result.stderr)

    def test_migration_example_continues_after_build_29(self) -> None:
        self.assertNumber(build_number('--offset', '29', '--run-number', '1', '--run-attempt', '1'), '30')
        self.assertNumber(numbered('29', '2'), '31')

    def test_fresh_app_says_offset_zero_explicitly(self) -> None:
        self.assertNumber(numbered('0', '1'), '1')

    def test_a_later_migration_offset_lands_above_the_previous_maximum(self) -> None:
        previous_max = int(numbered('29', '40').stdout)  # the old repository's last build: 69
        first = numbered(str(previous_max), '1')
        self.assertNumber(first, str(previous_max + 1))
        self.assertGreater(int(first.stdout), previous_max)

    def test_unset_offset_is_refused_never_read_as_zero(self) -> None:
        self.assertRefused(numbered('', '1'), 'IOS_BUILD_NUMBER_OFFSET')

    def test_missing_argument_is_a_usage_error(self) -> None:
        result = build_number('--run-number', '1', '--run-attempt', '1')
        self.assertEqual(result.returncode, 2)

    def test_malformed_offsets_are_refused(self) -> None:
        for bad in ('-1', '+29', '1.5', '29.0', 'abc', ' 29', '29 ', '2+1', '029', '00', '0x1d', '1e3', '٢٩'):
            with self.subTest(offset=bad):
                self.assertRefused(numbered(bad, '1'), '--offset')

    def test_malformed_run_numbers_are_refused(self) -> None:
        for bad in ('', '0', '-3', '01', '1.0', 'one'):
            with self.subTest(run=bad):
                self.assertRefused(numbered('29', bad), '--run-number')

    def test_a_rerun_is_refused_with_the_fix(self) -> None:
        self.assertRefused(numbered('29', '1', '2'), 'Run workflow')
        self.assertRefused(numbered('29', '1', ''), '--run-attempt')
        self.assertRefused(numbered('29', '1', '0'), '--run-attempt')

    def test_ceiling(self) -> None:
        self.assertNumber(numbered('9998', '1'), '9999')
        self.assertRefused(numbered('9999', '1'), '9999')
        self.assertRefused(numbered('999999999', '999999999'), 'ceiling')


# --- Exported bundle versions ------------------------------------------------

class BundleVersionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.app = os.path.join(self._tmp.name, 'Payload', 'StockHODL.app')
        self.app_info = {
            'CFBundleIdentifier': 'com.example.stockhodl',
            'CFBundleVersion': '30',
            'CFBundleShortVersionString': '0.1',
        }
        self.widget_info = {
            'CFBundleIdentifier': 'com.example.stockhodl.widgets',
            'CFBundleVersion': '30',
            'CFBundleShortVersionString': '0.1',
            'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.widgetkit-extension'},
        }

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def lay_out(self, widgets: dict[str, dict | bytes] | None = None, app: dict | bytes | None = None) -> None:
        shutil.rmtree(self.app, ignore_errors=True)
        os.makedirs(self.app)
        self.put(os.path.join(self.app, 'Info.plist'), self.app_info if app is None else app)
        if widgets is None:
            widgets = {'StockHODLWidgets.appex': self.widget_info}
        for name, info in widgets.items():
            folder = os.path.join(self.app, 'PlugIns', name)
            os.makedirs(folder)
            self.put(os.path.join(folder, 'Info.plist'), info)

    @staticmethod
    def put(path: str, info: dict | bytes) -> None:
        with open(path, 'wb') as handle:
            if isinstance(info, bytes):
                handle.write(info)
            else:
                plistlib.dump(info, handle, fmt=plistlib.FMT_BINARY)

    def check(self, build: str = '30') -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, BUNDLE_CHECK, '--app', self.app, '--build-number', build],
            capture_output=True, text=True,
        )

    def assertRefused(self, *words: str) -> None:
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout)
        for word in words:
            self.assertIn(word, result.stderr)

    def test_matching_app_and_widget_pass(self) -> None:
        self.lay_out()
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_build_number_other_than_this_runs_is_refused(self) -> None:
        self.lay_out()
        result = self.check('31')
        self.assertEqual(result.returncode, 1)
        self.assertIn('the app says build 30', result.stderr)

    def test_app_build_mismatch(self) -> None:
        self.app_info['CFBundleVersion'] = '1'
        self.lay_out()
        self.assertRefused('the app says build 1')

    def test_widget_build_mismatch(self) -> None:
        self.widget_info['CFBundleVersion'] = '1'
        self.lay_out()
        self.assertRefused('widget', 'build 1')

    def test_widget_marketing_version_mismatch(self) -> None:
        self.widget_info['CFBundleShortVersionString'] = '0.2'
        self.lay_out()
        self.assertRefused('version 0.2')

    def test_missing_fields(self) -> None:
        for owner, key in (('app', 'CFBundleVersion'), ('app', 'CFBundleShortVersionString'),
                           ('widget', 'CFBundleVersion'), ('widget', 'CFBundleShortVersionString')):
            with self.subTest(owner=owner, key=key):
                self.tearDown()
                self.setUp()
                (self.app_info if owner == 'app' else self.widget_info).pop(key)
                self.lay_out()
                self.assertRefused(key)

    def test_missing_extension(self) -> None:
        self.lay_out(widgets={})
        self.assertRefused('found none')

    def test_wrong_extension_name(self) -> None:
        self.lay_out(widgets={'OtherWidgets.appex': self.widget_info})
        self.assertRefused('OtherWidgets.appex', 'StockHODLWidgets.appex')

    def test_an_extension_that_is_not_a_widget(self) -> None:
        self.widget_info['NSExtension'] = {'NSExtensionPointIdentifier': 'com.apple.share-services'}
        self.lay_out()
        self.assertRefused('found none')

    def test_two_widget_extensions(self) -> None:
        self.lay_out(widgets={'StockHODLWidgets.appex': self.widget_info, 'Second.appex': self.widget_info})
        self.assertRefused('exactly one')

    def test_widget_outside_the_app_identifier(self) -> None:
        self.widget_info['CFBundleIdentifier'] = 'com.elsewhere.widgets'
        self.lay_out()
        self.assertRefused('not under the app identifier')

    def test_malformed_plists(self) -> None:
        self.lay_out(app=b'<plist><dict><key>broken')
        self.assertRefused('not a readable plist')
        self.lay_out(widgets={'StockHODLWidgets.appex': b'\x00\x01 not a plist'})
        self.assertRefused('not a readable plist')

    def test_missing_app_folder(self) -> None:
        result = self.check()
        self.assertEqual(result.returncode, 1)


# --- Workflow wiring ---------------------------------------------------------

class WorkflowWiringTests(unittest.TestCase):
    """The TestFlight workflow decides the number once, before any secret, and
    every consumer reads that one value."""

    @classmethod
    def setUpClass(cls) -> None:
        with open(WORKFLOW, encoding='utf-8') as handle:
            cls.text = handle.read()

    def test_helpers_trigger_the_workflow(self) -> None:
        self.assertIn("- 'scripts/ios-build-number.py'", self.text)
        self.assertIn("- 'scripts/check-ios-bundle-versions.py'", self.text)

    def test_number_is_chosen_before_any_secret(self) -> None:
        helper = self.text.index('python3 scripts/ios-build-number.py')
        self.assertLess(helper, self.text.index('secrets.'))
        self.assertIn('${{ vars.IOS_BUILD_NUMBER_OFFSET }}', self.text)
        self.assertIn('${{ github.run_attempt }}', self.text)
        self.assertIn('echo "BUILD_NUMBER=$BUILD_NUMBER" >> "$GITHUB_ENV"', self.text)

    def test_archive_checker_and_summary_read_the_same_value(self) -> None:
        self.assertIn('CURRENT_PROJECT_VERSION="$BUILD_NUMBER"', self.text)
        checker = self.text.index('check-ios-bundle-versions.py --app "$APP" --build-number "$BUILD_NUMBER"')
        self.assertLess(checker, self.text.index('- name: Upload'))
        self.assertIn('Build \\`$BUILD_NUMBER\\`', self.text)
        # The raw run number feeds the helper and nothing else.
        self.assertEqual(self.text.count('${{ github.run_number }}'), 1)

    def test_in_flight_uploads_are_still_never_cancelled(self) -> None:
        self.assertIn('cancel-in-progress: false', self.text)


# --- Gitleaks allowance ------------------------------------------------------

class GitleaksAllowanceTests(unittest.TestCase):
    """Real Gitleaks, real config, doctored trees. The allowance must need the
    exact value AND the exact file, and only on the rule that reports it."""

    def setUp(self) -> None:
        self.gitleaks = require_gitleaks(self)
        self._tmp = tempfile.TemporaryDirectory()
        self.tree = os.path.join(self._tmp.name, 'tree')
        os.makedirs(self.tree)
        shutil.copy(GITLEAKS_CONFIG, os.path.join(self.tree, '.gitleaks.toml'))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def scan(self) -> list[dict]:
        report = os.path.join(self._tmp.name, 'report.json')
        result = subprocess.run(
            [self.gitleaks, 'detect', '--source', self.tree, '--no-git', '--no-banner', '--redact',
             '--config', os.path.join(self.tree, '.gitleaks.toml'), '--report-format', 'json',
             '--report-path', report],
            capture_output=True, text=True,
        )
        self.assertIn(result.returncode, (0, 1), result.stderr[-2000:])
        with open(report, encoding='utf-8') as handle:
            findings = json.load(handle) or []
        self.assertEqual(result.returncode == 1, bool(findings))
        return [{'rule': f['RuleID'], 'file': os.path.relpath(f['File'], self.tree), 'line': f['StartLine']}
                for f in findings]

    def test_version_is_the_audited_one(self) -> None:
        out = subprocess.run([self.gitleaks, 'version'], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out.lstrip('v'), '8.30.1')

    def test_default_rules_flag_the_dummy_without_the_allowance(self) -> None:
        os.remove(os.path.join(self.tree, '.gitleaks.toml'))
        with open(os.path.join(self.tree, '.gitleaks.toml'), 'w', encoding='utf-8') as handle:
            handle.write('[extend]\nuseDefault = true\n')
        write(os.path.join(self.tree, FIXTURE_PATH), fixture_source())
        self.assertEqual(self.scan(), [{'rule': 'generic-api-key', 'file': FIXTURE_PATH, 'line': 3}])

    def test_the_known_fixture_passes(self) -> None:
        write(os.path.join(self.tree, FIXTURE_PATH), fixture_source())
        self.assertEqual(self.scan(), [])

    def test_the_real_fixture_file_passes(self) -> None:
        shutil.copy(os.path.join(REPO_ROOT, FIXTURE_PATH), os.path.join(self.tree, 'gate.test.ts'))
        os.makedirs(os.path.dirname(os.path.join(self.tree, FIXTURE_PATH)))
        os.replace(os.path.join(self.tree, 'gate.test.ts'), os.path.join(self.tree, FIXTURE_PATH))
        self.assertEqual(self.scan(), [])

    def test_a_replacement_secret_on_the_same_line_is_reported(self) -> None:
        write(os.path.join(self.tree, FIXTURE_PATH), fixture_source(secret=fake(40)))
        self.assertEqual(self.scan(), [{'rule': 'generic-api-key', 'file': FIXTURE_PATH, 'line': 3}])

    def test_the_dummy_with_a_suffix_is_reported(self) -> None:
        write(os.path.join(self.tree, FIXTURE_PATH), fixture_source(secret=DUMMY + fake(8)))
        self.assertEqual([f['line'] for f in self.scan()], [3])

    def test_a_second_credential_in_the_same_file_is_reported(self) -> None:
        extra = f"const API_TOKEN = '{fake(40)}';\n"
        write(os.path.join(self.tree, FIXTURE_PATH), fixture_source(extra=extra))
        self.assertEqual(self.scan(), [{'rule': 'generic-api-key', 'file': FIXTURE_PATH, 'line': 4}])

    def test_a_provider_credential_in_the_same_file_is_reported(self) -> None:
        extra = f"const token = '{'ghp' + '_' + fake(36)}';\n"
        write(os.path.join(self.tree, FIXTURE_PATH), fixture_source(extra=extra))
        findings = self.scan()
        self.assertTrue(findings)
        self.assertTrue(all(f['line'] == 4 for f in findings), findings)
        self.assertIn('github-pat', {f['rule'] for f in findings})

    def test_the_dummy_in_another_file_is_reported(self) -> None:
        for other in ('src/lib/api/cron/other.test.ts', 'src/lib/api/cron/gate.test.ts.bak',
                      'x/src/lib/api/cron/gate.test.tsx', 'notsrc/lib/api/cron/gate.test.ts.js'):
            with self.subTest(file=other):
                shutil.rmtree(os.path.join(self.tree, 'src'), ignore_errors=True)
                shutil.rmtree(os.path.join(self.tree, 'x'), ignore_errors=True)
                shutil.rmtree(os.path.join(self.tree, 'notsrc'), ignore_errors=True)
                write(os.path.join(self.tree, other), fixture_source())
                self.assertEqual(self.scan(), [{'rule': 'generic-api-key', 'file': other, 'line': 3}])

    def test_a_provider_credential_elsewhere_is_reported(self) -> None:
        write(os.path.join(self.tree, FIXTURE_PATH), fixture_source())
        write(os.path.join(self.tree, 'src', 'config.ts'), f"export const token = '{'ghp' + '_' + fake(36)}';\n")
        findings = self.scan()
        self.assertTrue(findings)
        self.assertEqual({f['file'] for f in findings}, {os.path.join('src', 'config.ts')})


# --- Commit-free export --------------------------------------------------------

REFUSED_GIT_VERBS = ('init', 'add', 'commit', 'push')
REFUSED_EXIT = 97


class ExportFixture(unittest.TestCase):
    """The real export script, run from a throwaway checkout. Its `git` is a
    wrapper that lets read-only enumeration through and refuses every verb
    that would create a repository or a commit, logging the attempt.
    Subclasses choose whether Gitleaks is on the script's PATH."""

    def gitleaks_dirs(self) -> list[str]:
        raise NotImplementedError

    def setUp(self) -> None:
        extra_path = self.gitleaks_dirs()
        self._tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(self._tmp.name)
        self.repo = os.path.join(base, 'repo')
        self.out = os.path.join(base, 'out')
        self.log = os.path.join(base, 'git-mutations.log')
        bin_dir = os.path.join(base, 'bin')
        os.makedirs(bin_dir)

        write(os.path.join(self.repo, 'README.md'), '# Fixture\n')
        write(os.path.join(self.repo, 'LICENSE'), 'MIT\n')
        write(os.path.join(self.repo, 'SECURITY.md'), 'Report privately.\n')
        write(os.path.join(self.repo, FIXTURE_PATH), fixture_source())
        write(os.path.join(self.repo, 'plans', 'private.md'), 'never published\n')
        shutil.copy(GITLEAKS_CONFIG, os.path.join(self.repo, '.gitleaks.toml'))
        os.makedirs(os.path.join(self.repo, 'scripts'))
        shutil.copy(EXPORT, os.path.join(self.repo, 'scripts', 'export-public.sh'))
        real_git = shutil.which('git')
        assert real_git
        # A repository with no commit: `ls-files --others` still enumerates.
        subprocess.run([real_git, 'init', '-q', self.repo], check=True)

        wrapper = os.path.join(bin_dir, 'git')
        verbs = '|'.join(REFUSED_GIT_VERBS)
        with open(wrapper, 'w', encoding='utf-8') as handle:
            handle.write(
                '#!/bin/sh\n'
                'for arg in "$@"; do\n'
                f'  case "$arg" in {verbs}) printf \'%s\\t%s\\n\' "$arg" "$*" >> "{self.log}"; '
                f'echo "git wrapper: refused $arg" >&2; exit {REFUSED_EXIT} ;; esac\n'
                'done\n'
                f'exec "{real_git}" "$@"\n'
            )
        os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IXUSR)
        self.env = dict(os.environ)
        self.env['PATH'] = os.pathsep.join([bin_dir, *extra_path, os.environ.get('PATH', '')])
        self.env.pop('GIT_DIR', None)
        self.env.pop('GIT_WORK_TREE', None)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def export(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ['bash', os.path.join(self.repo, 'scripts', 'export-public.sh'), *args],
            capture_output=True, text=True, env=self.env, cwd=self.repo,
        )

    def mutations(self) -> list[str]:
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding='utf-8') as handle:
            return [line.split('\t', 1)[0] for line in handle.read().splitlines()]

    def refused_target(self) -> str:
        """The folder the first refused git call was aimed at (`git -C DIR …`)."""
        with open(self.log, encoding='utf-8') as handle:
            words = handle.readline().rstrip('\n').split('\t', 1)[1].split(' ')
        return words[words.index('-C') + 1]

    def reported_copy(self, stdout: str) -> str:
        for line in stdout.splitlines():
            if line.startswith('export-public: copy: '):
                return line.split(': ', 2)[2]
        self.fail(f'no copy path in: {stdout}')



class ExportTests(ExportFixture):
    """The export with Gitleaks available: every check runs."""

    def gitleaks_dirs(self) -> list[str]:
        self.gitleaks = require_gitleaks(self)
        return [os.path.dirname(self.gitleaks)]

    def test_check_only_passes_without_touching_git(self) -> None:
        result = self.export('--out', self.out, '--check-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('check-only', result.stdout)
        self.assertEqual(self.mutations(), [])
        self.assertFalse(os.path.exists(os.path.join(self.out, '.git')))
        self.assertTrue(os.path.isfile(os.path.join(self.out, '.gitleaks.toml')))
        self.assertTrue(os.path.isfile(os.path.join(self.out, FIXTURE_PATH)))
        self.assertFalse(os.path.exists(os.path.join(self.out, 'plans')))

    def test_dry_run_check_only_passes_without_touching_git(self) -> None:
        result = self.export('--dry-run', '--check-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        copy = self.reported_copy(result.stdout)
        try:
            self.assertEqual(self.mutations(), [])
            self.assertFalse(os.path.exists(os.path.join(copy, '.git')))
            self.assertTrue(os.path.isfile(os.path.join(copy, 'README.md')))
        finally:
            shutil.rmtree(os.path.dirname(copy), ignore_errors=True)

    def test_custom_pattern_hit_still_fails(self) -> None:
        address = '@'.join(['someone', 'mail' + '.invalid-domain.org'])
        write(os.path.join(self.repo, 'docs', 'contact.md'), f'Write to {address}\n')
        result = self.export('--out', self.out, '--check-only')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('forbidden content', result.stderr)
        self.assertEqual(self.mutations(), [])

    def test_gitleaks_hit_still_fails(self) -> None:
        write(os.path.join(self.repo, 'src', 'settings.ts'), f"export const api_secret = '{fake(40)}';\n")
        result = self.export('--out', self.out, '--check-only')
        self.assertEqual(result.returncode, 2, result.stderr[-2000:])
        self.assertIn('gitleaks found a secret', result.stderr)
        self.assertEqual(self.mutations(), [])

    def test_missing_required_files_fail(self) -> None:
        for missing in ('SECURITY.md', '.gitleaks.toml'):
            with self.subTest(missing=missing):
                os.rename(os.path.join(self.repo, missing), os.path.join(self.repo, missing + '.away'))
                shutil.rmtree(self.out, ignore_errors=True)
                try:
                    result = self.export('--out', self.out, '--check-only')
                finally:
                    os.rename(os.path.join(self.repo, missing + '.away'), os.path.join(self.repo, missing))
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertIn(missing, result.stderr)
                self.assertEqual(self.mutations(), [])

    def test_nonempty_output_is_refused(self) -> None:
        write(os.path.join(self.out, 'keep.txt'), 'already here\n')
        result = self.export('--out', self.out, '--check-only')
        self.assertEqual(result.returncode, 1)
        self.assertIn('not empty', result.stderr)

    def test_output_inside_the_repository_is_refused(self) -> None:
        result = self.export('--out', os.path.join(self.repo, 'public'), '--check-only')
        self.assertEqual(result.returncode, 1)
        self.assertIn('inside the repository', result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.repo, 'public')))

    def test_normal_export_still_goes_on_to_commit(self) -> None:
        result = self.export('--out', self.out)
        self.assertEqual(result.returncode, REFUSED_EXIT, result.stderr)
        self.assertEqual(self.mutations(), ['init'])
        self.assertFalse(os.path.exists(os.path.join(self.out, '.git')))

    def test_plain_dry_run_still_goes_on_to_commit(self) -> None:
        result = self.export('--dry-run')
        self.assertEqual(result.returncode, REFUSED_EXIT, result.stderr)
        self.assertEqual(self.mutations(), ['init'])
        copy = self.refused_target()
        self.assertTrue(copy.endswith('/stockhodl'), copy)
        self.assertFalse(os.path.exists(os.path.join(copy, '.git')))
        shutil.rmtree(os.path.dirname(copy), ignore_errors=True)


class ExportWithoutGitleaksTests(ExportFixture):
    """Gitleaks absent from PATH. Needs no Gitleaks itself, so it runs (and
    must pass) everywhere, CI included: a rehearsal that cannot scan for
    secrets must refuse, not report a pass."""

    def gitleaks_dirs(self) -> list[str]:
        return []

    def setUp(self) -> None:
        super().setUp()
        kept = [entry for entry in os.environ.get('PATH', '').split(os.pathsep)
                if entry and not os.path.exists(os.path.join(entry, 'gitleaks'))]
        self.env['PATH'] = os.pathsep.join([os.path.dirname(self.log) + os.sep + 'bin', *kept])
        self.assertIsNone(shutil.which('gitleaks', path=self.env['PATH']))

    def test_check_only_refuses_without_gitleaks(self) -> None:
        for args in (('--out', self.out, '--check-only'), ('--dry-run', '--check-only')):
            with self.subTest(args=args):
                result = self.export(*args)
                for line in result.stderr.splitlines():
                    if line.startswith('export-public: the unscanned copy is left at ') and '--dry-run' in args:
                        shutil.rmtree(os.path.dirname(line.rsplit(' ', 1)[1]), ignore_errors=True)
                self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
                self.assertIn('gitleaks is not installed', result.stderr)
                self.assertIn('the unscanned copy is left at', result.stderr)
                self.assertNotIn('every check passed', result.stdout)
                self.assertEqual(self.mutations(), [])

    def test_normal_export_says_the_scan_was_skipped(self) -> None:
        result = self.export('--out', self.out)
        self.assertEqual(result.returncode, REFUSED_EXIT, result.stderr)
        self.assertIn('secret scan was SKIPPED', result.stderr)
        self.assertEqual(self.mutations(), ['init'])


if __name__ == '__main__':
    unittest.main()
