import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  badRequest,
  firstIssueMessage,
  isCrossSiteWrite,
  jsonError,
  jsonOk,
  notFound,
  parseJsonBody,
  parseQuery,
  unauthorized,
} from './respond';

/**
 * The plumbing every mobile handler leans on. Two things are worth pinning:
 * that NOTHING is cacheable (including errors — a 401 held in a proxy would
 * outlive the sign-out that caused it), and that a validation refusal reads
 * the same as the Server Actions' `ActionState.error`, so one message can
 * serve both clients.
 */

describe('response shapes', () => {
  it('marks every answer private and uncacheable — successes included', async () => {
    for (const response of [
      jsonOk({ ok: true }),
      jsonOk({ ok: true }, 201),
      jsonError('nope', 409),
      unauthorized(),
      notFound(),
      badRequest('bad'),
    ]) {
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });

  it('answers every failure with the one-field error shape', async () => {
    expect(await unauthorized().json()).toEqual({ error: 'Not signed in.' });
    expect(unauthorized().status).toBe(401);
    expect(await notFound().json()).toEqual({ error: 'Not found.' });
    expect(await notFound('Transaction not found.').json()).toEqual({
      error: 'Transaction not found.',
    });
    expect(badRequest('Expected a JSON body.').status).toBe(400);
  });
});

describe('isCrossSiteWrite', () => {
  const APP = 'https://sawa-finance.vercel.app';

  const req = (method: string, headers: Record<string, string> = {}) =>
    new Request(`${APP}/api/mobile/v1/transactions`, { method, headers });

  it('lets every read through, whatever the origin claims', () => {
    expect(isCrossSiteWrite(req('GET', { origin: 'https://evil.test' }), APP)).toBe(false);
    expect(isCrossSiteWrite(req('HEAD'), APP)).toBe(false);
  });

  it('refuses a cookie-authenticated write from another origin', () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect(isCrossSiteWrite(req(method, { origin: 'https://evil.test' }), APP)).toBe(true);
    }
  });

  it('refuses a write that names no origin at all', () => {
    // Browsers send Origin on every unsafe method, so its absence is either a
    // hand-rolled request or a stripped header. Neither earns the benefit of
    // the doubt now that proxy.ts no longer gates these paths.
    expect(isCrossSiteWrite(req('POST'), APP)).toBe(true);
  });

  it('allows the web app writing to itself', () => {
    expect(isCrossSiteWrite(req('POST', { origin: APP }), APP)).toBe(false);
  });

  it('allows a bearer write that carries no cookie — that is the phone', () => {
    expect(
      isCrossSiteWrite(req('POST', { authorization: 'Bearer tok.sig' }), APP),
    ).toBe(false);
    // …and it does not have to be a valid token to pass THIS gate: the token
    // still faces the HMAC check and the session lookup right after.
    expect(isCrossSiteWrite(req('DELETE', { authorization: 'Bearer nope' }), APP)).toBe(
      false,
    );
  });

  it('does not let a bogus Authorization header excuse a cookie session', () => {
    // Otherwise `Authorization: Bearer anything` is a general bypass: the
    // header is ignored downstream when it fails the HMAC, the request falls
    // through to the cookie, and the origin check never ran. The phone sends
    // no cookie, so requiring its absence costs the real client nothing.
    expect(
      isCrossSiteWrite(
        req('POST', {
          authorization: 'Bearer x',
          cookie: '__Host-session_token=abc',
          origin: 'https://evil.test',
        }),
        APP,
      ),
    ).toBe(true);
  });

  it('compares origins exactly, not by prefix', () => {
    expect(
      isCrossSiteWrite(req('POST', { origin: 'https://sawa-finance.vercel.app.evil.test' }), APP),
    ).toBe(true);
  });
});

describe('firstIssueMessage', () => {
  it('prefixes the field path, like the Server Actions do', () => {
    const schema = z.object({ quantity: z.string().min(1, 'Enter a valid number') });
    const result = schema.safeParse({ quantity: '' });
    expect(result.success).toBe(false);
    expect(firstIssueMessage(result.error!)).toBe('quantity: Enter a valid number');
  });

  it('passes a top-level issue through unprefixed', () => {
    // There is no field path to name, so the message must arrive verbatim —
    // zod's own text may itself contain a colon, which is why this compares
    // to the issue rather than looking for one.
    const result = z.string().safeParse(42);
    expect(firstIssueMessage(result.error!)).toBe(result.error!.issues[0].message);
  });
});

describe('parseJsonBody', () => {
  const schema = z.object({ name: z.string().min(1, 'Name is required') });

  const post = (body: string) =>
    new Request('https://example.test/api/mobile/v1/portfolios', {
      method: 'POST',
      body,
    });

  it('returns the parsed data on a valid body', async () => {
    const result = await parseJsonBody(post(JSON.stringify({ name: 'Main' })), schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.name).toBe('Main');
  });

  it('treats malformed JSON and a schema miss as the same 400', async () => {
    const malformed = await parseJsonBody(post('{not json'), schema);
    const wrongShape = await parseJsonBody(post(JSON.stringify({ name: '' })), schema);

    expect(malformed.ok).toBe(false);
    expect(wrongShape.ok).toBe(false);
    if (!malformed.ok) expect(malformed.response.status).toBe(400);
    if (!wrongShape.ok) expect(wrongShape.response.status).toBe(400);
  });
});

describe('parseQuery', () => {
  const schema = z.object({
    range: z.enum(['1D', '1Y']),
    portfolioId: z.string().optional(),
  });

  const get = (qs: string) =>
    new Request(`https://example.test/api/mobile/v1/series/portfolio${qs}`);

  it('reads the params', () => {
    const result = parseQuery(get('?range=1Y&portfolioId=abc'), schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ range: '1Y', portfolioId: 'abc' });
  });

  it('drops absent params rather than passing null, so .optional() works', () => {
    const result = parseQuery(get('?range=1D'), schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.portfolioId).toBeUndefined();
  });

  it('refuses a value outside the enum instead of coercing it', () => {
    const result = parseQuery(get('?range=7D'), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});
