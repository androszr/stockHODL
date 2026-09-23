import 'server-only';

import { env } from '@/lib/env';

import { mapStreamAgg, parseStreamFrame, type StreamMessage } from './massive-mapping';
import type { PriceStreamHandle, PriceStreamHandlers, PriceTick } from './provider';

/**
 * The Massive delayed-WebSocket adapter — the ONLY file that knows the
 * stream URL, and (besides `massive.ts`) the only reader of `STOCK_API`.
 * `server-only`: a client component importing this is a build error.
 *
 * Handshake, verified live 2026-08-10 (do not re-probe):
 *   connect → {"ev":"status","status":"connected"}
 *   → send {"action":"auth","params":"<STOCK_API>"} → {"status":"auth_success"}
 *   → send {"action":"subscribe","params":"A.AAPL"} → {"status":"success"}
 *
 * Channels `A` (per-second aggregate) and `AM` are authorized on this plan;
 * `T` and `Q` are NOT — never subscribe to them, and a "not authorized"
 * subscribe status or `auth_failed` is terminal (`onDown('unauthorized')`),
 * never a retry into other channels. The real-time endpoint
 * (`wss://socket.massive.com`) is not entitled and is not used.
 *
 * One module-scoped, refcounted socket per warm instance: concurrent SSE
 * responses share it; the last `close()` tears it down. Uses the native
 * Node `WebSocket` (undici) — no new dependency.
 *
 * Log discipline, same as `massive.ts`: never the key, never a URL —
 * message/status only.
 */

const STREAM_URL = 'wss://delayed.massive.com/stocks';

interface Subscriber {
  /** Uppercased symbols this subscriber wants ticks for. */
  symbols: ReadonlySet<string>;
  handlers: PriceStreamHandlers;
}

interface SharedStream {
  ws: WebSocket;
  authed: boolean;
  /** Symbols a subscribe frame has been sent for (uppercased). */
  subscribed: Set<string>;
  subscribers: Set<Subscriber>;
}

let shared: SharedStream | null = null;

function ensureShared(): SharedStream {
  if (shared) return shared;

  const ws = new WebSocket(STREAM_URL);
  const s: SharedStream = { ws, authed: false, subscribed: new Set(), subscribers: new Set() };
  shared = s;

  // Every listener guards on `shared === s`: a torn-down socket's late events
  // must never touch a successor stream's state.
  ws.addEventListener('message', (event) => {
    if (shared !== s) return;
    const data: unknown = (event as MessageEvent).data;
    if (typeof data !== 'string') return; // the vendor sends text frames only
    handleFrame(s, data);
  });
  ws.addEventListener('error', () => {
    if (shared !== s) return;
    console.error('Massive stream: socket error');
    teardown(s, 'error');
  });
  ws.addEventListener('close', () => {
    if (shared !== s) return;
    teardown(s, 'closed');
  });

  return s;
}

/** Notifies every subscriber once, then drops the module-scoped socket. */
function teardown(s: SharedStream, reason: 'unauthorized' | 'error' | 'closed'): void {
  if (shared === s) shared = null;
  const subscribers = [...s.subscribers];
  s.subscribers.clear();
  try {
    s.ws.close();
  } catch {
    // Already closed/closing — nothing to release.
  }
  for (const sub of subscribers) {
    try {
      sub.handlers.onDown(reason);
    } catch {
      // A subscriber's failure must never take down its siblings.
    }
  }
}

function handleFrame(s: SharedStream, raw: string): void {
  const nowMs = Date.now();
  for (const msg of parseStreamFrame(raw)) {
    const tick = mapStreamAgg(msg, nowMs);
    if (tick !== null) {
      dispatchTick(s, tick);
      continue;
    }
    if (msg.status !== undefined) handleStatus(s, msg);
    // Anything else (unknown events, AM bars we never subscribed to) is
    // silently ignored — a malformed frame must never kill the socket.
  }
}

function handleStatus(s: SharedStream, msg: StreamMessage): void {
  const status = msg.status ?? '';
  const message = msg.message ?? '';

  if (status === 'connected') {
    // The verified sequence: auth only after the server announces itself.
    // Guarded like `flushSubscriptions`: `send()` on a CLOSING socket throws
    // an InvalidStateError, and this runs inside the message listener — an
    // unguarded throw there would escape as an unhandled error instead of a
    // clean teardown. (The error carries no payload, so nothing about the
    // key could leak either way — this is robustness only.)
    try {
      s.ws.send(JSON.stringify({ action: 'auth', params: env().STOCK_API }));
    } catch {
      // A dead socket surfaces through its own close/error listeners.
    }
    return;
  }
  if (status === 'auth_success') {
    s.authed = true;
    flushSubscriptions(s);
    return;
  }
  if (status === 'auth_failed' || message.toLowerCase().includes('not authorized')) {
    // Terminal for this plan — never retry, never fall back to T/Q.
    console.error(`Massive stream: not authorized (${status})`);
    teardown(s, 'unauthorized');
    return;
  }
  // 'success' subscribe acks and unknown statuses: nothing to do.
}

function dispatchTick(s: SharedStream, tick: PriceTick): void {
  const upper = tick.symbol.toUpperCase();
  for (const sub of s.subscribers) {
    if (!sub.symbols.has(upper)) continue;
    try {
      sub.handlers.onTick(tick);
    } catch {
      // A subscriber's failure must never take down its siblings.
    }
  }
}

/** Sends one subscribe frame for every wanted-but-not-yet-subscribed symbol. */
function flushSubscriptions(s: SharedStream): void {
  if (!s.authed) return;
  const missing = new Set<string>();
  for (const sub of s.subscribers) {
    for (const symbol of sub.symbols) {
      if (!s.subscribed.has(symbol)) missing.add(symbol);
    }
  }
  if (missing.size === 0) return;
  for (const symbol of missing) s.subscribed.add(symbol);
  const params = [...missing].map((symbol) => `A.${symbol}`).join(',');
  try {
    s.ws.send(JSON.stringify({ action: 'subscribe', params }));
  } catch {
    // A dead socket surfaces through its own close/error listeners.
  }
}

/**
 * `QuoteProvider.streamPrices` for Massive. Resolves immediately after
 * registering — connection and auth proceed in the background, and every
 * failure mode surfaces through `handlers.onDown`, never a throw.
 */
export async function streamPrices(
  symbols: readonly string[],
  handlers: PriceStreamHandlers,
): Promise<PriceStreamHandle> {
  const sub: Subscriber = {
    symbols: new Set(symbols.map((s) => s.toUpperCase())),
    handlers,
  };

  const s = ensureShared();
  s.subscribers.add(sub);
  flushSubscriptions(s); // no-op until authed; the auth ack flushes otherwise

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      // `shared` may already point at a successor (or nothing) after a
      // teardown; only release against the socket this subscriber joined.
      if (!s.subscribers.delete(sub)) return;
      if (s.subscribers.size === 0 && shared === s) {
        shared = null;
        try {
          s.ws.close();
        } catch {
          // Already closed/closing — nothing to release.
        }
      }
    },
  };
}
