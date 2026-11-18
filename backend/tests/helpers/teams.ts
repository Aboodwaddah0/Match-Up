import { expect } from 'vitest';
import type { startApp } from './client';
import { inHours, makeUser, type TestUser } from './users';

type Api = Awaited<ReturnType<typeof startApp>>;
export const T = '/api/v1/teams';

export interface Team {
  teamId: string;
  captain: TestUser;
  vice: TestUser;
  members: TestUser[]; // captain, vice, then plain members
}

/** A team of six: captain, one vice captain and four plain members (so it still has five after one person leaves). */
export async function makeTeam(api: Api, prefix: string): Promise<Team> {
  const captain = await makeUser(api, `${prefix}0@example.com`);
  const teamId = (await api.call('POST', T, { name: `Team ${prefix}` }, captain.token)).body.team.id as string;
  const members = [captain];
  for (let i = 1; i < 6; i++) {
    const u = await makeUser(api, `${prefix}${i}@example.com`);
    const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, captain.token);
    expect((await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, u.token)).status).toBe(200);
    members.push(u);
  }
  expect((await api.call('PATCH', `${T}/${teamId}/members/${members[1]!.userId}`, { role: 'VICE_CAPTAIN' }, captain.token)).status).toBe(200);
  return { teamId, captain, vice: members[1]!, members };
}

export const challenge = (api: Api, from: Team, by: TestUser, to: Team, proposedStartAt: string = inHours(72)) =>
  api.call('POST', `${T}/${from.teamId}/challenges`, { challengedTeamId: to.teamId, format: 'F5', proposedStartAt }, by.token);

export const acceptChallenge = (api: Api, id: string, by: TestUser) => api.call('POST', `/api/v1/challenges/${id}/accept`, {}, by.token);

export const transferCaptaincy = (api: Api, t: Team, from: TestUser, to: TestUser) =>
  api.call('POST', `${T}/${t.teamId}/transfer-captaincy`, { userId: to.userId }, from.token);
