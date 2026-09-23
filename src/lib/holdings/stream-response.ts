import 'server-only';

import { massiveProvider } from '@/lib/market-data/massive';
import type { PriceStreamHandle, Quote } from '@/lib/market-data/provider';

import { applyPriceTick, type HoldingQuote } from './live-payload';
import { shouldPollQuotes } from './poll-policy';

/**
 * The live-quote SSE lifecycle, extracted MOVE-ONLY from
 * `src/app/api/quotes/stream/route.ts` (2026-08-14) so every stream route is
 * a thin session guard + loader over ONE shared implementation. The three
 * documented races are baked into the statement order — G3
 * abort-before-listener, close-during-connect, cancel vs abort — so any
 * "improvement" here is a bug; same hoisted `end`, same timer list.
 *
 * Protocol (all payloads JSON):
 *   payload  — one `compose(quotes)` result; the FIRST one is composed from
 *              a fresh REST snapshot, which IS the baseline refresh on every
 *              (re)connect.
 *   idle     — market fully closed or nothing pollable; carries
 *              `pollingResumesAtMs`, then the response ends. No vendor
 *              socket is ever opened in this case.
 *   bye      — clean end (bounded lifetime or a transient vendor drop);
 *              the client reconnects with backoff.
 *   fallback — the vendor stream is not authorized; the client reverts to
 *              the 10 s poll for the rest of the session.
 *
 * Bounded lifetime: Vercel cuts long responses at the route's `maxDuration`,
 * so the stream says goodbye at `STREAM_LIFETIME_MS` (30 s under 300) and
 * ends cleanly — never relying on the platform killing it mid-write. The
 * client resumes regardless of the actual platform ceiling.
 */

/** 30 s under the routes' `maxDuration` — the goodbye must beat the axe. */
const STREAM_LIFETIME_MS = 270_000;
/** SSE comment ping — keeps intermediaries from reaping an idle stream. */
const PING_INTERVAL_MS = 15_000;
/** At most one recomposed payload per second across all symbols. */
const COALESCE_MS = 1_000;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  // `no-store` also keeps every cache out of the path: an SSE body must
  // reach the client event by event, never held back or replayed.
  'Cache-Control': 'private, no-store',
  Connection: 'keep-alive',
} as const;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface QuoteStreamOptions {
  /** Market status at baseline time — drives the idle gate and tick math. */
  status: Quote['marketStatus'];
  pollingResumesAtMs: number | null;
  hasPollableSymbols: boolean;
  /** The fresh REST baseline quotes — also the vendor subscription set. */
  quotes: ReadonlyMap<string, HoldingQuote>;
  /** Quotes → the route's serializable payload; called per emitted frame. */
  compose: (quotes: ReadonlyMap<string, HoldingQuote>) => unknown;
}

export function quoteStreamResponse(
  request: Request,
  { status, pollingResumesAtMs, hasPollableSymbols, quotes, compose }: QuoteStreamOptions,
): Response {
  // Fully closed or structurally nothing to stream: say so and end — no
  // vendor socket, no background traffic until the next session.
  if (!shouldPollQuotes(status, hasPollableSymbols)) {
    return new Response(sse('idle', { pollingResumesAtMs }), { headers: SSE_HEADERS });
  }

  const encoder = new TextEncoder();
  let liveQuotes: ReadonlyMap<string, HoldingQuote> = quotes;
  // Hoisted so `cancel()` (client disconnect detected by the runtime) can
  // reach the same cleanup the abort listener runs.
  let end: (finalChunk?: string) => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let dirty = false;
      let vendor: PriceStreamHandle | null = null;
      // `clearInterval` accepts timeout handles too (Node treats them
      // interchangeably), so one list covers all three timers below.
      const timers: ReturnType<typeof setInterval>[] = [];

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client vanished mid-write; abort/cancel completes cleanup.
        }
      };

      end = (finalChunk?: string) => {
        if (closed) return;
        if (finalChunk !== undefined) send(finalChunk);
        closed = true;
        for (const timer of timers) clearInterval(timer);
        timers.length = 0;
        vendor?.close();
        vendor = null;
        try {
          controller.close();
        } catch {
          // Already closed — nothing to release.
        }
      };

      // Client disconnect (tab closed, network drop) aborts the request:
      // release the vendor handle immediately, not at lifetime end. Per
      // spec, a listener added to an ALREADY-aborted signal never fires —
      // and the abort may well have happened during the caller's baseline
      // load await (fast navigation), which would leave `closed` false and
      // the vendor socket refcounted with no reader for a full lifetime.
      // Check first and bail (G3, 2026-08-10).
      if (request.signal.aborted) {
        end();
        return;
      }
      request.signal.addEventListener('abort', () => end());

      // The baseline payload — every (re)connect starts from a fresh snapshot.
      send(sse('payload', compose(liveQuotes)));

      // No priced symbols this round (transient vendor blip): nothing to
      // subscribe to. Say goodbye; the client's backoff retries with a fresh
      // snapshot, and its 10 s poll covers the gap meanwhile.
      if (liveQuotes.size === 0) {
        end(sse('bye', { reason: 'no-quotes' }));
        return;
      }

      const handle = await massiveProvider.streamPrices([...liveQuotes.keys()], {
        onTick(tick) {
          // Status-aware application — while open the tick moves the headline
          // and re-derives the day pair from the SAME prevClose baseline;
          // during extended sessions it moves the extended line and the
          // headline stays the official close. Emission is coalesced below.
          liveQuotes = applyPriceTick(liveQuotes, tick, status);
          dirty = true;
        },
        onDown(reason) {
          if (reason === 'unauthorized') {
            // Terminal on this plan: tell the client to poll instead.
            end(sse('fallback', { reason }));
          } else {
            end(sse('bye', { reason }));
          }
        },
      });
      if (closed) {
        // Aborted while the vendor handle was being created.
        handle.close();
        return;
      }
      vendor = handle;

      timers.push(
        setInterval(() => {
          if (!dirty) return;
          dirty = false;
          send(sse('payload', compose(liveQuotes)));
        }, COALESCE_MS),
        setInterval(() => send(': ping\n\n'), PING_INTERVAL_MS),
        setInterval(() => end(sse('bye', { reason: 'lifetime' })), STREAM_LIFETIME_MS),
      );
    },
    cancel() {
      end();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
