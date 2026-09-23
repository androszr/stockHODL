import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * One opaque id per deploy. `next.config.ts` pins `generateBuildId` and the
 * `X-Build-Id` header to this value so every artifact of one deploy agrees
 * on its identity.
 *
 * It is derived DETERMINISTICALLY from the commit sha, never randomly:
 * next.config.ts can be evaluated more than once per build (main process and
 * workers), so a random value here could stamp different ids onto the
 * headers. Hashing the sha keeps the id opaque — it reveals no commit id,
 * env value, dependency version or path.
 *
 * @returns {string} a 16-char hex fragment of sha256(commit sha)
 */
export function resolveBuildId() {
  let source = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!source) {
    try {
      source = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      source = 'dev'; // no git, no Vercel — dev-only fallback, still consistent
    }
  }
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}
