import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { expoClient, expoTimeouts, ExpoRequestError, type ExpoMessage } from '../src/lib/expo-push';
import { resetDb } from './helpers/client';
import { addNotification, channelState, deliveries, makeReceiptsDue, prismaP, pushUser, pushWorker } from './helpers/push';

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}
type Reply = { status?: number; body?: unknown; raw?: string; delayMs?: number };

let server: http.Server;
let base = '';
let seen: Seen[] = [];
let reply: (req: Seen) => Reply = () => ({ status: 200, body: { data: [] } });

const originalBase = env.EXPO_API_BASE_URL;
const originalToken = env.EXPO_ACCESS_TOKEN;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const s: Seen = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(s);
      const r = reply(s);
      const send = () => {
        res.statusCode = r.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(r.raw ?? JSON.stringify(r.body ?? {}));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  env.EXPO_API_BASE_URL = originalBase;
  env.EXPO_ACCESS_TOKEN = originalToken;
  await new Promise((resolve) => server.close(resolve));
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  seen = [];
  env.EXPO_API_BASE_URL = base;
  env.EXPO_ACCESS_TOKEN = undefined;
  expoTimeouts.requestMs = 5_000;
  await resetDb();
});
afterEach(() => {
  expoTimeouts.requestMs = 20_000;
});

const message = (to = 'ExponentPushToken[abcdefghijklmn]'): ExpoMessage => ({ to, title: 't', body: 'b', data: { a: 1 }, ttl: 86_400, priority: 'high', sound: 'default', collapseId: 'c', tag: 'c' });
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ExpoRequestError;
  }
  throw new Error('expected the request to fail');
};

