/**
 * Database error classification. Pure module (no server marker, no env/DB
 * reads) so the cause-chain walk stays unit-testable.
 *
 * drizzle-orm ≥0.45 wraps every driver error in `DrizzleQueryError`, which
 * carries only `query`/`params`/`cause` — the Postgres `code` lives on the
 * *cause* (or deeper, depending on driver). Checking only the top-level
 * object therefore never matches; the chain must be walked.
 */

const MAX_CAUSE_DEPTH = 10; // guards against a pathological circular chain

function hasCode(e: unknown, code: string): boolean {
  return (
    typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code
  );
}

function chainHasCode(e: unknown, code: string): boolean {
  let current: unknown = e;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (hasCode(current, code)) return true;
    if (typeof current !== 'object' || current === null) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Postgres 23505 (unique_violation), anywhere in the error's cause chain. */
export function isUniqueViolation(e: unknown): boolean {
  return chainHasCode(e, '23505');
}
