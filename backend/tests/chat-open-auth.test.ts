import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
let org: TestUser;
let player: TestUser;
let outsider: TestUser;

const C = '/api/v1/chats';
const M = '/api/v1/matches';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const conversations = async () => (await prismaP()).conversation.count();
const open = (matchId: string, by: TestUser) => api.call('POST', `${C}/match/${matchId}`, {}, by.token);
const newMatch = async (over: Record<string, unknown> = {}) => (await api.call('POST', M, matchBody(over), org.token)).body.match.id as string;
async function confirm(matchId: string, who: TestUser) {
  const r = (await api.call('POST', `${M}/${matchId}/requests`, {}, who.token)).body.request.id as string;
  expect((await api.call('POST', `${M}/${matchId}/requests/${r}/accept`, {}, org.token)).status).toBe(200);
}

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  org = await makeUser(api, 'org@example.com');
  player = await makeUser(api, 'player@example.com');
  outsider = await makeUser(api, 'outsider@example.com');
});

describe('opening a match chat authorizes BEFORE anything is written (SEC-02)', () => {
  it('a signed-in stranger gets 404 and no conversation is created, on a public and on a private match', async () => {
    const publicMatch = await newMatch();
    const privateMatch = await newMatch({ visibility: 'PRIVATE', title: 'Private five-a-side' });
    for (const id of [publicMatch, privateMatch]) {
      const res = await open(id, outsider);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
    }
    expect(await conversations()).toBe(0);
  });

  it('an UNVERIFIED account cannot create a conversation without membership either', async () => {
    const unverified = await makeUser(api, 'unverified@example.com', { verified: false });
    const matchId = await newMatch();
    expect((await open(matchId, unverified)).status).toBe(404);
    expect(await conversations()).toBe(0);
  });

  it('a pending requester is not a member: 404 and no conversation', async () => {
    const matchId = await newMatch();
    expect((await api.call('POST', `${M}/${matchId}/requests`, {}, player.token)).status).toBe(201);
    expect((await open(matchId, player)).status).toBe(404);
    expect(await conversations()).toBe(0);
  });

  it('an invited but not yet confirmed player is not a member either', async () => {
    const matchId = await newMatch({ visibility: 'PRIVATE', title: 'Invite only match' });
    expect((await api.call('POST', `${M}/${matchId}/invitations`, { userId: player.userId }, org.token)).status).toBeLessThan(300);
    expect((await open(matchId, player)).status).toBe(404);
    expect(await conversations()).toBe(0);
  });

  it('a participant who was removed is no longer a member: 404 and no conversation', async () => {
    const matchId = await newMatch();
    await confirm(matchId, player);
    expect((await api.call('DELETE', `${M}/${matchId}/participants/${player.userId}`, undefined, org.token)).status).toBe(204);
    expect((await open(matchId, player)).status).toBe(404);
    expect(await conversations()).toBe(0);
  });

  it('an unknown match id gets the same 404 and nothing is written', async () => {
    const res = await open('00000000-0000-4000-8000-000000000000', outsider);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
    expect(await conversations()).toBe(0);
  });

  it('the organizer and a confirmed player open the SAME conversation, once', async () => {
    const matchId = await newMatch();
    await confirm(matchId, player);
    const a = await open(matchId, org);
    const b = await open(matchId, player);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.conversationId).toBeTruthy();
    expect(b.body.conversationId).toBe(a.body.conversationId);
    expect(await conversations()).toBe(1);
    expect((await open(matchId, outsider)).status).toBe(404); // and a stranger still cannot get in afterwards
    expect(await conversations()).toBe(1);
  });

  it('simultaneous opens by authorized members return one id and create exactly one row (repeated on fresh matches)', async () => {
    const other = await makeUser(api, 'player2@example.com');
    for (let round = 0; round < 5; round++) {
      const matchId = await newMatch({ title: `Chat race ${round}`, startAt: new Date(Date.now() + (80 + round * 4) * 3_600_000).toISOString() });
      await confirm(matchId, player);
      await confirm(matchId, other);
      const results = await Promise.all([org, org, player, player, other, other].map((u) => open(matchId, u)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.conversationId)).size).toBe(1);
      expect(await (await prismaP()).conversation.count({ where: { matchId } })).toBe(1);
    }
  });

  it('a cancelled match: the organizer still opens it (read-only history); players lose membership on cancel, as they already did for reading', async () => {
    const matchId = await newMatch();
    await confirm(matchId, player);
    const before = await open(matchId, org);
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, org.token)).status).toBe(200);
    const again = await open(matchId, org);
    expect(again.status).toBe(200);
    expect(again.body.conversationId).toBe(before.body.conversationId);
    expect((await api.call('GET', `${C}/${again.body.conversationId}/messages`, undefined, org.token)).body.canWrite).toBe(false);
    expect((await open(matchId, player)).status).toBe(404);
    expect((await open(matchId, outsider)).status).toBe(404);
    expect(await conversations()).toBe(1);
  });

  it('a COMPLETED match: the organizer and a CONFIRMED player (participation survives completion) open the same single conversation', async () => {
    const matchId = await newMatch();
    await confirm(matchId, player);
    const before = await open(matchId, org); // opened while the match is still upcoming
    await moveMatchTime(matchId, -3, -1); // it has been played
    expect((await api.call('POST', `${M}/${matchId}/complete`, undefined, org.token)).status).toBe(200);
    const prisma = await prismaP();
    expect((await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).status).toBe('COMPLETED');
    expect((await prisma.matchParticipant.findUniqueOrThrow({ where: { matchId_userId: { matchId, userId: player.userId } } })).status).toBe('CONFIRMED');

    const a = await open(matchId, org);
    const b = await open(matchId, player);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.conversationId).toBe(a.body.conversationId);
    expect(a.body.conversationId).toBe(before.body.conversationId);
    expect(await prisma.conversation.count({ where: { matchId } })).toBe(1);
    expect((await open(matchId, outsider)).status).toBe(404);
    expect(await conversations()).toBe(1);
  });

  it('a COMPLETED match whose chat was never opened is created once, by either member, and not for a stranger', async () => {
    const matchId = await newMatch();
    await confirm(matchId, player);
    await moveMatchTime(matchId, -3, -1);
    expect((await api.call('POST', `${M}/${matchId}/complete`, undefined, org.token)).status).toBe(200);
    expect((await open(matchId, outsider)).status).toBe(404);
    expect(await conversations()).toBe(0);
    const results = await Promise.all([open(matchId, player), open(matchId, org), open(matchId, player)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.conversationId)).size).toBe(1);
    expect(await conversations()).toBe(1);
  });

  it('team and direct chats are unchanged: a non-member still gets 404 on a team chat, and a direct chat still needs a shared context', async () => {
    const team = await api.call('POST', '/api/v1/teams', { name: 'Chat team' }, org.token);
    expect((await api.call('POST', `${C}/team/${team.body.team.id}`, {}, outsider.token)).status).toBe(404);
    expect((await api.call('POST', `${C}/team/${team.body.team.id}`, {}, org.token)).status).toBe(200);
    expect((await api.call('POST', `${C}/direct`, { userId: outsider.userId }, org.token)).status).toBe(403);
  });
});
