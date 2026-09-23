/**
 * ONE in-process budget for vision calls, shared by every screenshot-parse
 * action (options and transactions).
 *
 * Why one module and not one per entry point: each read costs real money
 * (~$0.011 at the current Sonnet 5 / low-effort configuration), and two
 * independent counters would have silently DOUBLED the ceiling the moment the
 * second import path shipped. Six calls per ten minutes is the whole budget,
 * across both doors combined.
 *
 * Honest scope: the window is per serverless INSTANCE and per module instance
 * — the same rationale as the search cache in `massive.ts`. Serverless
 * instances evaporate, and with exactly one user (`ALLOWED_EMAIL`, enforced by
 * two allowlist gates) a person cannot meaningfully spread load across them on
 * purpose. This is a cost brake, not an authorization control.
 */

const RATE_LIMIT_MAX_CALLS = 6;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const visionCallTimestamps: number[] = [];

/** True when the call must be refused. Records the call when it is allowed,
 *  so the caller never has to remember to. */
export function visionRateLimited(nowMs: number): boolean {
  const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
  while (visionCallTimestamps.length > 0 && visionCallTimestamps[0] <= cutoff) {
    visionCallTimestamps.shift();
  }
  if (visionCallTimestamps.length >= RATE_LIMIT_MAX_CALLS) return true;
  visionCallTimestamps.push(nowMs);
  return false;
}
