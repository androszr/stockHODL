import 'server-only';

import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { bearer } from 'better-auth/plugins';
import { count } from 'drizzle-orm';

import { db, schema } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Two independent gates keep this a single-tenant app (docs/context.md § Auth). Either one
 * alone is sufficient; both are present because the failure mode — a stranger
 * with an account on my brokerage data — is not one to hedge on.
 *
 *   Gate 1 (request):  reject any auth request carrying a non-allowlisted email.
 *   Gate 2 (database): reject any user INSERT that isn't the allowlisted email,
 *                      and reject a second user row outright.
 */
async function assertAllowlisted(email: string | undefined) {
  if (!email || email.toLowerCase() !== env().ALLOWED_EMAIL.toLowerCase()) {
    // Deliberately vague: don't confirm which emails exist.
    throw new APIError('FORBIDDEN', { message: 'Registration is closed.' });
  }
}

/**
 * Built lazily, for the same reason as the database client: `next build`
 * evaluates every route module to collect page data, and the build machine
 * should never need production credentials to do that. The first real request
 * constructs this and surfaces any missing variable then.
 */
function createAuth() {
  const config = env();
  const baseUrl = new URL(config.BETTER_AUTH_URL);
  const isProd = baseUrl.protocol === 'https:';

  return betterAuth({
    appName: 'StockHODL',
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,

    database: drizzleAdapter(db, { provider: 'pg', schema }),

    /**
     * Passkeys are the only way in. There is no password to phish, stuff, or
     * leak, and no second factor to lose — a passkey already is two factors
     * (device + biometric).
     *
     * The one exception is break-glass. When RECOVERY_MODE=1, password sign-in
     * turns on just long enough for the iPhone emergency control to mint a
     * session and enroll a fresh passkey (see scripts/recover.ts). At
     * RECOVERY_MODE=0 — the normal state — this whole code path is disabled,
     * so a stored credential hash is unreachable even if one exists.
     * RECOVERY_MODE is read at build time; flipping it requires a redeploy.
     * There is no public probe for it.
     */
    emailAndPassword: { enabled: config.RECOVERY_MODE },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // sliding refresh, once per day
      /**
       * Passkey registration (`/passkey/generate-register-options`) runs
       * `freshSessionMiddleware`, which compares this against
       * `session.createdAt`. Unset, Better Auth defaults to 24h, so a live
       * sliding session older than a day was SESSION_NOT_FRESH and Settings
       * → Add a passkey mapped that to a generic failure. Matching
       * `expiresIn` lets any session still inside its 7-day life enroll.
       * `0` skips the check entirely ("considered fresh every time" — Better
       * Auth's own warning) and is not what we want.
       */
      freshAge: 60 * 60 * 24 * 7,
      /**
       * Short-lived signed cookie holding the session data, so
       * `auth.api.getSession` — paid by every mobile handler — stops costing
       * two serialized Neon round-trips per request. Tradeoff: a session row deleted straight in the DB is still
       * honoured until this cache expires, up to 5 minutes. Accepted — this
       * app has exactly one user, forever, and the two allowlist gates below
       * (hooks.before + databaseHooks.user.create.before) are sign-in-time
       * hooks that session reads never touch. Better Auth's own sign-out
       * clears the cookies, so the normal sign-out path is not delayed.
       * The refresh-cache option stays unset on purpose: with a database
       * configured, core disables it with a startup warning. `strategy`
       * stays the default `compact` (HMAC-signed): the contents are the
       * user's own session fields in their own httpOnly cookie.
       */
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },

    advanced: {
      useSecureCookies: isProd,
      /**
       * `__Host-` pins the cookie to this exact origin with Path=/ and forbids a
       * Domain attribute — a subdomain takeover can't set or read it. It also
       * mandates Secure, which is why it is production-only: localhost is http.
       */
      cookiePrefix: isProd ? '__Host-' : 'stock-follow',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax', // 'strict' would break the WebAuthn redirect round-trip
        secure: isProd,
        path: '/',
      },
    },

    /**
     * Better Auth's built-in limiter, strict on auth routes. Storage is in-memory
     * per serverless instance; the planned Upstash swap was never adopted, so a
     * recycled instance starts its window afresh (docs/context.md § Auth).
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      customRules: {
        '/sign-in/*': { window: 60, max: 10 },
        '/sign-up/*': { window: 60, max: 5 },
        '/passkey/*': { window: 60, max: 15 },
      },
    },

    hooks: {
      // Gate 1 — runs before any auth endpoint handler.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/sign-up') || ctx.path.startsWith('/sign-in')) {
          const email = (ctx.body as { email?: string } | undefined)?.email;
          await assertAllowlisted(email);
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          before: async (u) => {
            // Gate 2a — belt and braces on the email.
            await assertAllowlisted(u.email);

            // Gate 2b — this app holds exactly one user, forever. Once the row
            // exists, sign-up is closed regardless of what the email says.
            const [{ value: existing }] = await db
              .select({ value: count() })
              .from(schema.user);

            if (existing > 0 && !config.RECOVERY_MODE) {
              throw new APIError('FORBIDDEN', { message: 'Registration is closed.' });
            }

            return { data: u };
          },
        },
      },
    },

    plugins: [
      passkey({
        rpID: baseUrl.hostname,
        rpName: 'StockHODL',
        /**
         * The origin an assertion must claim. A native client that has
         * verified Associated Domains reports the DOMAIN origin here, not an
         * `ios:bundle-id:` one — which is why this can stay as it is for the
         * phone. Per docs/ios-native.md A.6.5 that is to be CONFIRMED against
         * a real assertion in stage C1, not assumed; if Apple ever reports
         * otherwise the fix is an array here, never a relaxation of `rpID`.
         */
        origin: baseUrl.origin,
      }),

      /**
       * Session as a bearer token, for the native client only (A.6.4). The
       * phone keeps the token in the Keychain rather than letting URLSession
       * hide a `__Host-` cookie in `HTTPCookieStorage`, where the app cannot
       * see, clear or migrate it.
       *
       * `requireSignature: true` is the important half. Left at its default
       * the plugin accepts a bare session token and signs it itself, so the
       * raw `session.token` column value — a string that is legitimately
       * readable in more places than a signed cookie ever is — becomes
       * sufficient to authenticate. Demanding the signed form means an
       * attacker needs BETTER_AUTH_SECRET too, and costs the client nothing:
       * the `set-auth-token` response header this plugin emits on sign-in
       * already carries the signed value.
       *
       * Web is unaffected — a browser never sends `Authorization`, so the
       * plugin's before-hook never matches on any request the web app makes.
       * The one place the app DOES send that header is `/api/cron/*` with
       * CRON_SECRET, and those routes never call into Better Auth; even if
       * they did, `requireSignature` rejects a token with no `.` separator
       * before any crypto runs — and a hex secret has none — so the header
       * falls through to the route's own timing-safe comparison untouched.
       *
       * Cost: a bearer request has no `cookieCache` companion cookie, so each
       * one pays a real session lookup. That is the correct trade for a client
       * whose token lives outside the cookie jar.
       */
      bearer({ requireSignature: true }),

      // Must stay last: it flushes Set-Cookie through Next's cookies() API.
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

export const auth = new Proxy({} as Auth, {
  get(_target, prop, receiver) {
    const real = getAuth();
    const value = Reflect.get(real, prop, receiver);
    // Methods must stay bound to the real instance, not to the Proxy.
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has: (_target, prop) => Reflect.has(getAuth(), prop),
});

export type Session = Auth['$Infer']['Session'];
