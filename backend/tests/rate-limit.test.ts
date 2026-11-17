import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, PASSWORD } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  // Limits are off under NODE_ENV=test; this file is the one place that switches them on (module state is per test file).
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

const login = (email: string, password: string) => api.call('POST', '/api/v1/auth/login', { email, password });

describe('authentication rate limits', () => {
  it('limits password guessing per ACCOUNT, from any IP; other accounts are unaffected', async () => {
    await makeUser(api, 'victim@example.com');
    await makeUser(api, 'other@example.com');

    for (let i = 0; i < 10; i++) expect((await login('victim@example.com', 'wrong password')).status).toBe(401);
    const blocked = await login('victim@example.com', 'wrong password');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // even the right password is refused while the account is throttled
    expect((await login('victim@example.com', PASSWORD)).status).toBe(429);
    // a different account from the same IP is not affected
    expect((await login('other@example.com', PASSWORD)).status).toBe(200);
  });

  it('the account key is normalized: upper case and surrounding spaces cannot be used to get fresh attempts', async () => {
    await makeUser(api, 'norm@example.com');
    const variants = ['norm@example.com', 'NORM@example.com', 'Norm@Example.com', ' norm@example.com ', 'nOrM@eXaMpLe.CoM'];
    for (let i = 0; i < 10; i++) expect((await login(variants[i % variants.length]!, 'wrong password')).status).toBe(401);
    for (const v of variants) expect((await login(v, PASSWORD)).status).toBe(429); // every spelling hits the same exhausted bucket
    // a genuinely different address is a different account (plus-addressing is NOT folded: it is a different account here)
    expect((await login('norm+other@example.com', 'wrong password')).status).toBe(401);
  });

  it('successful logins never use up the allowance', async () => {
    await makeUser(api, 'busy@example.com');
    for (let i = 0; i < 14; i++) expect((await login('busy@example.com', PASSWORD)).status).toBe(200);
    expect((await login('busy@example.com', 'wrong password')).status).toBe(401); // still has its 10 failures available
  });

  it('refresh has its own generous bucket: heavy refreshing never blocks login', async () => {
    await makeUser(api, 'mobile@example.com');
    for (let i = 0; i < 40; i++) expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: 'x'.repeat(30) })).status).toBe(401);
    expect((await login('mobile@example.com', PASSWORD)).status).toBe(200);
  });

  it('e-mail verification / reset links are limited per IP (30 per 15 minutes)', async () => {
    const attempt = () => api.call('POST', '/api/v1/auth/verify-email', { token: 'x'.repeat(30) });
    for (let i = 0; i < 30; i++) expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
    // the reset endpoint shares the token bucket
    expect((await api.call('POST', '/api/v1/auth/reset-password', { token: 'x'.repeat(30), newPassword: 'a-long-password' })).status).toBe(429);
    // but login uses a different bucket
    await makeUser(api, 'afterwards@example.com');
    expect((await login('afterwards@example.com', PASSWORD)).status).toBe(200);
  });

  it('forgot-password: 5 per hour per target e-mail, other e-mails unaffected', async () => {
    const forgot = (email: string) => api.call('POST', '/api/v1/auth/forgot-password', { email });
    for (let i = 0; i < 5; i++) expect((await forgot('target@example.com')).status).toBe(202);
    expect((await forgot('target@example.com')).status).toBe(429);
    expect((await forgot('someone-else@example.com')).status).toBe(202);
  });

  it('change-password: wrong current passwords are limited per user (10 per 15 minutes)', async () => {
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const change = (token: string) => api.call('POST', '/api/v1/auth/change-password', { currentPassword: 'not the password', newPassword: 'another-long-password' }, token);
    for (let i = 0; i < 10; i++) expect((await change(a.token)).status).toBe(400);
    expect((await change(a.token)).status).toBe(429);
    expect((await change(b.token)).status).toBe(400); // user b still gets a normal answer
  });

  it('resend-verification: 5 per hour per user', async () => {
    const u = await makeUser(api, 'unverified@example.com', { verified: false });
    for (let i = 0; i < 5; i++) expect((await api.call('POST', '/api/v1/auth/resend-verification', {}, u.token)).status).toBe(202);
    expect((await api.call('POST', '/api/v1/auth/resend-verification', {}, u.token)).status).toBe(429);
  });
});
