import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers/client';

let api: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
});

const J = { 'content-type': 'application/json' };
const post = (body: string | Uint8Array, headers: Record<string, string> = J) => fetch(api.base + '/api/v1/auth/login', { method: 'POST', headers, body });
const asJson = async (res: Response) => (await res.json()) as { error: { code: string; message: string; requestId?: string } };

describe('client mistakes are answered with a 4xx, never a 500 (ERR-01)', () => {
  it('a body over the 1 MB limit -> 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await post(JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(2_000_000) }));
    expect(res.status).toBe(413);
    expect((await asJson(res)).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('an unknown Content-Encoding -> 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await post('junk', { ...J, 'content-encoding': 'weird-encoding' });
    expect(res.status).toBe(415);
    expect((await asJson(res)).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('a corrupt body declared as brotli -> 400, not 500', async () => {
    const res = await post('junk', { ...J, 'content-encoding': 'br' });
    expect(res.status).toBe(400);
  });

  it('a corrupt gzip body -> 400, not 500', async () => {
    const res = await post('this is not gzip', { ...J, 'content-encoding': 'gzip' });
    expect(res.status).toBe(400);
  });

  it('a valid gzip body is still accepted (and then fails validation normally)', async () => {
    const res = await post(gzipSync(JSON.stringify({ email: 'nobody@example.com', password: 'wrong' })), { ...J, 'content-encoding': 'gzip' });
    expect(res.status).toBe(401); // reached the login logic: unknown account
  });

  it('invalid JSON keeps answering 400 INVALID_JSON', async () => {
    const res = await post('{ not json');
    expect(res.status).toBe(400);
    expect((await asJson(res)).error.code).toBe('INVALID_JSON');
  });

  it('a wrong content type keeps answering 400 VALIDATION_ERROR', async () => {
    const res = await post('email=a', { 'content-type': 'text/plain' });
    expect(res.status).toBe(400);
    expect((await asJson(res)).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('every response carries a request id (OBS-01)', () => {
  it('generates one for successful and failing responses', async () => {
    const ok = await fetch(api.base + '/health');
    const id = ok.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const notFound = await fetch(api.base + '/api/v1/nope');
    expect(notFound.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(notFound.headers.get('x-request-id')).not.toBe(id);
  });

  it('puts the same id in the error body, so a user report can be matched to the log', async () => {
    const res = await post('{ not json');
    const header = res.headers.get('x-request-id');
    expect(header).toBeTruthy();
    expect((await asJson(res)).error.requestId).toBe(header);

    const unauthorized = await fetch(api.base + '/api/v1/users/me');
    expect(((await unauthorized.json()) as { error: { requestId: string } }).error.requestId).toBe(unauthorized.headers.get('x-request-id'));
  });

  it('keeps an id sent by the client when it is a plain token, and replaces anything else', async () => {
    const mine = 'mobile-app-0123456789';
    const kept = await fetch(api.base + '/health', { headers: { 'x-request-id': mine } });
    expect(kept.headers.get('x-request-id')).toBe(mine);

    for (const bad of ['short', 'has spaces in it 123456', 'x'.repeat(200), '<script>alert(1)</script>']) {
      const replaced = await fetch(api.base + '/health', { headers: { 'x-request-id': bad } });
      expect(replaced.headers.get('x-request-id')).not.toBe(bad);
      expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('exposes the header to browser clients (CORS)', async () => {
    const res = await fetch(api.base + '/health', { headers: { origin: 'https://example.test' } });
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Request-Id');
  });
});
