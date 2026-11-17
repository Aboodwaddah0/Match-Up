import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { inHours, makeUser, matchBody, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  const { closeRealtime } = await import('../src/lib/realtime');
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
    const { attachRealtime } = await import('../src/lib/realtime');
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

describe('realtime sessions end when the account or the token ends (AUTH-04)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function chatWithSocket(token: string, member: TestUser, org: TestUser) {
    const { attachRealtime } = await import('../src/lib/realtime');
    attachRealtime(api.server);
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match.id as string;
    const r = await api.call('POST', `/api/v1/matches/${m}/requests`, {}, member.token);
    await api.call('POST', `/api/v1/matches/${m}/requests/${r.body.request.id}/accept`, {}, org.token);
    const { conversationId } = (await api.call('POST', `${C}/match/${m}`, {}, org.token)).body;
    const sock = connect(api.base, { auth: { token }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      sock.on('connect', () => resolve());
      sock.on('connect_error', (e) => reject(e));
    });
    const received: string[] = [];
    sock.on('message:new', (msg: { body: string }) => received.push(msg.body));
    return { sock, received, conversationId: conversationId as string };
  }

  it('a suspended account is disconnected at once and receives nothing more', async () => {
    const org = await makeUser(api, 'rt-org@example.com');
    const player = await makeUser(api, 'rt-player@example.com');
    const admin = await makeUser(api, 'rt-admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    const { sock, received, conversationId } = await chatWithSocket(player.token, player, org);

    await send(org, conversationId, 'before');
    await sleep(300);
    expect(received).toEqual(['before']);

    const dropped = new Promise<void>((r) => sock.on('disconnect', () => r()));
    expect((await api.call('POST', `/api/v1/admin/users/${player.userId}/suspend`, {}, admin.token)).status).toBe(204);
    await dropped;
    expect(sock.connected).toBe(false);
    await send(org, conversationId, 'after');
    await sleep(300);
    expect(received).toEqual(['before']);
  });

  it('logout-all disconnects every socket of the user', async () => {
    const org = await makeUser(api, 'rt2-org@example.com');
    const player = await makeUser(api, 'rt2-player@example.com');
    const { sock } = await chatWithSocket(player.token, player, org);
    const dropped = new Promise<void>((r) => sock.on('disconnect', () => r()));
    expect((await api.call('POST', '/api/v1/auth/logout-all', {}, player.token)).status).toBe(204);
    await dropped;
    expect(sock.connected).toBe(false);
  });

  it('a socket is dropped when the access token that opened it expires', async () => {
    const { SignJWT } = await import('jose');
    const org = await makeUser(api, 'rt3-org@example.com');
    const player = await makeUser(api, 'rt3-player@example.com');
    const shortLived = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(player.userId)
      .setIssuer('find-your-match-api')
      .setAudience('find-your-match-app')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!));
    const { sock } = await chatWithSocket(shortLived, player, org);
    expect(sock.connected).toBe(true);
    const started = Date.now();
    await new Promise<void>((r) => sock.on('disconnect', () => r()));
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15_000);
});

describe('inbox pagination (PERF-01)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function fiveChats() {
    const org = await makeUser(api, 'inbox-org@example.com');
    const p = await makeUser(api, 'inbox-player@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = (await api.call('POST', '/api/v1/matches', matchBody({ title: `Inbox match ${i}`, startAt: inHours(48 + i * 6) }), org.token)).body.match.id as string;
      const r = await api.call('POST', `/api/v1/matches/${m}/requests`, {}, p.token);
      await api.call('POST', `/api/v1/matches/${m}/requests/${r.body.request.id}/accept`, {}, org.token);
      const { conversationId } = (await api.call('POST', `${C}/match/${m}`, {}, org.token)).body;
      expect((await send(org, conversationId, `hello ${i}`)).status).toBe(201);
      ids.push(conversationId);
      await sleep(15); // distinct timestamps
    }
    return { org, p, ids };
  }

  it('pages newest-first without repeats, reports the total unread over ALL chats and ends with a null cursor', async () => {
    const { p, ids } = await fiveChats();
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const res = await api.call('GET', `${C}?limit=2${before ? `&before=${before}` : ''}`, undefined, p.token);
      expect(res.status).toBe(200);
      expect(res.body.totalUnread).toBe(5);
      seen.push(...res.body.chats.map((c: { id: string }) => c.id));
      before = res.body.nextBefore;
      pages++;
    } while (before && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(5);
  });

  it('a new message moves its chat to the top and the cursor still works', async () => {
    const { org, p, ids } = await fiveChats();
    const first = await api.call('GET', `${C}?limit=2`, undefined, p.token);
    await sleep(15);
    await send(org, ids[0]!, 'bump'); // oldest chat becomes the newest
    const rest = await api.call('GET', `${C}?limit=2&before=${first.body.nextBefore}`, undefined, p.token);
    expect(rest.status).toBe(200);
    expect(rest.body.chats.map((c: { id: string }) => c.id)).toEqual([ids[2], ids[1]]);
    expect((await api.call('GET', `${C}?limit=1`, undefined, p.token)).body.chats[0].id).toBe(ids[0]);
  });

  it('rejects an unknown cursor and an out-of-range limit', async () => {
    const { p } = await fiveChats();
    expect((await api.call('GET', `${C}?before=00000000-0000-4000-8000-000000000000`, undefined, p.token)).status).toBe(400);
    expect((await api.call('GET', `${C}?limit=500`, undefined, p.token)).status).toBe(400);
  });
});
