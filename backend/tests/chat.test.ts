import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  const { closeRealtime } = await import('../src/modules/chat/realtime');
  await closeRealtime();
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

const C = '/api/v1/chats';
const send = (u: TestUser, id: string, body: string) => api.call('POST', `${C}/${id}/messages`, { body }, u.token);

async function matchWithPlayers() {
  const org = await makeUser(api, 'org@example.com');
  const p1 = await makeUser(api, 'p1@example.com');
  const out = await makeUser(api, 'out@example.com');
  const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match;
  const r = await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, p1.token);
  await api.call('POST', `/api/v1/matches/${m.id}/requests/${r.body.request.id}/accept`, {}, org.token);
  return { org, p1, out, matchId: m.id as string };
}

describe('match chat', () => {
  it('only the organizer and confirmed players get in; leaving revokes access; history pages with a cursor', async () => {
    const { org, p1, out, matchId } = await matchWithPlayers();
    expect((await api.call('POST', `${C}/match/${matchId}`, {}, out.token)).status).toBe(404);
    const { conversationId } = (await api.call('POST', `${C}/match/${matchId}`, {}, org.token)).body;
    expect((await api.call('POST', `${C}/match/${matchId}`, {}, p1.token)).body.conversationId).toBe(conversationId); // same chat

    for (let i = 1; i <= 5; i++) expect((await send(i % 2 ? org : p1, conversationId, `msg ${i}`)).status).toBe(201);
    expect((await send(out, conversationId, 'let me in')).status).toBe(404);
    expect((await api.call('GET', `${C}/${conversationId}/messages`, undefined, out.token)).status).toBe(404);
    expect((await send(org, conversationId, '   ')).status).toBe(400);

    const page1 = await api.call('GET', `${C}/${conversationId}/messages?limit=2`, undefined, p1.token);
    expect(page1.body.messages.map((m: { body: string }) => m.body)).toEqual(['msg 5', 'msg 4']);
    expect(page1.body.nextBefore).toBeTruthy();
    const page2 = await api.call('GET', `${C}/${conversationId}/messages?limit=10&before=${page1.body.nextBefore}`, undefined, p1.token);
    expect(page2.body.messages.map((m: { body: string }) => m.body)).toEqual(['msg 3', 'msg 2', 'msg 1']);
    expect(page2.body.nextBefore).toBeNull();

    await api.call('POST', `/api/v1/matches/${matchId}/leave`, {}, p1.token);
    expect((await api.call('GET', `${C}/${conversationId}/messages`, undefined, p1.token)).status).toBe(404);
  });

  it('is read-only once the match is cancelled', async () => {
    const { org, matchId } = await matchWithPlayers();
    const { conversationId } = (await api.call('POST', `${C}/match/${matchId}`, {}, org.token)).body;
    await send(org, conversationId, 'hello');
    await api.call('POST', `/api/v1/matches/${matchId}/cancel`, {}, org.token);
    const res = await send(org, conversationId, 'anyone?');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHAT_READ_ONLY');
    expect((await api.call('GET', `${C}/${conversationId}/messages`, undefined, org.token)).body.canWrite).toBe(false);
  });

  it('inbox shows last message and unread count; reading clears it; blocked senders are hidden', async () => {
    const { org, p1, matchId } = await matchWithPlayers();
    const { conversationId } = (await api.call('POST', `${C}/match/${matchId}`, {}, org.token)).body;
    await send(org, conversationId, 'kick-off at 6');
    await send(org, conversationId, 'bring water');

    const inbox = await api.call('GET', C, undefined, p1.token);
    expect(inbox.body.chats).toHaveLength(1);
    expect(inbox.body.chats[0]).toMatchObject({ type: 'MATCH', title: 'Evening 7v7', unreadCount: 2, lastMessage: { body: 'bring water' } });
    expect(inbox.body.totalUnread).toBe(2);
    expect((await api.call('GET', C, undefined, org.token)).body.chats[0].unreadCount).toBe(0); // my own messages are read

    expect((await api.call('POST', `${C}/${conversationId}/read`, {}, p1.token)).status).toBe(204);
    expect((await api.call('GET', C, undefined, p1.token)).body.totalUnread).toBe(0);

    await api.call('POST', '/api/v1/users/me/blocks', { userId: org.userId }, p1.token);
    expect((await api.call('GET', `${C}/${conversationId}/messages`, undefined, p1.token)).body.messages).toHaveLength(0);
  });

  it('rate-limits a flood', async () => {
    const { org, matchId } = await matchWithPlayers();
    const { conversationId } = (await api.call('POST', `${C}/match/${matchId}`, {}, org.token)).body;
    let last = 201;
    for (let i = 0; i < 22; i++) last = (await send(org, conversationId, `spam ${i}`)).status;
    expect(last).toBe(429);
  });
});

