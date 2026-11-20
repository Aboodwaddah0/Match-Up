import * as Sentry from '@sentry/node';
import express from 'express';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/lib/errors';
import { captureUnexpected, closeSentryForTests, flushSentry, initSentry, redactText, sentryEnabled, sentryEnvironment, TRACES_SAMPLE_RATE } from '../src/lib/sentry';
import { errorHandler, notFoundHandler } from '../src/middleware/error-handler';
import { startApp } from './helpers/client';

/*
 * Sentry error tracking (D20). No account and no network: the SDK is initialised with a fake DSN and a transport that stores every
 * envelope it would have sent. The assertions read those envelopes, i.e. the real payload after the SDK pipeline and our beforeSend
 * hook, not the scrubbing helpers in isolation.
 */

const FAKE_DSN = 'https://publickey@o0.ingest.sentry.io/0';

// Secrets that must never appear in anything sent.
const PASSWORD = 'hunter2-Correct-Horse';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const REFRESH = 'rT9fQ2xLmB7vWk3ZpYc8NdHsA1eUoJ6iXgVb0TyMqRw';
const COOKIE = 'session=abc123supersecretcookie';
const EMAIL = 'alice.private@example.com';
const DB_URL = 'postgresql://fym:dbpassword99@db.internal:5432/fym';
const SIGNATURE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

const sent: unknown[][] = [];
const transport: NonNullable<Sentry.NodeOptions['transport']> = () => ({
  send: async (envelope) => {
    sent.push(envelope as unknown as unknown[]);
    return {};
  },
  flush: async () => true,
});

/** Every error event that was sent, as parsed objects. */
function errorEvents(): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const env of sent) for (const item of (env[1] as [{ type: string }, Record<string, any>][]) ?? []) if (item[0].type === 'event') out.push(item[1]);
  return out;
}
const everythingSent = () => JSON.stringify(sent);

/** A small app with the REAL error handler and a few routes that fail in different ways. */
function failingApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { id: string }).id = 'req-test-0001';
    next();
  });
  app.post('/boom', () => {
    throw new Error(`Unexpected failure for ${EMAIL} using ${DB_URL} with Bearer ${JWT}`);
  });
  app.get('/boom', async () => {
    throw new Error('async failure');
  });
  app.get('/app-error', () => {
    throw new AppError(409, 'CONFLICT', 'expected business error');
  });
  app.get('/app-error-503', () => {
    throw new AppError(503, 'MEDIA_PROVIDER_UNAVAILABLE', 'expected, even though 5xx');
  });
  app.get('/zod', () => {
    z.object({ a: z.string() }).parse({});
  });
  app.get('/bad-json', express.json(), () => undefined);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('Sentry is off without a DSN', () => {
  it('a missing DSN keeps it off', () => {
    expect(initSentry({})).toBe(false);
    expect(sentryEnabled()).toBe(false);
  });

  it('an empty or blank DSN keeps it off', () => {
    expect(initSentry({ dsn: '' })).toBe(false);
    expect(initSentry({ dsn: '   ' })).toBe(false);
    expect(sentryEnabled()).toBe(false);
  });

  it('a malformed DSN keeps it off and does not throw', () => {
    expect(initSentry({ dsn: 'not a url' })).toBe(false);
    expect(sentryEnabled()).toBe(false);
  });

  it('capturing and flushing do nothing and do not throw while it is off', async () => {
    expect(() => captureUnexpected(new Error('x'), 'r1')).not.toThrow();
    await flushSentry();
    expect(sent).toHaveLength(0);
  });

  it('the API still answers normally (an unexpected error is a plain 500) without Sentry', async () => {
    const server = failingApp().listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(base + '/boom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId: 'req-test-0001' } });
    } finally {
      server.close();
    }
  });

  it('the real application starts and serves requests with no Sentry configuration', async () => {
    const api = await startApp();
    try {
      const res = await fetch(api.base + '/health');
      expect(res.status).toBe(200);
    } finally {
      await api.close();
    }
  });
});

