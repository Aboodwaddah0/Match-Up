import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser } from './helpers/users';

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

describe('account deletion limit (PRIV-01)', () => {
  it('stops password guessing on the deletion endpoint after 10 failures per 15 minutes, per user, without affecting anyone else', async () => {
    const attacker = await makeUser(api, 'stolen-token@example.com');
    const other = await makeUser(api, 'someone-else@example.com');
    for (let i = 0; i < 10; i++) {
      expect((await api.call('POST', '/api/v1/users/me/delete', { password: 'wrong password ' + i }, attacker.token)).status).toBe(400);
    }
    const blocked = await api.call('POST', '/api/v1/users/me/delete', { password: 'wrong password 11' }, attacker.token);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await api.call('POST', '/api/v1/users/me/delete', { password: 'wrong' }, other.token)).status).toBe(400); // someone else is not affected
  });
});
