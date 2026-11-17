import type { startApp } from './client';

type Api = Awaited<ReturnType<typeof startApp>>;
export const PASSWORD = 'correct horse battery';

export interface TestUser {
  token: string;
  userId: string;
  email: string;
}

/** Registers + logs in. By default the e-mail is verified and a player profile exists (what most flows need). */
export async function makeUser(
  api: Api,
  email: string,
  opts: { verified?: boolean; profile?: boolean; positions?: string[]; skill?: string } = {},
): Promise<TestUser> {
  const { verified = true, profile = true, positions = ['MIDFIELDER'], skill = 'INTERMEDIATE' } = opts;
  await api.call('POST', '/api/v1/auth/register', { email, password: PASSWORD, fullName: 'Player ' + email.split('@')[0], locale: 'en' });
  const { body } = await api.call('POST', '/api/v1/auth/login', { email, password: PASSWORD });
  const user: TestUser = { token: body.accessToken, userId: body.user.id, email };
  const { prisma } = await import('../../src/lib/prisma');
  if (verified) await prisma.user.update({ where: { id: user.userId }, data: { emailVerifiedAt: new Date() } });
  if (profile) {
    await api.call('PUT', '/api/v1/players/me', { positions, primaryPosition: positions[0], skillLevel: skill }, user.token);
  }
  return user;
}

export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

export function matchBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Evening 7v7',
    format: 'F7',
    capacity: 6,
    startAt: inHours(72),
    durationMinutes: 90,
    ...overrides,
  };
}

/** Moves a match's window relative to NOW, bypassing triggers: simulates time passing (what the clock would do). */
export async function moveMatchTime(matchId: string, startOffsetHours: number, endOffsetHours: number) {
  const { prisma } = await import('../../src/lib/prisma');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(
      `UPDATE "match" SET start_at = now() + interval '${startOffsetHours} hours', end_at = now() + interval '${endOffsetHours} hours' WHERE id = '${matchId}'`,
    );
  });
}
