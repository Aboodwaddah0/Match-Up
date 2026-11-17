import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gracefulShutdown } from '../src/lib/shutdown';
import { resetDb, startApp } from './helpers/client';
import { makeUser } from './helpers/users';

const log = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bare HTTP server whose handler we control (to hold requests open on purpose). */
async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('graceful shutdown (OPS-07)', () => {
  let api: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    api = await startApp();
    await resetDb();
  });
  afterAll(async () => {
    const { closeRealtime } = await import('../src/lib/realtime');
    await closeRealtime();
    await api.close();
    const { prisma } = await import('../src/lib/prisma');
    await prisma.$disconnect();
  });

  it('with a live Socket.IO client it finishes promptly with code 0 (it used to wait the full timeout and exit 1)', async () => {
    const { attachRealtime, closeRealtime } = await import('../src/lib/realtime');
    attachRealtime(api.server);
    const user = await makeUser(api, 'ws@example.com');
    const sock = connect(api.base, { auth: { token: user.token }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((r) => sock.on('connect', () => r()));
    const dropped = new Promise<string>((r) => sock.on('disconnect', (reason) => r(reason)));

    const order: string[] = [];
    const started = Date.now();
    const code = await gracefulShutdown({
      server: api.server,
      closeRealtime,
      stopJobs: async () => { order.push('jobs'); },
      disconnectDb: async () => { order.push('db'); },
      timeoutMs: 5000,
      log,
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(order).toEqual(['jobs', 'db']);
    expect(await dropped).toBeTruthy(); // the client was disconnected by the server
    expect(api.server.listening).toBe(false);
  });
});

describe('graceful shutdown with plain HTTP servers', () => {
  it('lets a request that is already in flight finish before exiting', async () => {
    const { server, base } = await listen((_req, res) => setTimeout(() => res.end('done'), 300));
    const response = fetch(base).then((r) => r.text());
    await sleep(60);
    const started = Date.now();
    const code = await gracefulShutdown({ server, closeRealtime: async () => {}, stopJobs: async () => {}, disconnectDb: async () => {}, timeoutMs: 3000, log });
    expect(await response).toBe('done');
    expect(code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('waits for a running sweeper before closing the database', async () => {
    const { server } = await listen((_req, res) => res.end('ok'));
    const order: string[] = [];
    const code = await gracefulShutdown({
      server,
      closeRealtime: async () => {},
      stopJobs: async () => { await sleep(200); order.push('jobs finished'); },
      disconnectDb: async () => { order.push('db closed'); },
      timeoutMs: 3000,
      log,
    });
    expect(code).toBe(0);
    expect(order).toEqual(['jobs finished', 'db closed']);
  });

  it('cuts a request that never finishes after the timeout and reports 1, still closing the database', async () => {
    const { server, base } = await listen(() => { /* never answers */ });
    const stuck = fetch(base).then(() => 'answered', () => 'cut');
    await sleep(60);
    const order: string[] = [];
    const started = Date.now();
    const code = await gracefulShutdown({ server, closeRealtime: async () => {}, stopJobs: async () => {}, disconnectDb: async () => { order.push('db closed'); }, timeoutMs: 400, log });
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(await stuck).toBe('cut');
    expect(order).toContain('db closed');
  });
});