describe('team chat and direct messages', () => {
  it('team chat is for members only', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const out = await makeUser(api, 'out@example.com');
    const teamId = (await api.call('POST', '/api/v1/teams', { name: 'Eagles' }, cap.token)).body.team.id;
    expect((await api.call('POST', `${C}/team/${teamId}`, {}, out.token)).status).toBe(404);
    const { conversationId } = (await api.call('POST', `${C}/team/${teamId}`, {}, cap.token)).body;
    expect((await send(cap, conversationId, 'training Thursday')).status).toBe(201);
    expect((await api.call('GET', C, undefined, cap.token)).body.chats[0]).toMatchObject({ type: 'TEAM', title: 'Eagles' });
  });

  it('DMs need a shared match or team, are deduplicated, and a block ends them', async () => {
    const { org, p1, out } = await matchWithPlayers();
    expect((await api.call('POST', `${C}/direct`, { userId: out.userId }, p1.token)).status).toBe(403); // no shared context
    expect((await api.call('POST', `${C}/direct`, { userId: p1.userId }, p1.token)).status).toBe(400);

    const [a, b] = await Promise.all([api.call('POST', `${C}/direct`, { userId: p1.userId }, org.token), api.call('POST', `${C}/direct`, { userId: org.userId }, p1.token)]);
    expect(a.status).toBe(200);
    expect(a.body.conversationId).toBe(b.body.conversationId); // one conversation even when both start at once
    const id = a.body.conversationId as string;

    await send(org, id, 'can you bring the ball?');
    const inbox = await api.call('GET', C, undefined, p1.token);
    expect(inbox.body.chats[0]).toMatchObject({ type: 'DIRECT', title: org.email.split('@')[0] === 'org' ? 'Player org' : undefined, unreadCount: 1 });

    // the DM survives leaving the match (it was created while they shared one) ...
    await api.call('POST', `/api/v1/matches/${(await api.call('GET', '/api/v1/matches/mine?role=playing', undefined, p1.token)).body.matches[0].id}/leave`, {}, p1.token);
    expect((await send(p1, id, 'sure')).status).toBe(201);
    // ... until someone blocks
    await api.call('POST', '/api/v1/users/me/blocks', { userId: p1.userId }, org.token);
    expect((await send(p1, id, 'hello?')).status).toBe(404);
    expect((await api.call('GET', C, undefined, org.token)).body.chats).toHaveLength(0);
  });

  it('messages can be reported by people who can see them', async () => {
    const { org, p1, out, matchId } = await matchWithPlayers();
    const { conversationId } = (await api.call('POST', `${C}/match/${matchId}`, {}, org.token)).body;
    const messageId = (await send(org, conversationId, 'rude message')).body.message.id as string;
    const report = (u: TestUser) => api.call('POST', '/api/v1/reports', { targetType: 'MESSAGE', targetId: messageId, reason: 'HARASSMENT' }, u.token);
    expect((await report(out)).status).toBe(404);
    expect((await report(p1)).status).toBe(201);
  });
});

describe('realtime', () => {
  it('pushes message:new to connected members only; rejects bad tokens', async () => {
    const { attachRealtime } = await import('../src/modules/chat/realtime');
    attachRealtime(api.server);
    const { org, p1, out, matchId } = await matchWithPlayers();
    const { conversationId } = (await api.call('POST', `${C}/match/${matchId}`, {}, org.token)).body;

    const open = (token: string) => connect(api.base, { auth: { token }, transports: ['websocket'], reconnection: false });
    const bad = open('nope');
    await new Promise<void>((resolve) => bad.on('connect_error', () => resolve()));
    bad.close();

    const sockets = [open(p1.token), open(out.token)];
    await Promise.all(sockets.map((s) => new Promise<void>((resolve) => s.on('connect', () => resolve()))));
    const got: Record<string, unknown[]> = { p1: [], out: [] };
    sockets[0]!.on('message:new', (m) => got.p1!.push(m));
    sockets[1]!.on('message:new', (m) => got.out!.push(m));

    await send(org, conversationId, 'live!');
    await new Promise((r) => setTimeout(r, 400));
    expect(got.p1).toHaveLength(1);
    expect(got.p1![0]).toMatchObject({ body: 'live!', conversationId, senderId: org.userId });
    expect(got.out).toHaveLength(0);
    sockets.forEach((s) => s.close());
  });
});