describe('Sentry is on with a DSN', () => {
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let base = '';

  beforeAll(() => {
    expect(initSentry({ dsn: FAKE_DSN, transport })).toBe(true);
    server = failingApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    server.close();
    await closeSentryForTests();
  });

  it('initialises with a valid DSN, 10% tracing and an environment name', () => {
    expect(sentryEnabled()).toBe(true);
    expect(TRACES_SAMPLE_RATE).toBe(0.1);
    const client = Sentry.getClient();
    expect(client?.getOptions().tracesSampleRate).toBe(0.1);
    expect(client?.getOptions().sampleRate).toBe(1);
    expect((client?.getOptions() as { includeLocalVariables?: boolean }).includeLocalVariables).toBe(false);
    expect(client?.getOptions().environment).toBe('development'); // NODE_ENV=test is not production
    expect(['development', 'staging', 'production']).toContain(sentryEnvironment());
  });

  it('an unexpected error is captured once, with its stack and the request id', async () => {
    const res = await fetch(base + '/boom');
    expect(res.status).toBe(500);
    await flushSentry();
    const events = errorEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.exception.values[0].value).toBe('async failure');
    expect(ev.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0); // the stack trace stays useful
    expect(ev.tags.request_id).toBe('req-test-0001');
    expect(ev.environment).toBe('development');
  });

  it('the HTTP answer for an unexpected error is unchanged', async () => {
    const res = await fetch(base + '/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId: 'req-test-0001' } });
  });

  it('expected errors are not reported and keep their responses', async () => {
    const conflict = await fetch(base + '/app-error');
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');

    const unavailable = await fetch(base + '/app-error-503'); // a deliberate 5xx answer is still an expected error
    expect(unavailable.status).toBe(503);

    const validation = await fetch(base + '/zod');
    expect(validation.status).toBe(400);
    expect(((await validation.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const notFound = await fetch(base + '/no-such-route');
    expect(notFound.status).toBe(404);

    const badJson = await fetch(base + '/boom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json' });
    expect(badJson.status).toBe(400);

    await flushSentry();
    expect(errorEvents()).toHaveLength(0);
  });

  it('the same error object reported twice in a row is sent once (dedupe)', async () => {
    const err = new Error('same object');
    captureUnexpected(err, 'a');
    captureUnexpected(err, 'a');
    await flushSentry();
    expect(errorEvents()).toHaveLength(1);
  });

  it('nothing sensitive is in the sent payload: headers, cookies, body, query, user, breadcrumbs, extra', async () => {
    // Everything an instrumented server would put on the scope is put there by hand, to prove the real pipeline removes it.
    const scope = Sentry.getIsolationScope();
    scope.setUser({ id: 'u-123', email: EMAIL, ip_address: '203.0.113.7', username: 'alice' });
    scope.setExtra('requestBody', { password: PASSWORD });
    scope.setTag('authorization', `Bearer ${JWT}`);
    scope.setContext('req', { refreshToken: REFRESH, note: `contact ${EMAIL}` });
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        method: 'POST',
        url: `http://api.example.com/api/v1/auth/login?email=${EMAIL}&token=${REFRESH}&signature=${SIGNATURE}`,
        query_string: `email=${EMAIL}&token=${REFRESH}`,
        headers: { authorization: `Bearer ${JWT}`, cookie: COOKIE, 'set-cookie': COOKIE, 'x-api-key': 'k-123456' },
        cookies: { session: 'abc123supersecretcookie' },
        data: { email: EMAIL, password: PASSWORD, refreshToken: REFRESH },
      },
    });
    Sentry.addBreadcrumb({ category: 'console', message: `login for ${EMAIL} password ${PASSWORD}` });
    Sentry.addBreadcrumb({ category: 'http', message: `Bearer ${JWT}`, data: { url: `https://api.cloudinary.com/v1_1/x/upload?signature=${SIGNATURE}&api_key=1`, method: 'POST', token: REFRESH } });
    Sentry.addBreadcrumb({ category: 'app', message: 'connected', data: { databaseUrl: DB_URL, note: `to ${DB_URL}` } });
    try {
      const res = await fetch(base + `/boom?email=${EMAIL}&token=${REFRESH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${JWT}`, cookie: COOKIE },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, refreshToken: REFRESH }),
      });
      expect(res.status).toBe(500);
      await flushSentry();
    } finally {
      scope.setUser(null).setExtras({}).setTags({}).setContext('req', null).clearBreadcrumbs();
      scope.setSDKProcessingMetadata({ normalizedRequest: undefined });
    }

    const events = errorEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;

    // The message keeps its meaning but loses the secrets that were inside it.
    expect(ev.exception.values[0].value).toContain('Unexpected failure for');
    // Whole-payload check: not one secret anywhere in anything that was sent.
    const all = everythingSent();
    for (const secret of [PASSWORD, JWT, REFRESH, COOKIE, 'abc123supersecretcookie', EMAIL, DB_URL, 'dbpassword99', SIGNATURE, '203.0.113.7', 'k-123456']) {
      expect(all, `leaked: ${secret}`).not.toContain(secret);
    }
    // And structurally: no request body, headers, cookies or query string, no user, no extra.
    expect(ev.request?.data).toBeUndefined();
    expect(ev.request?.headers).toBeUndefined();
    expect(ev.request?.cookies).toBeUndefined();
    expect(ev.request?.query_string).toBeUndefined();
    expect(ev.request?.url ?? '').not.toContain('?');
    expect(ev.user).toBeUndefined();
    expect(ev.extra).toBeUndefined();
    expect((ev.breadcrumbs ?? []).some((b: { category?: string }) => b.category === 'console')).toBe(false);
  });

  it('the trace context of an error (a sampled request) carries no query string, headers or client address', async () => {
    const scope = Sentry.getIsolationScope();
    scope.setContext('trace', {
      trace_id: '1541a0d681dc4a0a966fcaac0e9c8b6c',
      span_id: 'bda3082df6408d2b',
      data: {
        'http.route': '/api/v1/venues',
        'url.full': 'http://api.example.com/api/v1/venues?lat=31.5&lng=35.1&email=' + EMAIL,
        'http.query': 'lat=31.5&lng=35.1',
        'http.request.header.authorization': 'Bearer ' + JWT,
        'client.address': '203.0.113.7',
      },
    });
    scope.setTransactionName('GET /api/v1/venues?lat=31.5');
    try {
      await fetch(base + '/boom');
      await flushSentry();
    } finally {
      scope.setContext('trace', null).setTransactionName('');
    }
    const ev = errorEvents()[0]!;
    expect(ev.contexts.trace.data['http.route']).toBe('/api/v1/venues'); // useful data stays
    const all = everythingSent();
    for (const leaked of ['lat=31.5', '203.0.113.7', EMAIL, JWT]) expect(all, `leaked: ${leaked}`).not.toContain(leaked);
    expect(ev.transaction ?? '').not.toContain('?');
  });

  it('a request body is never sent, even when the SDK is asked to collect one', async () => {
    const client = Sentry.getClient();
    expect(client?.getOptions().dataCollection).toEqual({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false });
    await fetch(base + '/boom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    await flushSentry();
    expect(everythingSent()).not.toContain(PASSWORD);
  });
});