describe('the Expo client', () => {
  it('POSTs a JSON array of messages to /--/api/v2/push/send and returns the tickets in order', async () => {
    reply = (req) => ({ body: { data: (req.body as unknown[]).map((_, i) => ({ status: 'ok', id: `id-${i}` })) } });
    const tickets = await expoClient.send([message('ExponentPushToken[aaaaaaaaaaaa]'), message('ExponentPushToken[bbbbbbbbbbbb]')]);
    expect(tickets).toEqual([{ status: 'ok', id: 'id-0' }, { status: 'ok', id: 'id-1' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/--/api/v2/push/send' });
    expect(seen[0]!.headers['content-type']).toContain('application/json');
    expect(seen[0]!.headers.accept).toContain('application/json');
    expect(seen[0]!.body).toHaveLength(2);
    expect((seen[0]!.body as ExpoMessage[])[0]).toMatchObject({ to: 'ExponentPushToken[aaaaaaaaaaaa]', collapseId: 'c', tag: 'c', ttl: 86_400, priority: 'high' });
  });

  it('sends no Authorization header without an access token, and "Bearer <token>" with one', async () => {
    reply = () => ({ body: { data: [{ status: 'ok', id: 'x' }] } });
    await expoClient.send([message()]);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    env.EXPO_ACCESS_TOKEN = 'my-secret-access-token';
    await expoClient.send([message()]);
    expect(seen[1]!.headers.authorization).toBe('Bearer my-secret-access-token');
  });

  it('getReceipts POSTs {ids} to /--/api/v2/push/getReceipts; an id with no receipt is simply absent', async () => {
    reply = () => ({ body: { data: { a: { status: 'ok' }, b: { status: 'error', message: 'm', details: { error: 'DeviceNotRegistered' } } } } });
    const receipts = await expoClient.getReceipts(['a', 'b', 'c']);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/--/api/v2/push/getReceipts', body: { ids: ['a', 'b', 'c'] } });
    expect(Object.keys(receipts).sort()).toEqual(['a', 'b']);
    expect(receipts.b).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered' } });
  });

  describe('failures are classified, never guessed', () => {
    it.each([
      [401, undefined],
      [403, undefined],
      [400, [{ code: 'UNAUTHORIZED', message: 'x' }]],
      [200, [{ code: 'UNAUTHORIZED', message: 'x' }]],
    ])('HTTP %i / errors %j is an AUTHENTICATION failure', async (status, errors) => {
      reply = () => ({ status, body: errors ? { errors } : {} });
      const e = await fails(expoClient.send([message()]));
      expect(e).toBeInstanceOf(ExpoRequestError);
      expect(e).toMatchObject({ kind: 'AUTH' });
    });

    it.each([
      [429, undefined],
      [400, [{ code: 'TOO_MANY_REQUESTS', message: 'x' }]],
    ])('HTTP %i / errors %j is a RATE LIMIT', async (status, errors) => {
      reply = () => ({ status, body: errors ? { errors } : {} });
      expect(await fails(expoClient.send([message()]))).toMatchObject({ kind: 'RATE_LIMIT', code: 'TOO_MANY_REQUESTS' });
    });

    it.each([500, 502, 503])('HTTP %i is transient', async (status) => {
      reply = () => ({ status, body: {} });
      expect(await fails(expoClient.send([message()]))).toMatchObject({ kind: 'TRANSIENT', code: `HTTP_${status}`, httpStatus: status });
    });

    it('another request-level error code is transient (the whole batch is retried, nothing is guessed)', async () => {
      reply = () => ({ status: 400, body: { errors: [{ code: 'PUSH_TOO_MANY_NOTIFICATIONS', message: 'x' }] } });
      expect(await fails(expoClient.send([message()]))).toMatchObject({ kind: 'TRANSIENT' });
    });

    it.each([
      ['not JSON', { raw: 'oops' }],
      ['no data', { body: {} }],
      ['data is not an array', { body: { data: { a: 1 } } }],
      ['fewer tickets than messages', { body: { data: [] } }],
      ['a ticket without a status', { body: { data: [{ id: 'x' }] } }],
    ])('an unusable answer (%s) is transient: tickets are never matched to messages by guessing', async (_name, r) => {
      reply = () => ({ status: 200, ...r });
      expect(await fails(expoClient.send([message()]))).toMatchObject({ kind: 'TRANSIENT', code: 'BAD_RESPONSE' });
    });

    it('a receipts answer that is not an object is unusable', async () => {
      reply = () => ({ body: { data: [] } });
      expect(await fails(expoClient.getReceipts(['a']))).toMatchObject({ kind: 'TRANSIENT', code: 'BAD_RESPONSE' });
    });

    it('a refused connection is transient (NETWORK)', async () => {
      env.EXPO_API_BASE_URL = 'http://127.0.0.1:1';
      expect(await fails(expoClient.send([message()]))).toMatchObject({ kind: 'TRANSIENT', code: 'NETWORK' });
    });

    it('a server that never answers is cut off by the request time limit (TIMEOUT)', async () => {
      expoTimeouts.requestMs = 150;
      reply = () => ({ delayMs: 1_500, body: { data: [] } });
      const started = Date.now();
      expect(await fails(expoClient.send([message()]))).toMatchObject({ kind: 'TRANSIENT', code: 'TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(1_200);
    });
  });

  it('an error never contains the access token, the device token, or anything from the response body', async () => {
    env.EXPO_ACCESS_TOKEN = 'SUPER-SECRET-ACCESS-TOKEN';
    for (const r of [{ status: 500, body: { leak: 'LEAK-FROM-BODY', errors: [{ code: 'X', message: 'LEAK-FROM-BODY' }] } }, { status: 401, body: { errors: [{ code: 'UNAUTHORIZED', message: 'LEAK-FROM-BODY' }] } }]) {
      reply = () => r;
      const e = await fails(expoClient.send([message('ExponentPushToken[device-secret-1]')]));
      const text = `${e.message} ${e.stack} ${inspect(e, { depth: 6 })} ${JSON.stringify(e)}`;
      for (const secret of ['SUPER-SECRET-ACCESS-TOKEN', 'LEAK-FROM-BODY', 'device-secret-1']) expect(text).not.toContain(secret);
    }
  });
});

describe('the worker with the REAL client against a local fake Expo', () => {
  const expoLike = () => {
    let n = 0;
    reply = (req) => {
      if (req.url === '/--/api/v2/push/send') return { body: { data: (req.body as unknown[]).map(() => ({ status: 'ok', id: `T${++n}` })) } };
      const ids = (req.body as { ids: string[] }).ids;
      return { body: { data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) } };
    };
  };

  it('sends, records the ticket, and later turns the receipt into DELIVERED', async () => {
    expoLike();
    const u = await pushUser('real@example.com');
    await addNotification(u.userId, 'MATCH_INVITATION', { title: 'Friday 7v7' });
    env.EXPO_ACCESS_TOKEN = 'the-access-token';
    const { runPushWorkerOnce } = await pushWorker();
    expect(await runPushWorkerOnce({ client: expoClient })).toMatchObject({ accepted: 1 });
    expect(seen[0]!.headers.authorization).toBe('Bearer the-access-token');
    expect(seen[0]!.body).toMatchObject([{ to: u.tokens[0]!.token, title: 'Match invitation' }]);
    await makeReceiptsDue();
    expect(await runPushWorkerOnce({ client: expoClient })).toMatchObject({ delivered: 1 });
    expect(await deliveries()).toMatchObject([{ status: 'DELIVERED' }]);
  });

  it('when Expo answers 401 the channel pauses, the work is kept, and no secret reaches the logs', async () => {
    const { logger } = await import('../src/lib/logger');
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((l) => vi.spyOn(logger, l));
    try {
      reply = () => ({ status: 401, body: { errors: [{ code: 'UNAUTHORIZED', message: 'LEAK-FROM-BODY' }] } });
      const u = await pushUser('real401@example.com');
      await addNotification(u.userId, 'MATCH_INVITATION', { title: 'Hidden title' });
      env.EXPO_ACCESS_TOKEN = 'the-access-token-4711';
      const { runPushWorkerOnce } = await pushWorker();
      expect((await runPushWorkerOnce({ client: expoClient })).paused).toEqual(['SEND']);
      expect(await channelState('SEND')).toMatchObject({ status: 'AUTH_FAILED', lastErrorCode: 'UNAUTHORIZED' });
      expect(await deliveries()).toMatchObject([{ status: 'PENDING', attempts: 0 }]);
      const logged = inspect(spies.flatMap((s) => s.mock.calls), { depth: 8, breakLength: Infinity });
      for (const secret of ['the-access-token-4711', 'LEAK-FROM-BODY', u.tokens[0]!.token, 'Hidden title']) expect(logged).not.toContain(secret);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
