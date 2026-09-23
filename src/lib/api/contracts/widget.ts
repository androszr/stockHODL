import { z } from 'zod';

import { decimalStringSchema, epochMsSchema } from './common';
import { liveMarketSchema, liveSummarySchema } from './live-payload';

/**
 * One instant on a widget day-path. `p` is an unformatted decimal-string
 * percent from that side's own previous close (`pctChange` / `toNumeric`),
 * never a number — codegen must not emit `Double` for it.
 */
export const widgetDayPointSchema = z.object({
  t: epochMsSchema,
  p: decimalStringSchema,
});

/**
 * The two session paths the Combined tile draws. Bounds are the regular US
 * cash session of the plotted day (`regularSessionFor`) — left = open, right
 * = close. Do not name a field `open`: quicktype mangles that Swift keyword.
 */
export const widgetDayLinesSchema = z.object({
  sessionOpenMs: epochMsSchema,
  sessionCloseMs: epochMsSchema,
  holdings: z.array(widgetDayPointSchema),
  options: z.array(widgetDayPointSchema),
});

export type WidgetDayLinesContract = z.output<typeof widgetDayLinesSchema>;

/**
 * The whole payload a Home Screen or lock-screen widget needs, and nothing
 * else: two summaries and the market clock.
 *
 * Why a route of its own rather than the widget calling `/live` and
 * `/options`. A widget extension runs under a hard memory and wall-clock
 * budget, is woken by the system rather than by a user, and gets a finite
 * number of refreshes per day. `/live` answers every holding, every cached
 * price and every portfolio scope; `/options` runs the most expensive load in
 * the app (per-lot greeks plus a per-ticker bar sync) — and between them the
 * widget reads five fields. Two heavy calls per refresh is how a widget ends
 * up rendering the placeholder.
 *
 * Composed from the SAME server functions as the two routes it condenses
 * (`getHoldingsView`, `loadOptionsInputs` → `composeLiveOptionsPayload`), so
 * this cannot become a second way of computing a total. It is a projection of
 * existing payloads, never a parallel calculation.
 *
 * **The two totals are in different currencies and are not comparable.**
 * `holdings` is the złoty portfolio total; `options` is USD-only and covers
 * unexpired lots only, exactly as `OptionsPayload.summary` documents. A
 * renderer that puts them on one line — which the lock-screen family does —
 * must carry the unit on each. They are never summed.
 */
export const widgetSummaryResponseSchema = z.object({
  /** The top-level holdings total, in PLN. Never a portfolio scope: a widget
   *  has no way to ask for one, and the answer must not depend on a request. */
  holdings: liveSummarySchema,
  /** The unexpired-lots options total, in USD. */
  options: liveSummarySchema,
  /** Drives the timeline reload policy: refresh on the session's cadence
   *  while open, and once at the next open while closed. */
  market: liveMarketSchema,
  /**
   * Regular-session percent paths for the Combined tile. Absent when both
   * series are empty or there is no regular session (weekend) so the payload
   * stays ~400 bytes. Other widgets ignore it.
   */
  dayLines: widgetDayLinesSchema.optional(),
});

export type WidgetSummaryResponseContract = z.output<
  typeof widgetSummaryResponseSchema
>;
