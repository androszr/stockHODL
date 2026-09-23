import { eq } from 'drizzle-orm';

import { cronGate } from '@/lib/api/cron/gate';
import { commitAlertState, evaluateAlert } from '@/lib/alerts/alert-state-store';
import { alertDisplayName } from '@/lib/alerts/alert-title';
import { loadFollowedInstruments } from '@/lib/alerts/followed-instruments';
import { computeWindowMoves } from '@/lib/alerts/price-move';
import { crossedTarget } from '@/lib/alerts/target-cross';
import { loadPendingTargets, markTargetHit } from '@/lib/alerts/target-store';
import { mapWithConcurrency } from '@/lib/async-pool';
import { db, notificationPreferences, pushTokens } from '@/lib/db';
import { env } from '@/lib/env';
import { massiveProvider } from '@/lib/market-data/massive';
import type { Candle } from '@/lib/market-data/provider';
import { dec, fmtMoney } from '@/lib/money';
import { sendPushAlert } from '@/lib/push/apns';
import { pruneInvalidTokens } from '@/lib/push/tokens';

/**
 * GitHub Actions target (`.github/workflows/price-alerts.yml`), not Vercel
 * Cron — plans/2026-08-20-price-move-push-alerts.md's "Trigger" section: the
 * ~10-minute cadence this needs is likely finer than the current Vercel plan
 * tier schedules natively, and this route needs no Vercel change to work
 * either way. Same CRON_SECRET bearer, checked by the shared `cronGate`, as
 * every other cron route.
 *
 * Best-effort per user and per symbol: one instrument's vendor failure never
 * sinks another's check, and one user's push failure never blocks the next
 * user's.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const ALERT_CONCURRENCY = 5;
/** Bounds one run's vendor fan-out — the `MAX_INTRADAY_SYMBOLS` precedent. */
const MAX_ALERT_SYMBOLS = 60;
/** A bit over 12h of margin so a thin session still has two real bars either side. */
const WINDOW_MS = 13 * 60 * 60 * 1000;

