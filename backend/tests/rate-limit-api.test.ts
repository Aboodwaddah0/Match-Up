import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  const { rateLimitTesting } = await import('../src/middleware/rate-limit');
  rateLimitTesting.enabled = true;
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

describe('creation limits are per signed-in user (SEC-03)', () => {
  it('stops a user creating matches after 20 per hour, without affecting anyone else', async () => {
    const spammer = await makeUser(api, 'spammer@example.com');
    const other = await makeUser(api, 'honest@example.com');
    for (let i = 0; i < 20; i++) {
      expect((await api.call('POST', '/api/v1/matches', matchBody({ title: `Spam match ${i}` }), spammer.token)).status).toBe(201);
    }
    const blocked = await api.call('POST', '/api/v1/matches', matchBody({ title: 'Spam match 21' }), spammer.token);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await api.call('POST', '/api/v1/matches', matchBody(), other.token)).status).toBe(201);
    // reading is not covered by the creation limit
    expect((await api.call('GET', '/api/v1/matches', undefined, spammer.token)).status).toBe(200);
  });
});

describe('global API limit (SEC-03)', () => {
  it('throttles an anonymous client by IP, never the health probes, and never a signed-in user behind the same IP', async () => {
    const user = await makeUser(api, 'bystander@example.com');
    let limited = 0;
    for (let i = 0; i < 320 && !limited; i++) {
      const res = await api.call('GET', '/api/v1/cities');
      if (res.status === 429) limited = i + 1;
    }
    expect(limited).toBeGreaterThan(0);
    expect(limited).toBeLessThanOrEqual(301);
    expect((await api.call('GET', '/health')).status).toBe(200);
    expect((await api.call('GET', '/api/v1/cities', undefined, user.token)).status).toBe(200);
  });
});
