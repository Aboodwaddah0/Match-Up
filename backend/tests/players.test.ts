import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';

const PASSWORD = 'correct horse battery';
let api: Awaited<ReturnType<typeof startApp>>;
let cityId: string;

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  const { prisma } = await import('../src/lib/prisma');
  cityId = (await prisma.city.create({ data: { nameAr: 'الخليل', nameEn: 'Hebron' } })).id;
});

async function signUp(email: string) {
  await api.call('POST', '/api/v1/auth/register', { email, password: PASSWORD, fullName: 'Player One', locale: 'en' });
  const { body } = await api.call('POST', '/api/v1/auth/login', { email, password: PASSWORD });
  return { token: body.accessToken as string, userId: body.user.id as string };
}

const validProfile = () => ({
  positions: ['GOALKEEPER', 'DEFENDER'],
  primaryPosition: 'GOALKEEPER',
  skillLevel: 'INTERMEDIATE',
  preferredFoot: 'RIGHT',
  dateOfBirth: '1998-05-20',
  bio: 'Weekend keeper',
  cityId,
  latitude: 31.53,
  longitude: 35.1,
});

describe('my profile', () => {
  it('requires login and returns 404 until a profile exists', async () => {
    expect((await api.call('GET', '/api/v1/players/me')).status).toBe(401);
    const { token } = await signUp('a@example.com');
    const res = await api.call('GET', '/api/v1/players/me', undefined, token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
  });

  it('creates a profile with several positions and one primary', async () => {
    const { token } = await signUp('a@example.com');
    const res = await api.call('PUT', '/api/v1/players/me', validProfile(), token);
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({
      positions: ['DEFENDER', 'GOALKEEPER'],
      primaryPosition: 'GOALKEEPER',
      skillLevel: 'INTERMEDIATE',
      preferredFoot: 'RIGHT',
      dateOfBirth: '1998-05-20',
      latitude: 31.53,
      city: { nameEn: 'Hebron' },
      stats: { matchesPlayed: 0, lateCancellations: 0, noShows: 0 },
      rating: { average: null, count: 0 },
    });
  });

  it('replaces positions and clears omitted optional fields on a second PUT', async () => {
    const { token } = await signUp('a@example.com');
    await api.call('PUT', '/api/v1/players/me', validProfile(), token);
    const res = await api.call(
      'PUT',
      '/api/v1/players/me',
      { positions: ['STRIKER'], primaryPosition: 'STRIKER', skillLevel: 'ADVANCED' },
      token,
    );
    expect(res.status).toBe(200);
    expect(res.body.profile.positions).toEqual(['STRIKER']);
    expect(res.body.profile).toMatchObject({ bio: null, city: null, latitude: null, dateOfBirth: null, skillLevel: 'ADVANCED' });
  });

  it.each([
    ['primary not among positions', { primaryPosition: 'STRIKER' }],
    ['duplicate positions', { positions: ['GOALKEEPER', 'GOALKEEPER'] }],
    ['no positions', { positions: [] }],
    ['unknown skill level', { skillLevel: 'GOD' }],
    ['latitude without longitude', { longitude: undefined }],
    ['child (age under 10)', { dateOfBirth: new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10) }],
    ['bio too long', { bio: 'x'.repeat(501) }],
  ])('rejects %s', async (_name, patch) => {
    const { token } = await signUp('a@example.com');
    const res = await api.call('PUT', '/api/v1/players/me', { ...validProfile(), ...patch }, token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown city', async () => {
    const { token } = await signUp('a@example.com');
    const res = await api.call('PUT', '/api/v1/players/me', { ...validProfile(), cityId: crypto.randomUUID() }, token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CITY');
  });
});

describe('viewing other players', () => {
  it('shows a public view without birth date, coordinates or e-mail', async () => {
    const owner = await signUp('owner@example.com');
    await api.call('PUT', '/api/v1/players/me', validProfile(), owner.token);
    const viewer = await signUp('viewer@example.com');

    const res = await api.call('GET', `/api/v1/players/${owner.userId}`, undefined, viewer.token);
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ fullName: 'Player One', primaryPosition: 'GOALKEEPER', city: { nameEn: 'Hebron' } });
    expect(typeof res.body.profile.age).toBe('number');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/dateOfBirth|latitude|longitude|owner@example\.com|1998/);
  });

  it('requires login, validates the id, and 404s for unknown players', async () => {
    const viewer = await signUp('viewer@example.com');
    expect((await api.call('GET', `/api/v1/players/${viewer.userId}`)).status).toBe(401);
    expect((await api.call('GET', '/api/v1/players/not-a-uuid', undefined, viewer.token)).status).toBe(400);
    // exists as a user but has no profile
    expect((await api.call('GET', `/api/v1/players/${viewer.userId}`, undefined, viewer.token)).status).toBe(404);
    expect((await api.call('GET', `/api/v1/players/${crypto.randomUUID()}`, undefined, viewer.token)).status).toBe(404);
  });

  it('hides a profile from users in a block relationship (either direction)', async () => {
    const a = await signUp('a@example.com');
    const b = await signUp('b@example.com');
    await api.call('PUT', '/api/v1/players/me', validProfile(), a.token);
    await api.call('PUT', '/api/v1/players/me', validProfile(), b.token);
    const { prisma } = await import('../src/lib/prisma');
    await prisma.blockedUser.create({ data: { blockerId: a.userId, blockedId: b.userId } });

    expect((await api.call('GET', `/api/v1/players/${a.userId}`, undefined, b.token)).status).toBe(404);
    expect((await api.call('GET', `/api/v1/players/${b.userId}`, undefined, a.token)).status).toBe(404);
  });
});

describe('account basics and cities', () => {
  it('PATCH /users/me updates name, language and avatar', async () => {
    const { token } = await signUp('a@example.com');
    const res = await api.call('PATCH', '/api/v1/users/me', { fullName: 'Ahmad Khalil', locale: 'ar', avatarUrl: 'https://cdn.example.com/a.png' }, token);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ fullName: 'Ahmad Khalil', locale: 'ar', avatarUrl: 'https://cdn.example.com/a.png' });
  });

  it('PATCH /users/me rejects empty bodies, http avatars and bad time zones', async () => {
    const { token } = await signUp('a@example.com');
    expect((await api.call('PATCH', '/api/v1/users/me', {}, token)).status).toBe(400);
    expect((await api.call('PATCH', '/api/v1/users/me', { avatarUrl: 'http://x.com/a.png' }, token)).status).toBe(400);
    expect((await api.call('PATCH', '/api/v1/users/me', { timezone: 'Mars/Base' }, token)).status).toBe(400);
  });

  it('GET /cities is public and bilingual', async () => {
    const res = await api.call('GET', '/api/v1/cities');
    expect(res.status).toBe(200);
    expect(res.body.cities).toEqual([expect.objectContaining({ nameEn: 'Hebron', nameAr: 'الخليل' })]);
  });
});