async function checkOneUser(userId: string, tokens: readonly string[], now: number): Promise<number> {
  const followed = (await loadFollowedInstruments(userId)).slice(0, MAX_ALERT_SYMBOLS);
  // Every pending target, regardless of whether the instrument is still
  // held/watched — a target is an explicit standing order until deleted.
  // Deliberately NOT via a widened `loadFollowedInstruments`: that loader
  // excludes the watchlist by recorded user decision (2026-08-21), and
  // widening it would re-enable watchlist + options-underlying 5% pushes.
  const pendingTargets = await loadPendingTargets(userId);

  // ONE bar fetch per instrument for both checks: the followed set first,
  // then any targeted instrument not already in it, the whole union still
  // capped at MAX_ALERT_SYMBOLS.
  const toFetch = new Map(followed.map((i) => [i.id, i]));
  for (const target of pendingTargets) {
    if (toFetch.size >= MAX_ALERT_SYMBOLS) break;
    if (!toFetch.has(target.instrumentId)) {
      toFetch.set(target.instrumentId, {
        id: target.instrumentId,
        symbol: target.symbol,
        displayName: target.displayName,
        currency: target.currency,
      });
    }
  }

  const spec = {
    multiplier: 5,
    timespan: 'minute' as const,
    from: String(now - WINDOW_MS),
    to: String(now),
  };

  const perSymbol = await mapWithConcurrency(
    [...toFetch.values()],
    ALERT_CONCURRENCY,
    async (instrument) => {
      try {
        const candles = await massiveProvider.getAggregates(instrument.symbol, spec);
        return { instrument, candles };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'intraday fetch failed';
        console.error(`[cron/check-price-alerts] ${instrument.symbol}: ${message}`);
        return { instrument, candles: [] as Candle[] };
      }
    },
  );
  const candlesByInstrument = new Map(perSymbol.map((r) => [r.instrument.id, r.candles]));

  const nowDate = new Date(now);
  const invalidTokens = new Set<string>();
  let fired = 0;

  const followedIds = new Set(followed.map((i) => i.id));
  for (const { instrument, candles } of perSymbol) {
    // The 5% check stays exactly the followed set — a targeted-but-unheld
    // instrument gets its bars fetched for the target alone.
    if (!followedIds.has(instrument.id)) continue;
    if (candles.length < 2) continue;
    const closes = candles.map((c) => dec(c.close));
    const moves = computeWindowMoves(closes);

    const directions = [
      ['up', moves.upPct],
      ['down', moves.downPct],
    ] as const;

    for (const [direction, movePct] of directions) {
      if (movePct === null) continue;
      // Sequential on purpose: each direction depends on the persisted state
      // the previous one may just have written for the SAME instrument.
      const transition = await evaluateAlert(instrument.id, direction, movePct);
      if (!transition.shouldFire) {
        // A non-firing transition (notably the retrace that re-arms) is safe to
        // persist immediately — nothing is being consumed.
        await commitAlertState(instrument.id, direction, transition.armed, false, nowDate);
        continue;
      }

      const absMove = movePct.abs().toFixed(1);
      // Name in the title, ticker in the body: the company name is what makes
      // the alert readable at a glance, and the ticker stays one line below so
      // nothing is lost (2026-08-21 user decision). The deep link is by
      // symbol either way.
      const name = alertDisplayName(instrument.displayName, instrument.symbol);
      const outcomes = await sendPushAlert(tokens, {
        title: `${name} ${direction === 'up' ? '+' : '-'}${absMove}%`,
        body: `${instrument.symbol} moved ${direction === 'up' ? 'up' : 'down'} ${absMove}% in the last 12 hours.`,
        urlScheme: `stockhodl://ticker/${instrument.symbol}`,
      });
      for (const [token, outcome] of outcomes) {
        if (outcome === 'invalid-token') invalidTokens.add(token);
      }

      // Only a real delivery consumes the crossing. If every token errored the
      // state is left untouched, so the NEXT run re-evaluates the same still-
      // valid move and tries again rather than swallowing it silently.
      if ([...outcomes.values()].includes('delivered')) {
        fired++;
        await commitAlertState(instrument.id, direction, transition.armed, true, nowDate);
      }
    }
  }

  // The user's price targets, over the SAME bars. The persisted direction is
  // the whole verdict — the current price is never consulted here, so a
  // target the stock gapped past still fires the way it was set.
  for (const target of pendingTargets) {
    const candles = candlesByInstrument.get(target.instrumentId) ?? [];
    const targetPrice = dec(target.targetPrice);
    if (!crossedTarget(candles, targetPrice, target.direction, target.createdAt.getTime())) {
      continue;
    }

    const name = alertDisplayName(target.displayName, target.symbol);
    const price = fmtMoney(targetPrice, 'USD');
    const outcomes = await sendPushAlert(tokens, {
      title: `${name} hit ${price}`,
      body: `${target.symbol} ${target.direction === 'up' ? 'rose' : 'fell'} to your ${price} target.`,
      urlScheme: `stockhodl://ticker/${target.symbol}`,
    });
    for (const [token, outcome] of outcomes) {
      if (outcome === 'invalid-token') invalidTokens.add(token);
    }

    // Delivery-before-commit, same as `commitAlertState` above: a crossing
    // is consumed only once a device actually received the push. An
    // all-error send leaves `hit_at` NULL and the next run re-evaluates the
    // same still-crossed line.
    if ([...outcomes.values()].includes('delivered')) {
      fired++;
      await markTargetHit(target.id, nowDate);
    }
  }

  if (invalidTokens.size > 0) await pruneInvalidTokens([...invalidTokens]);
  return fired;
}

export async function GET(request: Request) {
  const refused = cronGate(request, env().CRON_SECRET);
  if (refused) return refused;

  try {
    // Only users whose "Price alerts" preference is ON
    // (plans/2026-09-05-daily-portfolio-summary-push.md). A missing
    // `notification_preferences` row means both switches off — the backfill
    // migration wrote `price_alerts = true` for every user already holding a
    // token, so no token-exists fallback is needed here or anywhere.
    const usersWithTokens = await db
      .selectDistinct({ userId: pushTokens.userId })
      .from(pushTokens)
      .innerJoin(notificationPreferences, eq(notificationPreferences.userId, pushTokens.userId))
      .where(eq(notificationPreferences.priceAlerts, true));
    const now = Date.now();
    let fired = 0;

    for (const { userId } of usersWithTokens) {
      const tokenRows = await db
        .select({ token: pushTokens.token })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId));
      const tokens = tokenRows.map((r) => r.token);
      if (tokens.length === 0) continue;

      fired += await checkOneUser(userId, tokens, now);
    }

    return Response.json({ ok: true, fired }, { headers: NO_STORE });
  } catch (error) {
    console.error('[cron/check-price-alerts]', error);
    return Response.json({ error: 'Check failed.' }, { status: 502, headers: NO_STORE });
  }
}
