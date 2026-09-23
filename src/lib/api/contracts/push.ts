import { z } from 'zod';

import { okResponseSchema } from './common';

/**
 * Push-token registration (plans/2026-08-20-price-move-push-alerts.md).
 * `POST /api/mobile/v1/push-token` upserts, `DELETE` removes — both take the
 * same body, since a token identifies the device either way.
 */

export const pushTokenEnvironmentSchema = z.enum(['sandbox', 'production']);

export const pushTokenRequestSchema = z.object({
  /**
   * The APNs device token, hex-encoded. Constrained to hex at the boundary
   * rather than merely documented as such: `src/lib/push/apns.ts` interpolates
   * it into the HTTP/2 `:path` of a request signed with our provider JWT, and
   * a free-form string would let a caller shape that path.
   */
  token: z
    .string()
    .regex(/^[0-9a-fA-F]{64,200}$/, 'token must be a hex-encoded APNs device token'),
  environment: pushTokenEnvironmentSchema,
});

export type PushTokenRequest = z.output<typeof pushTokenRequestSchema>;

export const pushTokenResponseSchema = okResponseSchema;