describe('redactText', () => {
  it.each([
    [`token ${JWT} end`, JWT],
    [`Authorization: Bearer abc.def-ghi`, 'abc.def-ghi'],
    [`connect ${DB_URL} failed`, 'dbpassword99'],
    [`user ${EMAIL} not found`, EMAIL],
    [`refresh ${REFRESH}`, REFRESH],
  ])('removes the secret from %s', (text, secret) => {
    expect(redactText(text)).not.toContain(secret);
  });

  it('leaves ordinary messages and file paths alone', () => {
    expect(redactText('Cannot read properties of undefined (reading "id")')).toBe('Cannot read properties of undefined (reading "id")');
    expect(redactText('/app/src/modules/matches/matches.service.ts:120:15')).toBe('/app/src/modules/matches/matches.service.ts:120:15');
  });
});

describe('Sentry settings at start-up (a real process loads src/config/env.ts)', () => {
  const root = path.resolve(__dirname, '..');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const envUrl = pathToFileURL(path.join(root, 'src', 'config', 'env.ts')).href;

  function load(vars: Record<string, string>) {
    const r = spawnSync(process.execPath, [tsx, '-e', `import('${envUrl}').then((m) => console.log('LOADED ' + JSON.stringify({ dsn: m.env.SENTRY_DSN ?? null, e: m.env.SENTRY_ENVIRONMENT ?? null })))`], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', DATABASE_URL: 'postgresql://api:s3cr3t-pass@db.internal:5432/fym', JWT_ACCESS_SECRET: 'q7Zk2x9LmP4vR8sT1uWb6nYc3dEfGh5JkLpOiUyTrEwQaSdFgHjKlZxCvBnM', ...vars },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('nothing set, and empty values (what Docker Compose passes), start normally with Sentry off', () => {
    for (const vars of [{} as Record<string, string>, { SENTRY_DSN: '', SENTRY_ENVIRONMENT: '' }]) {
      const r = load(vars);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain('LOADED {"dsn":null,"e":null}');
    }
  });

  it('a DSN and an environment name are read; an unknown environment name is refused', () => {
    const ok = load({ SENTRY_DSN: FAKE_DSN, SENTRY_ENVIRONMENT: 'staging' });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain(`LOADED {"dsn":"${FAKE_DSN}","e":"staging"}`);
    const bad = load({ SENTRY_ENVIRONMENT: 'qa' });
    expect(bad.code).not.toBe(0);
  });
});
