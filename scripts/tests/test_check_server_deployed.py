"""Bite tests for scripts/check-server-deployed.py.

Each case builds a throwaway git repository in a temp directory and runs the
guard inside it with `--deployed`, so GitHub is never asked anything.
"""

import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(REPO_ROOT, 'scripts', 'check-server-deployed.py')


class CheckServerDeployedTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 't@example.com')
        self.git('config', 'user.name', 'Test')

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ['git', *args], cwd=self.repo, capture_output=True, text=True, check=True
        ).stdout.strip()

    def commit(self, path: str) -> str:
        full = os.path.join(self.repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'a', encoding='utf-8') as handle:
            handle.write('x\n')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', path)
        return self.git('rev-parse', 'HEAD')

    def run_guard(self, *deployed: str, pending: int = 0) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, SCRIPT, '--deployed', *deployed, '--pending', str(pending),
             '--wait-minutes', '0'],
            cwd=self.repo, capture_output=True, text=True,
        )

    def test_passes_when_server_commit_itself_deployed(self) -> None:
        server = self.commit('src/a.ts')
        self.assertEqual(self.run_guard(server).returncode, 0)

    def test_passes_when_a_later_deploy_covers_it(self) -> None:
        self.commit('src/a.ts')
        later = self.commit('docs/b.md')
        self.commit('ios/App.swift')
        result = self.run_guard(later)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn(later[:7], result.stdout)

    def test_a_failing_lookup_is_reported_not_crashed(self) -> None:
        self.commit('src/a.ts')
        bin_dir = os.path.join(self.repo, 'fakebin')
        os.makedirs(bin_dir)
        fake_gh = os.path.join(bin_dir, 'gh')
        with open(fake_gh, 'w', encoding='utf-8') as handle:
            handle.write('#!/bin/sh\necho "HTTP 502" >&2\nexit 1\n')
        os.chmod(fake_gh, 0o755)
        env = {**os.environ, 'PATH': bin_dir + os.pathsep + os.environ['PATH']}
        result = subprocess.run(
            [sys.executable, SCRIPT, '--wait-minutes', '0', '--poll-seconds', '0'],
            cwd=self.repo, capture_output=True, text=True, env=env,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn('Could not list Deploy runs: HTTP 502', result.stdout)
        self.assertNotIn('Traceback', result.stderr)

    def test_ios_only_commits_do_not_need_a_deploy(self) -> None:
        server = self.commit('src/a.ts')
        self.commit('ios/App.swift')
        self.assertEqual(self.run_guard(server).returncode, 0)

    def test_refuses_when_server_change_never_deployed(self) -> None:
        # The 2026-09-28 shape: one commit touching both trees, no Deploy run.
        deployed = self.commit('src/a.ts')
        self.commit('src/b.ts')
        self.commit('ios/App.swift')
        result = self.run_guard(deployed)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has not been deployed', result.stdout)

    def test_refuses_with_no_deploys_at_all(self) -> None:
        self.commit('src/a.ts')
        self.assertEqual(self.run_guard().returncode, 1)

    def test_gives_up_on_a_pending_deploy_after_the_wait(self) -> None:
        self.commit('src/a.ts')
        self.assertEqual(self.run_guard(pending=1).returncode, 1)

    def test_no_server_commit_at_all_passes(self) -> None:
        self.commit('ios/App.swift')
        self.assertEqual(self.run_guard().returncode, 0)


if __name__ == '__main__':
    unittest.main()
