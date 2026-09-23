import { z } from 'zod';

import { epochMsSchema } from './common';

/**
 * The Settings payload — the phone's read of what `/settings` shows that is
 * not already on Profile.
 *
 * Two facts, and both are diagnostics rather than figures: whether the
 * market-data key still works, and whether the server is currently accepting
 * password sign-in. Neither is derivable on the device, and the second one is
 * the reason this endpoint exists at all — a phone that cannot see recovery
 * mode cannot tell the user their account is temporarily easier to reach.
 *
 * The vendor probe is UNCACHED server-side (a health surface answering from
 * cache is decorative), so this route is deliberately not something a client
 * polls.
 */

export const marketDataHealthSchema = z.enum(['ok', 'unauthorized', 'unreachable']);

export const settingsResponseSchema = z.object({
  marketData: marketDataHealthSchema.meta({ title: 'MarketDataHealth' }),
  /**
   * When a price last arrived successfully — a FETCH instant, worded as such
   * on both clients, never presented as a trade time. Null when the quote
   * cache has never been written.
   */
  lastPriceFetchedAtMs: epochMsSchema.nullable(),
  /** True while `RECOVERY_MODE=1` — password sign-in is enabled server-side. */
  recoveryMode: z.boolean(),
});

export type SettingsResponseContract = z.output<typeof settingsResponseSchema>;
