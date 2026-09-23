import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const envValues = {
  APNS_KEY_ID: 'KEY123',
  APNS_TEAM_ID: 'TEAM123',
  // Any base64 string: the signing step is stubbed out below, so the PEM is
  // never parsed.
  APNS_PRIVATE_KEY: Buffer.from('pem').toString('base64'),
  APNS_BUNDLE_ID: 'com.example.app',
  APNS_ENVIRONMENT: 'sandbox' as 'sandbox' | 'production',
};
vi.mock('@/lib/env', () => ({ env: () => envValues }));

// The JWT is irrelevant to routing and signing a fake PEM would throw.
vi.mock('node:crypto', () => ({
  createSign: () => ({ update: () => ({ sign: () => Buffer.from('sig') }) }),
}));

/** Per-host scripted replies, keyed by device token. */
interface Reply {
  status: number;
  body?: string;
}
const script = new Map<string, Reply>();
const attempts: Array<{ host: string; token: string }> = [];

function key(host: string, token: string): string {
  return `${host}|${token}`;
}

const connect = vi.fn((url: string) => {
  const host = url.replace('https://', '');
  return {
    on: () => {},
    close: () => {},
    request: (headers: Record<string, string>) => {
      const token = headers[':path'].replace('/3/device/', '');
      attempts.push({ host, token });
      const reply = script.get(key(host, token)) ?? { status: 500 };
      const listeners = new Map<string, (arg?: unknown) => void>();
      return {
        on(event: string, handler: (arg?: unknown) => void) {
          listeners.set(event, handler);
        },
        end() {
          queueMicrotask(() => {
            listeners.get('response')?.({ ':status': reply.status });
            if (reply.body) listeners.get('data')?.(Buffer.from(reply.body));
            listeners.get('end')?.();
          });
        },
      };
    },
  };
});
vi.mock('node:http2', () => ({ default: { connect: (url: string) => connect(url) } }));

const { APNS_PRODUCTION_HOST, APNS_SANDBOX_HOST, classifyResponse, otherHost, sendPushAlert } =
  await import('./apns');

const alert = { title: 'T', body: 'B', urlScheme: 'stockhodl://ticker/AAPL' };
const badToken = JSON.stringify({ reason: 'BadDeviceToken' });

beforeEach(() => {
  script.clear();
  attempts.length = 0;
  connect.mockClear();
  envValues.APNS_ENVIRONMENT = 'sandbox';
});

describe('classifyResponse', () => {
  it('reads 200 as delivered', () => {
    expect(classifyResponse(200, '')).toBe('delivered');
  });

  it('reads only Unregistered as a token that may be deleted', () => {
    expect(classifyResponse(410, JSON.stringify({ reason: 'Unregistered' }))).toBe('invalid-token');
    expect(classifyResponse(400, badToken)).not.toBe('invalid-token');
  });

  it('reads BadDeviceToken as a wrong-host signal, not a failure', () => {
    expect(classifyResponse(400, badToken)).toBe('wrong-host');
  });

  it('falls back to error for an unparseable body', () => {
    expect(classifyResponse(503, '<html>nope</html>')).toBe('error');
  });
});

describe('otherHost', () => {
  it('flips both ways', () => {
    expect(otherHost(APNS_SANDBOX_HOST)).toBe(APNS_PRODUCTION_HOST);
    expect(otherHost(APNS_PRODUCTION_HOST)).toBe(APNS_SANDBOX_HOST);
  });
});

describe('sendPushAlert', () => {
  it('delivers a production token even though the env says sandbox', async () => {
    script.set(key(APNS_SANDBOX_HOST, 'prod-tok'), { status: 400, body: badToken });
    script.set(key(APNS_PRODUCTION_HOST, 'prod-tok'), { status: 200 });

    const outcomes = await sendPushAlert(['prod-tok'], alert);

    expect(outcomes.get('prod-tok')).toBe('delivered');
    expect(attempts).toEqual([
      { host: APNS_SANDBOX_HOST, token: 'prod-tok' },
      { host: APNS_PRODUCTION_HOST, token: 'prod-tok' },
    ]);
  });

  it('retries in the other direction when the env says production', async () => {
    envValues.APNS_ENVIRONMENT = 'production';
    script.set(key(APNS_PRODUCTION_HOST, 'cable-tok'), { status: 400, body: badToken });
    script.set(key(APNS_SANDBOX_HOST, 'cable-tok'), { status: 200 });

    expect((await sendPushAlert(['cable-tok'], alert)).get('cable-tok')).toBe('delivered');
    expect(attempts.map((a) => a.host)).toEqual([APNS_PRODUCTION_HOST, APNS_SANDBOX_HOST]);
  });

  it('retries only the misrouted tokens, on one extra connection', async () => {
    script.set(key(APNS_SANDBOX_HOST, 'ok-tok'), { status: 200 });
    script.set(key(APNS_SANDBOX_HOST, 'prod-tok'), { status: 400, body: badToken });
    script.set(key(APNS_PRODUCTION_HOST, 'prod-tok'), { status: 200 });

    const outcomes = await sendPushAlert(['ok-tok', 'prod-tok'], alert);

    expect([...outcomes.values()]).toEqual(['delivered', 'delivered']);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(attempts.filter((a) => a.host === APNS_PRODUCTION_HOST)).toEqual([
      { host: APNS_PRODUCTION_HOST, token: 'prod-tok' },
    ]);
  });

  it('opens no second connection when nothing was misrouted', async () => {
    script.set(key(APNS_SANDBOX_HOST, 'ok-tok'), { status: 200 });

    await sendPushAlert(['ok-tok'], alert);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('calls a token both hosts reject an error, never a deletion', async () => {
    script.set(key(APNS_SANDBOX_HOST, 'junk'), { status: 400, body: badToken });
    script.set(key(APNS_PRODUCTION_HOST, 'junk'), { status: 400, body: badToken });

    expect((await sendPushAlert(['junk'], alert)).get('junk')).toBe('error');
  });

  it('still deletes on Unregistered without retrying', async () => {
    script.set(key(APNS_SANDBOX_HOST, 'gone'), {
      status: 410,
      body: JSON.stringify({ reason: 'Unregistered' }),
    });

    expect((await sendPushAlert(['gone'], alert)).get('gone')).toBe('invalid-token');
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
