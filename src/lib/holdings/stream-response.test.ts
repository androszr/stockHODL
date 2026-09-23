import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G3 abort-before-listener + live abort-releases-handle, driven at
 * `quoteStreamResponse` so `/api/mobile/v1/live/stream` keeps the coverage
 * the web stream route had.
 *
 * The G3 regression (2026-08-10): a request whose signal aborted DURING the
 * caller's baseline load must never open the vendor stream — per spec, a
 * listener added to an already-aborted signal never fires, so the stream
 * has to check `signal.aborted` before registering it.
 */

const h = vi.hoisted(() => ({
  streamPrices: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/market-data/massive', () => ({
  massiveProvider: { streamPrices: h.streamPrices },
}));

import type { HoldingQuote } from '@/lib/holdings/live-payload';
import { quoteStreamResponse } from '@/lib/holdings/stream-response';

function quotes(): ReadonlyMap<string, HoldingQuote> {
  return new Map([
    [
      'AAPL',
      {
        price: '123.45',
        currency: 'USD',
        prevClose: '120.00',
        dayChangeAmt: '3.45',
        dayChangePct: '2.88',
        extendedChangePct: null,
        extendedKind: null,
        extendedLive: false,
        extendedEndedAtMs: null,
      },
    ],
  ]);
}

function streamRequest(signal?: AbortSignal): Request {
  return new Request('http://localhost/api/mobile/v1/live/stream', { signal });
}

async function readAll(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) throw new Error('expected a stream body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

function openOptions(overrides: Partial<Parameters<typeof quoteStreamResponse>[1]> = {}) {
  return {
    status: 'open' as const,
    pollingResumesAtMs: null,
    hasPollableSymbols: true,
    quotes: quotes(),
    compose: () => ({ payload: 'stub' }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.streamPrices.mockResolvedValue({ close: vi.fn() });
});

describe('quoteStreamResponse — idle short-circuit', () => {
  it('a fully closed market answers idle and opens no vendor socket', async () => {
    const response = quoteStreamResponse(
      streamRequest(),
      openOptions({ status: 'closed', hasPollableSymbols: true }),
    );
    expect(await response.text()).toContain('event: idle');
    expect(h.streamPrices).not.toHaveBeenCalled();
  });
});

describe('quoteStreamResponse — abort discipline (G3 regression)', () => {
  it('a disconnect during the baseline load opens no vendor socket and ends empty', async () => {
    const controller = new AbortController();
    // The client navigated away while the caller was still loading inputs —
    // the request signal is already aborted by the time the stream starts,
    // so the abort listener alone would never fire.
    controller.abort();

    const response = quoteStreamResponse(streamRequest(controller.signal), openOptions());
    const body = await readAll(response);

    expect(body).toBe(''); // no baseline frame for a reader that is gone
    expect(h.streamPrices).not.toHaveBeenCalled();
  });

  it('a live connection still sends the baseline, opens the vendor stream, and releases it on abort', async () => {
    const handle = { close: vi.fn() };
    h.streamPrices.mockResolvedValue(handle);
    const controller = new AbortController();

    const response = quoteStreamResponse(streamRequest(controller.signal), openOptions());
    const body = response.body;
    if (body === null) throw new Error('expected a stream body');
    const reader = body.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: payload');
    expect(h.streamPrices).toHaveBeenCalledTimes(1);

    // The client disconnects mid-stream: the registered abort listener must
    // release the refcounted vendor handle immediately.
    controller.abort();
    const rest = await reader.read();
    expect(rest.done).toBe(true);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
