import 'server-only';

import { createSign } from 'node:crypto';
import http2 from 'node:http2';

import { env } from '@/lib/env';

/**
 * The ONE file in this repo allowed to know the APNs HTTP/2 endpoint or hold
 * the `.p8` provider key — the same single-door rule `massive.ts` and
 * `massive-stream.ts` follow for the market-data vendor.
 *
 * Sends via Apple's provider-authentication token scheme (a self-signed ES256
 * JWT, no persistent connection to Apple's own auth service), which is why
 * there is no third-party JWT dependency here: Node's `crypto.createSign`
 * already speaks ES256 with `dsaEncoding: 'ieee-p1363'` (the raw
 * r‖s JOSE form APNs expects, not the DER form `sign()` produces by default).
 */

interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** PEM, decoded from the base64 env value. */
  privateKey: string;
  bundleId: string;
  /** The host `APNS_ENVIRONMENT` selects — tried first for every token. */
  host: string;
  /** The other host, tried only for a token APNs calls `BadDeviceToken`. */
  fallbackHost: string;
}

export const APNS_PRODUCTION_HOST = 'api.push.apple.com';
export const APNS_SANDBOX_HOST = 'api.sandbox.push.apple.com';

/**
 * A provider token is valid at BOTH hosts, so the same signed JWT can be
 * replayed against the other one — nothing but the connection changes.
 */
export function otherHost(host: string): string {
  return host === APNS_PRODUCTION_HOST ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;
}

function loadConfig(): ApnsConfig | null {
  const e = env();
  if (!e.APNS_KEY_ID || !e.APNS_TEAM_ID || !e.APNS_PRIVATE_KEY || !e.APNS_BUNDLE_ID) return null;

  const host = e.APNS_ENVIRONMENT === 'production' ? APNS_PRODUCTION_HOST : APNS_SANDBOX_HOST;

  return {
    keyId: e.APNS_KEY_ID,
    teamId: e.APNS_TEAM_ID,
    privateKey: Buffer.from(e.APNS_PRIVATE_KEY, 'base64').toString('utf8'),
    bundleId: e.APNS_BUNDLE_ID,
    host,
    fallbackHost: otherHost(host),
  };
}

function base64url(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Apple mandates re-signing at least once an hour; cached for 55 minutes so
 * a long-running cron run never straddles the boundary mid-batch.
 */
const TOKEN_TTL_MS = 55 * 60 * 1000;
let cachedToken: { jwt: string; mintedAt: number } | undefined;

function signProviderToken(config: ApnsConfig): string {
  const now = Date.now();
  if (cachedToken && now - cachedToken.mintedAt < TOKEN_TTL_MS) return cachedToken.jwt;

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const payload = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: config.privateKey, dsaEncoding: 'ieee-p1363' });

  const jwt = `${signingInput}.${base64url(signature)}`;
  cachedToken = { jwt, mintedAt: now };
  return jwt;
}

export type ApnsOutcome = 'delivered' | 'invalid-token' | 'error';

/**
 * What one token's response means. `wrongHost` is the retry signal and is
 * never returned to the caller — it is resolved internally by replaying the
 * token against the other APNs host.
 */
export type ApnsVerdict = 'delivered' | 'invalid-token' | 'wrong-host' | 'error';

/**
 * Turns one APNs response into a verdict. Exported because the retry hinges
 * entirely on this call: get `BadDeviceToken` wrong and either every push
 * costs a doubled round trip, or none of them recover.
 *
 * `410 Unregistered` is the ONLY permanent-death signal, and the only one that
 * may delete a row.
 *
 * `400 BadDeviceToken` is Apple's "this token does not belong to this
 * environment" — the SAME response for a token minted by the other kind of
 * build and for a token that is simply malformed. It is never fatal here: a
 * TestFlight build's production token checked against a sandbox
 * `APNS_ENVIRONMENT` (or the reverse, after a cabled Xcode run) would
 * otherwise delete every legitimate device on the first cron run and force a
 * re-toggle in Settings.
 */
