import 'server-only';

import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import { env } from '@/lib/env';

import { schema } from './schema';

/**
 * Neon scaling to zero leaves a window, right after the first request in a
 * while, where the compute is still waking up: the HTTP driver gets back a
 * 500 whose body is marked `"neon:retryable":true` — "Couldn't connect to
 * compute node", not a real query failure. Left alone this took down every
 * session lookup that raced it (Better Auth's own DB read included), which
 * is what turned into a generic "try again in a moment" on the phone with no
 * way to tell it apart from an actual vendor outage. A few short retries
 * absorb the wake-up instead of surfacing it.
 */
const RETRYABLE_WAKE_MARKER = '"neon:retryable":true';
// 5 retries at 300ms-step backoff (300/600/900/1200/1500) is ~4.5s of total
// wait, wide enough for a slow cold wake while staying well under a
// serverless function's timeout — widened from 3/~1.8s (2026-08-20) after
// that budget still let a wake race through as a raw 500 on the options
// cascade.
const WAKE_RETRY_ATTEMPTS = 5;
const WAKE_RETRY_DELAY_MS = 300;

neonConfig.fetchFunction = async (url: string | URL | Request, options?: RequestInit) => {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 500 || attempt >= WAKE_RETRY_ATTEMPTS) return response;

    const body = await response.clone().text();
    if (!body.includes(RETRYABLE_WAKE_MARKER)) return response;

    await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAY_MS * (attempt + 1)));
  }
};

/**
 * Neon over HTTP: one round-trip per query, no connection pool to exhaust from
 * serverless functions. Fine at this scale — the heaviest read is "all lots for
 * one user", which is hundreds of rows.
 *
 * The client is built lazily behind a Proxy so that merely *importing* this
 * module never reads the environment. Next evaluates every route module during
 * `next build` to collect page data, so an eager `env()` here made a missing
 * variable a build failure — on a machine that has no business holding
 * production credentials in the first place.
 *
 * Validation is not weakened, only deferred: the first actual query still
 * throws the same "Invalid server environment" error, at request time, where
 * the problem is real.
 */
function createDb() {
  const sql = neon(env().DATABASE_URL);
  return drizzle(sql, { schema, casing: 'snake_case' });
}

type Db = ReturnType<typeof createDb>;

let instance: Db | undefined;

function getDb(): Db {
  instance ??= createDb();
  return instance;
}

export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = getDb();
    const value = Reflect.get(real, prop, receiver);
    // Methods must stay bound to the real client, not to the Proxy.
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has: (_target, prop) => Reflect.has(getDb(), prop),
});

export { schema };
export * from './schema';
