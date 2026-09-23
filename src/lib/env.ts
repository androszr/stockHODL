import 'server-only';

import { z } from 'zod';

/**
 * Server-only environment contract. Importing this from a client bundle is a
 * build error thanks to `server-only` — that is the guard that keeps secrets out
 * of anything that is not the API host (docs/context.md § Auth).
 */
const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be >= 32 chars'),
  BETTER_AUTH_URL: z.string().url(),

  /** The one identity that may ever hold an account. docs/context.md § Auth. */
  ALLOWED_EMAIL: z.string().email(),

  /** Documented break-glass for total passkey loss (docs/context.md § Auth). */
  RECOVERY_MODE: z
    .enum(['0', '1'])
    .optional()
    .default('0')
    .transform((v) => v === '1'),

  CRON_SECRET: z.string().min(16).optional(),

  /**
   * Massive market-data API key (Starter tier: unlimited REST, 15-minute
   * delayed data). The name matches what is already provisioned in `.env` —
   * do not rename. Only `src/lib/market-data/massive.ts` may read it.
   */
  STOCK_API: z.string().min(1),

  /**
   * Anthropic API key for the screenshot-import vision extraction
   * (plans/2026-08-15-options-screenshot-import.md). OPTIONAL by decision:
   * this schema validates at BUILD time, so a required key would break the
   * build and sign-in on every environment missing it (the STOCK_API lesson,
   * docs/context.md §Deployment). Absent key = the import button never
   * renders; everything else works. Only `src/lib/ai/vision-extract.ts` and
   * `src/lib/day-report/narrative.ts` may read it — the complete two-door ledger.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /**
   * Apple application identifier — `<TEAMID>.<bundle id>` — published in the
   * Associated Domains file at `/.well-known/apple-app-site-association` so
   * iOS will let the native client assert an existing passkey for this rpID
   * (docs/ios-native.md A.6.3).
   *
   * OPTIONAL for the same reason ANTHROPIC_API_KEY is: this schema validates
   * at BUILD time, and the Team ID only exists once the paid Apple Developer
   * enrollment completes. Absent value = the AASA route answers 404, which is
   * exactly what a domain with no associated app should say. Nothing else in
   * the app reads it, and it is public by design — Apple fetches the file
   * unauthenticated, so this is an identifier, not a secret.
   */
  APPLE_APP_ID: z
    .string()
    .regex(
      /^[A-Z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]*$/,
      'APPLE_APP_ID must be <10-char Team ID>.<bundle id>',
    )
    .optional(),

  /**
   * APNs provider credentials (plans/2026-08-20-price-move-push-alerts.md).
   * All five OPTIONAL for the same reason ANTHROPIC_API_KEY and APPLE_APP_ID
   * are: this schema validates at BUILD time, and the push key is a manual
   * Apple Developer portal step that can lag a deploy. Absent = the
   * check-price-alerts cron logs and returns without sending anything; every
   * other feature works. Only `src/lib/push/apns.ts` may read them — the
   * massive.ts single-door rule.
   */
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  /** The `.p8` file's contents, base64-encoded (env vars are single-line). */
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_ENVIRONMENT: z.enum(['sandbox', 'production']).optional().default('sandbox'),
});

let cached: z.infer<typeof serverEnvSchema> | undefined;

export function env() {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Fail loudly at boot rather than mysteriously at the first query.
    throw new Error(`Invalid server environment:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