export function classifyResponse(status: number, rawBody: string): ApnsVerdict {
  if (status === 200) return 'delivered';

  let reason = '';
  try {
    reason = (JSON.parse(rawBody) as { reason?: string }).reason ?? '';
  } catch {
    /* an unparseable body is not itself informative — status already is */
  }

  if (status === 410 || reason === 'Unregistered') return 'invalid-token';
  if (reason === 'BadDeviceToken') return 'wrong-host';
  return 'error';
}

export interface PushAlert {
  title: string;
  body: string;
  /** e.g. `stockhodl://ticker/AAPL` — carried in the payload's custom `url` field. */
  urlScheme: string;
}

function sendOne(
  client: http2.ClientHttp2Session,
  config: ApnsConfig,
  jwt: string,
  token: string,
  alert: PushAlert,
): Promise<ApnsVerdict> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' },
      url: alert.urlScheme,
    });

    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status = 0;
    let raw = '';
    request.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      const verdict = classifyResponse(status, raw);
      if (verdict === 'error') console.error(`[apns] push failed status=${status} body=${raw}`);
      resolve(verdict);
    });
    request.on('error', (error) => {
      console.error('[apns] request error', error);
      resolve('error');
    });
    request.end(body);
  });
}

/**
 * Sends one alert to every token over a single HTTP/2 connection to `host`.
 * Never throws: a dead connection degrades every token to `'error'` rather
 * than sinking the whole cron run.
 */
async function sendBatch(
  host: string,
  tokens: readonly string[],
  config: ApnsConfig,
  jwt: string,
  alert: PushAlert,
): Promise<Map<string, ApnsVerdict>> {
  const verdicts = new Map<string, ApnsVerdict>();
  const client = http2.connect(`https://${host}`);
  client.on('error', (error) => console.error(`[apns] connection error (${host})`, error));

  try {
    // Sequential on purpose: one shared HTTP/2 connection sends its streams
    // one at a time here; a fan-out would need one connection per token for
    // no benefit at this volume.
    for (const token of tokens) {
      verdicts.set(token, await sendOne(client, config, jwt, token, alert));
    }
  } finally {
    client.close();
  }
  return verdicts;
}

/**
 * Sends one alert to every token. Returns per-token outcomes so the caller
 * (`/api/cron/check-price-alerts`) can prune tokens APNs reports gone for
 * good. Never throws.
 *
 * A token APNs answers `BadDeviceToken` for is replayed once against the OTHER
 * host before it is called an error. Sandbox and production tokens are
 * separate universes and the phone decides which one it holds — a TestFlight
 * install mints production tokens, the same build run from Xcode over a cable
 * mints sandbox ones — so `APNS_ENVIRONMENT` is only ever right for one of
 * them at a time. Retrying costs a second connection for exactly the tokens
 * that were going to fail anyway, and buys a server that keeps pushing
 * correctly to both while the env var says whatever it says.
 */
export async function sendPushAlert(
  tokens: readonly string[],
  alert: PushAlert,
): Promise<Map<string, ApnsOutcome>> {
  const outcomes = new Map<string, ApnsOutcome>();
  if (tokens.length === 0) return outcomes;

  const config = loadConfig();
  if (!config) {
    for (const token of tokens) outcomes.set(token, 'error');
    return outcomes;
  }

  const jwt = signProviderToken(config);
  const verdicts = await sendBatch(config.host, tokens, config, jwt, alert);

  const misrouted = [...verdicts].filter(([, v]) => v === 'wrong-host').map(([token]) => token);
  if (misrouted.length > 0) {
    console.warn(
      `[apns] ${misrouted.length} token(s) rejected by ${config.host}; retrying at ${config.fallbackHost}`,
    );
    const retried = await sendBatch(config.fallbackHost, misrouted, config, jwt, alert);
    for (const [token, verdict] of retried) verdicts.set(token, verdict);
  }

  for (const [token, verdict] of verdicts) {
    // A token both hosts reject is a real failure, but still not a deletion:
    // only `410 Unregistered` ever prunes a row.
    outcomes.set(token, verdict === 'wrong-host' ? 'error' : verdict);
  }
  return outcomes;
}
