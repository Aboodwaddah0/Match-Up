import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lastEmailToken, resetDb, startApp } from './helpers/client';

const PASSWORD = 'correct horse battery';
let api: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});
beforeEach(resetDb);

async function register(email = 'ali@example.com') {
  return api.call('POST', '/api/v1/auth/register', { email, password: PASSWORD, fullName: 'Ali Test', locale: 'en' });
}
async function login(email = 'ali@example.com', password = PASSWORD) {
  return api.call('POST', '/api/v1/auth/login', { email, password });
}

describe('register', () => {
  it('creates an unverified user and never returns the password hash', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ali@example.com', emailVerified: false, platformRole: 'USER' });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|argon/i);
  });

  it('rejects duplicate e-mails, case-insensitively', async () => {
    await register('ali@example.com');
    const res = await register('ALI@Example.com');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('validates input on the server', async () => {
    const weak = await api.call('POST', '/api/v1/auth/register', { email: 'a@b.co', password: 'short', fullName: 'Al' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    const badEmail = await api.call('POST', '/api/v1/auth/register', { email: 'nope', password: PASSWORD, fullName: 'Ali' });
    expect(badEmail.status).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await fetch(`${api.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON');
  });
});

describe('email verification', () => {
  it('verifies once; the link cannot be reused', async () => {
    await register();
    const token = await lastEmailToken('ali@example.com');

    expect((await api.call('POST', '/api/v1/auth/verify-email', { token })).status).toBe(200);
    const { body } = await login();
    expect(body.user.emailVerified).toBe(true);

    const again = await api.call('POST', '/api/v1/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('a resent link replaces the previous one', async () => {
    await register();
    const first = await lastEmailToken('ali@example.com');
    const { body } = await login();
    await api.call('POST', '/api/v1/auth/resend-verification', undefined, body.accessToken);
    const second = await lastEmailToken('ali@example.com');
    expect(second).not.toBe(first);
    expect((await api.call('POST', '/api/v1/auth/verify-email', { token: first })).status).toBe(400);
    expect((await api.call('POST', '/api/v1/auth/verify-email', { token: second })).status).toBe(200);
  });
});

describe('login and access control', () => {
  it('logs in and reaches /users/me with the access token', async () => {
    await register();
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    const me = await api.call('GET', '/api/v1/users/me', undefined, res.body.accessToken);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ali@example.com');
  });

  it('gives the same error for a wrong password and an unknown e-mail', async () => {
    await register();
    const wrong = await login('ali@example.com', 'wrong password!!');
    const unknown = await login('ghost@example.com');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('protects /users/me', async () => {
    expect((await api.call('GET', '/api/v1/users/me')).status).toBe(401);
    expect((await api.call('GET', '/api/v1/users/me', undefined, 'garbage')).status).toBe(401);
  });

  it('a suspended account is locked out immediately, even with a valid access token', async () => {
    await register();
    const { body } = await login();
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { email: 'ali@example.com' }, data: { status: 'SUSPENDED' } });

    expect((await api.call('GET', '/api/v1/users/me', undefined, body.accessToken)).status).toBe(401);
    const again = await login();
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: body.refreshToken })).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotates: each refresh token works once', async () => {
    await register();
    const first = (await login()).body;
    const second = await api.call('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    const me = await api.call('GET', '/api/v1/users/me', undefined, second.body.accessToken);
    expect(me.status).toBe(200);
  });

  it('reusing an old token revokes the whole session family', async () => {
    await register();
    const first = (await login()).body;
    const second = (await api.call('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken })).body;

    const replay = await api.call('POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    // the legitimate newer token is now dead too
    const stolenFamily = await api.call('POST', '/api/v1/auth/refresh', { refreshToken: second.refreshToken });
    expect(stolenFamily.status).toBe(401);
  });

  it('two simultaneous refreshes with the same token: only one succeeds', async () => {
    await register();
    const { refreshToken } = (await login()).body;
    const results = await Promise.all([
      api.call('POST', '/api/v1/auth/refresh', { refreshToken }),
      api.call('POST', '/api/v1/auth/refresh', { refreshToken }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('logout ends the session; logout-all ends every device', async () => {
    await register();
    const a = (await login()).body;
    const b = (await login()).body;

    expect((await api.call('POST', '/api/v1/auth/logout', { refreshToken: a.refreshToken })).status).toBe(204);
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: a.refreshToken })).status).toBe(401);

    expect((await api.call('POST', '/api/v1/auth/logout-all', undefined, b.accessToken)).status).toBe(204);
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: b.refreshToken })).status).toBe(401);
  });
});

describe('password reset and change', () => {
  it('forgot-password answers the same for unknown e-mails and sends nothing', async () => {
    await register();
    const known = await api.call('POST', '/api/v1/auth/forgot-password', { email: 'ali@example.com' });
    const unknown = await api.call('POST', '/api/v1/auth/forgot-password', { email: 'ghost@example.com' });
    expect(known.status).toBe(202);
    expect(unknown).toEqual(known);
    await expect(lastEmailToken('ghost@example.com')).rejects.toThrow();
  });

  it('reset sets the new password, kills all sessions, and the link is single-use', async () => {
    await register();
    const session = (await login()).body;
    await api.call('POST', '/api/v1/auth/forgot-password', { email: 'ali@example.com' });
    const token = await lastEmailToken('ali@example.com');

    const reset = await api.call('POST', '/api/v1/auth/reset-password', { token, newPassword: 'a brand new password' });
    expect(reset.status).toBe(200);

    expect((await login()).status).toBe(401); // old password
    const fresh = await login('ali@example.com', 'a brand new password');
    expect(fresh.status).toBe(200);
    expect(fresh.body.user.emailVerified).toBe(true); // proved inbox ownership
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: session.refreshToken })).status).toBe(401);

    const reuse = await api.call('POST', '/api/v1/auth/reset-password', { token, newPassword: 'another password 1' });
    expect(reuse.status).toBe(400);
  });

  it('a verification token cannot be used to reset a password', async () => {
    await register();
    const verifyToken = await lastEmailToken('ali@example.com');
    const res = await api.call('POST', '/api/v1/auth/reset-password', { token: verifyToken, newPassword: 'hijack attempt 1' });
    expect(res.status).toBe(400);
  });

  it('change-password needs the current password and swaps the session', async () => {
    await register();
    const old = (await login()).body;

    const wrong = await api.call('POST', '/api/v1/auth/change-password', { currentPassword: 'nope nope nope', newPassword: 'new password 123' }, old.accessToken);
    expect(wrong.status).toBe(400);

    const ok = await api.call('POST', '/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'new password 123' }, old.accessToken);
    expect(ok.status).toBe(200);
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: old.refreshToken })).status).toBe(401);
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: ok.body.refreshToken })).status).toBe(200);
  });
});
