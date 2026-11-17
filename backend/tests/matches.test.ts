import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { inHours, makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
let org: TestUser;
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
  org = await makeUser(api, 'org@example.com');
});

const create = (u: TestUser, over: Record<string, unknown> = {}) => api.call('POST', '/api/v1/matches', matchBody(over), u.token);
const get = (u: TestUser, id: string) => api.call('GET', `/api/v1/matches/${id}`, undefined, u.token);
const post = (u: TestUser, path: string, body?: unknown) => api.call('POST', `/api/v1/matches${path}`, body ?? {}, u.token);

async function newMatch(over: Record<string, unknown> = {}, who: TestUser = org): Promise<string> {
  const res = await create(who, over);
  expect(res.status).toBe(201);
  return res.body.match.id;
}

/** player asks, organizer accepts */
async function join(matchId: string, player: TestUser) {
  const r = await post(player, `/${matchId}/requests`);
  expect(r.status).toBe(201);
  return post(org, `/${matchId}/requests/${r.body.request.id}/accept`);
}

describe('creating matches', () => {
  it('requires a verified e-mail', async () => {
    const u = await makeUser(api, 'unverified@example.com', { verified: false });
    const res = await create(u);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('creates an OPEN match; spots are derived from capacity (organizer not counted)', async () => {
    const res = await create(org, { capacity: 6, requiredPositions: [{ position: 'GOALKEEPER', count: 1 }], cityId });
    expect(res.status).toBe(201);
    expect(res.body.match).toMatchObject({
      type: 'OPEN_MATCH', status: 'OPEN', visibility: 'PUBLIC', format: 'F7',
      capacity: 6, confirmedCount: 0, availableSpots: 6, myRelation: 'ORGANIZER',
      requiredPositions: [{ position: 'GOALKEEPER', count: 1 }], city: { nameEn: 'Hebron' },
    });
    expect(res.body.match.endAt).toBeTruthy();
  });

  it.each([
    ['capacity above the pitch total (F7 = 14)', { capacity: 15 }],
    ['capacity above the pitch total (F5 = 10)', { format: 'F5', capacity: 11 }],
    ['capacity 0', { capacity: 0 }],
    ['unknown format', { format: 'F9' }],
    ['endAt before startAt', { endAt: inHours(1) }],
    ['latitude without longitude', { latitude: 31.5 }],
    ['duplicate required positions', { requiredPositions: [{ position: 'STRIKER' }, { position: 'STRIKER' }] }],
  ])('rejects %s', async (_n, over) => {
    const res = await create(org, over);
    expect(res.status).toBe(400);
  });

  it('rejects a match in the past (DB rule)', async () => {
    const res = await create(org, { startAt: inHours(-2) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DATE_IN_PAST');
  });
});

describe('join requests and approval', () => {
  it('request -> organizer lists it -> accept -> spots drop, FULL at capacity, then no more requests', async () => {
    const matchId = await newMatch({ capacity: 2 });
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((n) => makeUser(api, `${n}@example.com`)));

    const reqA = await post(a!, `/${matchId}/requests`, { message: 'keen!' });
    expect(reqA.status).toBe(201);
    expect(reqA.body.scheduleConflict).toBe(false);

    const pending = await api.call('GET', `/api/v1/matches/${matchId}/requests`, undefined, org.token);
    expect(pending.body.requests).toHaveLength(1);
    expect(pending.body.requests[0]).toMatchObject({ message: 'keen!', player: { userId: a!.userId } });

    const accepted = await post(org, `/${matchId}/requests/${reqA.body.request.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.match).toMatchObject({ confirmedCount: 1, availableSpots: 1, status: 'OPEN' });
    expect((await get(a!, matchId)).body.match.myRelation).toBe('PARTICIPANT');

    expect((await join(matchId, b!)).body.match).toMatchObject({ confirmedCount: 2, availableSpots: 0, status: 'FULL' });

    const late = await post(c!, `/${matchId}/requests`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('MATCH_NOT_OPEN');
  });

  it('rejects duplicates, own-match requests and players without a profile or verified e-mail', async () => {
    const matchId = await newMatch();
    const p = await makeUser(api, 'p@example.com');
    await post(p, `/${matchId}/requests`);
    const dup = await post(p, `/${matchId}/requests`);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_REQUEST');

    expect((await post(org, `/${matchId}/requests`)).body.error.code).toBe('ORGANIZER_CANNOT_REQUEST');

    const noProfile = await makeUser(api, 'np@example.com', { profile: false });
    expect((await post(noProfile, `/${matchId}/requests`)).body.error.code).toBe('PROFILE_REQUIRED');
    const unverified = await makeUser(api, 'uv@example.com', { verified: false });
    expect((await post(unverified, `/${matchId}/requests`)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('only the organizer decides requests; rejected and withdrawn requests do not take a spot', async () => {
    const matchId = await newMatch();
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const ra = await post(a, `/${matchId}/requests`);
    const rb = await post(b, `/${matchId}/requests`);

    expect((await post(b, `/${matchId}/requests/${ra.body.request.id}/accept`)).status).toBe(403);
    expect((await post(org, `/${matchId}/requests/${ra.body.request.id}/reject`)).status).toBe(200);
    expect((await post(org, `/${matchId}/requests/${ra.body.request.id}/accept`)).body.error.code).toBe('REQUEST_ALREADY_DECIDED');

    expect((await api.call('DELETE', `/api/v1/matches/${matchId}/requests/me`, undefined, b.token)).status).toBe(204);
    expect((await post(org, `/${matchId}/requests/${rb.body.request.id}/accept`)).body.error.code).toBe('REQUEST_ALREADY_DECIDED');
    expect((await get(org, matchId)).body.match.confirmedCount).toBe(0);

    // a rejected player may ask again
    expect((await post(a, `/${matchId}/requests`)).status).toBe(201);
  });

  it('never exceeds capacity when the organizer approves two players at the same moment', async () => {
    const matchId = await newMatch({ capacity: 1 });
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const ra = await post(a, `/${matchId}/requests`);
    const rb = await post(b, `/${matchId}/requests`);

    const results = await Promise.all([
      post(org, `/${matchId}/requests/${ra.body.request.id}/accept`),
      post(org, `/${matchId}/requests/${rb.body.request.id}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('MATCH_FULL');
    expect((await get(org, matchId)).body.match).toMatchObject({ confirmedCount: 1, status: 'FULL' });
  });

  it('warns on overlapping matches, but only CONFIRMED participation blocks (D3)', async () => {
    const m1 = await newMatch({ startAt: inHours(72) });
    const m2 = await newMatch({ startAt: inHours(72.5) });
    const p = await makeUser(api, 'p@example.com');
    await join(m1, p);

    const req = await post(p, `/${m2}/requests`);
    expect(req.status).toBe(201);
    expect(req.body.scheduleConflict).toBe(true);
    expect((await get(p, m2)).body.match.scheduleConflict).toBe(true);

    const listed = await api.call('GET', `/api/v1/matches/${m2}/requests`, undefined, org.token);
    expect(listed.body.requests[0].scheduleConflict).toBe(true);

    const accept = await post(org, `/${m2}/requests/${req.body.request.id}/accept`);
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe('SCHEDULE_CONFLICT');
    expect(JSON.stringify(accept.body)).not.toContain(m1); // never reveals the other match
  });

  it('different organizers approving the same player concurrently: one wins, the other gets a conflict', async () => {
    const org2 = await makeUser(api, 'org2@example.com');
    const m1 = await newMatch({ startAt: inHours(96) });
    const m2 = await newMatch({ startAt: inHours(96) }, org2);
    const p = await makeUser(api, 'p@example.com');
    const r1 = await post(p, `/${m1}/requests`);
    const r2 = await post(p, `/${m2}/requests`);

    const results = await Promise.all([
      post(org, `/${m1}/requests/${r1.body.request.id}/accept`),
      post(org2, `/${m2}/requests/${r2.body.request.id}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('SCHEDULE_CONFLICT');
  });
});

describe('leaving and removal', () => {
  it('leaving >12h before start is free; the match reopens', async () => {
    const matchId = await newMatch({ capacity: 1 });
    const p = await makeUser(api, 'p@example.com');
    await join(matchId, p);
    expect((await get(org, matchId)).body.match.status).toBe('FULL');

    const res = await post(p, `/${matchId}/leave`);
    expect(res.body).toEqual({ left: true, lateCancellation: false });
    expect((await get(org, matchId)).body.match).toMatchObject({ status: 'OPEN', availableSpots: 1 });
  });

  it('leaving within 12h is recorded as a late cancellation; a player can rejoin via a new request', async () => {
    const matchId = await newMatch({ startAt: inHours(6) });
    const p = await makeUser(api, 'p@example.com');
    await join(matchId, p);
    expect((await post(p, `/${matchId}/leave`)).body.lateCancellation).toBe(true);

    expect((await join(matchId, p)).status).toBe(200);
    const profile = await api.call('GET', `/api/v1/players/${p.userId}`, undefined, org.token);
    expect(profile.body.profile.stats.lateCancellations).toBe(0); // fresh record after rejoin
  });

  it('the organizer can remove a player (no penalty); strangers cannot', async () => {
    const matchId = await newMatch();
    const p = await makeUser(api, 'p@example.com');
    const other = await makeUser(api, 'o@example.com');
    await join(matchId, p);

    expect((await api.call('DELETE', `/api/v1/matches/${matchId}/participants/${p.userId}`, undefined, other.token)).status).toBe(403);
    expect((await api.call('DELETE', `/api/v1/matches/${matchId}/participants/${p.userId}`, undefined, org.token)).status).toBe(204);
    expect((await get(org, matchId)).body.match.confirmedCount).toBe(0);
  });
});

describe('editing a match', () => {
  it('capacity can rise any time and fall only to the confirmed count; FULL/OPEN follow', async () => {
    const matchId = await newMatch({ capacity: 2 });
    const [a, b] = await Promise.all(['a', 'b'].map((n) => makeUser(api, `${n}@example.com`)));
    await join(matchId, a!);
    await join(matchId, b!);
    expect((await get(org, matchId)).body.match.status).toBe('FULL');

    const raised = await api.call('PATCH', `/api/v1/matches/${matchId}`, { capacity: 4 }, org.token);
    expect(raised.body.match).toMatchObject({ capacity: 4, availableSpots: 2, status: 'OPEN' });

    const tooLow = await api.call('PATCH', `/api/v1/matches/${matchId}`, { capacity: 1 }, org.token);
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.error.code).toBe('CAPACITY_BELOW_CONFIRMED');

    const exact = await api.call('PATCH', `/api/v1/matches/${matchId}`, { capacity: 2 }, org.token);
    expect(exact.body.match.status).toBe('FULL');

    expect((await api.call('PATCH', `/api/v1/matches/${matchId}`, { capacity: 15 }, org.token)).status).toBe(400);
  });

  it('time is locked once someone is confirmed (D12) and pending requesters are told when it changes', async () => {
    const matchId = await newMatch();
    const asker = await makeUser(api, 'asker@example.com');
    await post(asker, `/${matchId}/requests`);

    const moved = await api.call('PATCH', `/api/v1/matches/${matchId}`, { startAt: inHours(100) }, org.token);
    expect(moved.status).toBe(200);
    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { userId: asker.userId, type: 'MATCH_TIME_CHANGED' } })).toBe(1);

    const p = await makeUser(api, 'p@example.com');
    await join(matchId, p);
    const locked = await api.call('PATCH', `/api/v1/matches/${matchId}`, { startAt: inHours(120) }, org.token);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('MATCH_TIME_LOCKED');
    // other fields still editable
    expect((await api.call('PATCH', `/api/v1/matches/${matchId}`, { title: 'New title' }, org.token)).body.match.title).toBe('New title');
  });

  it('only the organizer may edit', async () => {
    const matchId = await newMatch();
    const other = await makeUser(api, 'x@example.com');
    expect((await api.call('PATCH', `/api/v1/matches/${matchId}`, { title: 'Hacked' }, other.token)).status).toBe(403);
  });
});

describe('private matches (invite-only)', () => {
  it('are invisible to outsiders; an invited player can see and request', async () => {
    const matchId = await newMatch({ visibility: 'PRIVATE' });
    const outsider = await makeUser(api, 'out@example.com');
    const invitee = await makeUser(api, 'in@example.com');

    expect((await get(outsider, matchId)).status).toBe(404);
    expect((await post(outsider, `/${matchId}/requests`)).status).toBe(404);

    expect((await post(org, `/${matchId}/invitations`, { userId: invitee.userId })).status).toBe(201);
    expect((await get(invitee, matchId)).body.match.myRelation).toBe('INVITED');

    const req = await post(invitee, `/${matchId}/requests`);
    expect(req.status).toBe(201); // still needs approval
    expect((await get(invitee, matchId)).body.match.confirmedCount).toBe(0);

    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { userId: invitee.userId, type: 'MATCH_INVITATION' } })).toBe(1);
  });

  it('never appear in public search', async () => {
    await newMatch({ visibility: 'PRIVATE', title: 'Secret' });
    const other = await makeUser(api, 'o@example.com');
    const res = await api.call('GET', '/api/v1/matches', undefined, other.token);
    expect(res.body.matches).toHaveLength(0);
  });
});

describe('search', () => {
  it('filters by city, format, spots, price, position and hides full/private/past matches', async () => {
    await newMatch({ title: 'Alpha', cityId, format: 'F7', capacity: 4, pricePerPlayer: 10, requiredPositions: [{ position: 'GOALKEEPER' }] });
    await newMatch({ title: 'Bravo', format: 'F5', capacity: 2, pricePerPlayer: 30 });
    const fullId = await newMatch({ title: 'Full', capacity: 1 });
    await join(fullId, await makeUser(api, 'f@example.com'));
    const viewer = await makeUser(api, 'v@example.com');
    const search = (qs: string) => api.call('GET', `/api/v1/matches?${qs}`, undefined, viewer.token).then((r) => r.body.matches.map((m: { title: string }) => m.title).sort());

    expect(await search('')).toEqual(['Alpha', 'Bravo']); // 'Full' hidden by default
    expect(await search('includeFull=true')).toEqual(['Alpha', 'Bravo', 'Full']);
    expect(await search(`cityId=${cityId}`)).toEqual(['Alpha']);
    expect(await search('format=F5')).toEqual(['Bravo']);
    expect(await search('minSpots=3')).toEqual(['Alpha']);
    expect(await search('maxPrice=15')).toEqual(['Alpha']);
    expect(await search('position=GOALKEEPER')).toEqual(['Alpha']);
    expect(await search('position=STRIKER')).toEqual([]);
  });

  it('finds matches near a point, nearest first, with distance', async () => {
    await newMatch({ title: 'Near', latitude: 31.53, longitude: 35.1 });
    await newMatch({ title: 'Farther', latitude: 31.58, longitude: 35.1 });
    await newMatch({ title: 'TooFar', latitude: 32.2, longitude: 35.2 });
    const viewer = await makeUser(api, 'v@example.com');
    const res = await api.call('GET', '/api/v1/matches?lat=31.53&lng=35.1&radiusKm=10', undefined, viewer.token);
    expect(res.body.matches.map((m: { title: string }) => m.title)).toEqual(['Near', 'Farther']);
    expect(res.body.matches[0].distanceKm).toBeLessThan(1);
    expect(res.body.matches[1].distanceKm).toBeGreaterThan(4);
  });

  it('suitableForMe uses my skill level and positions', async () => {
    await newMatch({ title: 'Keeper wanted', requiredSkillLevel: 'ADVANCED', requiredPositions: [{ position: 'GOALKEEPER' }] });
    await newMatch({ title: 'Mids welcome', requiredSkillLevel: 'INTERMEDIATE', requiredPositions: [{ position: 'MIDFIELDER' }] });
    await newMatch({ title: 'Anyone' });
    const mid = await makeUser(api, 'mid@example.com', { positions: ['MIDFIELDER'], skill: 'INTERMEDIATE' });
    const res = await api.call('GET', '/api/v1/matches?suitableForMe=true', undefined, mid.token);
    expect(res.body.matches.map((m: { title: string }) => m.title).sort()).toEqual(['Anyone', 'Mids welcome']);

    const noProfile = await makeUser(api, 'np@example.com', { profile: false });
    expect((await api.call('GET', '/api/v1/matches?suitableForMe=true', undefined, noProfile.token)).status).toBe(403);
  });

  it('paginates', async () => {
    for (const n of [1, 2, 3]) await newMatch({ title: `Match ${n}`, startAt: inHours(70 + n) });
    const viewer = await makeUser(api, 'v@example.com');
    const p1 = await api.call('GET', '/api/v1/matches?pageSize=2', undefined, viewer.token);
    expect(p1.body).toMatchObject({ hasMore: true, page: 1 });
    expect(p1.body.matches).toHaveLength(2);
    const p2 = await api.call('GET', '/api/v1/matches?pageSize=2&page=2', undefined, viewer.token);
    expect(p2.body.hasMore).toBe(false);
    expect(p2.body.matches.map((m: { title: string }) => m.title)).toEqual(['Match 3']);
  });

  it('"mine" lists organized, playing and requested matches', async () => {
    const m1 = await newMatch({ title: 'Mine' });
    const p = await makeUser(api, 'p@example.com');
    const other = await newMatch({ title: 'Other' }, p);
    await join(m1, p);
    await post(org, `/${other}/requests`);

    const title = (r: { body: { matches: { title: string }[] } }) => r.body.matches.map((m) => m.title);
    expect(title(await api.call('GET', '/api/v1/matches/mine?role=organized', undefined, org.token))).toEqual(['Mine']);
    expect(title(await api.call('GET', '/api/v1/matches/mine?role=playing', undefined, p.token))).toEqual(['Mine']);
    expect(title(await api.call('GET', '/api/v1/matches/mine?role=requested', undefined, org.token))).toEqual(['Other']);
  });
});

describe('cancelling', () => {
  it('cancels, notifies participants and requesters, and frees their time', async () => {
    const m1 = await newMatch({ startAt: inHours(80) });
    const p = await makeUser(api, 'p@example.com');
    const asker = await makeUser(api, 'asker@example.com');
    await join(m1, p);
    await post(asker, `/${m1}/requests`);

    expect((await post(p, `/${m1}/cancel`)).status).toBe(403);
    const res = await post(org, `/${m1}/cancel`, { reason: 'Rain' });
    expect(res.body.match.status).toBe('CANCELLED');

    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { type: 'MATCH_CANCELLED', userId: { in: [p.userId, asker.userId] } } })).toBe(2);
    expect((await post(asker, `/${m1}/requests`)).status).toBe(409);

    // the cancelled slot no longer blocks the player
    const m2 = await newMatch({ startAt: inHours(80) });
    expect((await join(m2, p)).status).toBe(200);
  });

  it('an admin can cancel any match', async () => {
    const matchId = await newMatch();
    const admin = await makeUser(api, 'admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    expect((await post(admin, `/${matchId}/cancel`, { reason: 'moderation' })).body.match.status).toBe('CANCELLED');
  });
});

describe('match lifecycle (D5, D16)', () => {
  it('starts automatically, expires pending requests, records no-shows and completes on organizer confirmation', async () => {
    const { runLifecycleJobs } = await import('../src/jobs/match-lifecycle');
    const matchId = await newMatch({ capacity: 3 });
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((n) => makeUser(api, `${n}@example.com`)));
    await join(matchId, a!);
    await join(matchId, b!);
    const waiting = await post(c!, `/${matchId}/requests`);

    // completing early is refused
    expect((await post(org, `/${matchId}/complete`)).body.error.code).toBe('INVALID_STATE');
    expect((await runLifecycleJobs()).started).toBe(0);

    await moveMatchTime(matchId, -2, 1); // started 2h ago
    expect((await runLifecycleJobs()).started).toBe(1);
    expect((await runLifecycleJobs()).started).toBe(0); // idempotent
    expect((await get(org, matchId)).body.match.status).toBe('IN_PROGRESS');

    const { prisma } = await import('../src/lib/prisma');
    expect((await prisma.matchRequest.findUniqueOrThrow({ where: { id: waiting.body.request.id } })).status).toBe('EXPIRED');
    expect((await post(a!, `/${matchId}/leave`)).body.error.code).toBe('MATCH_STARTED');

    const noShow = await api.call('PATCH', `/api/v1/matches/${matchId}/participants/${b!.userId}/attendance`, { status: 'NO_SHOW' }, org.token);
    expect(noShow.body.attendanceStatus).toBe('NO_SHOW');

    expect((await post(org, `/${matchId}/complete`)).body.match.status).toBe('COMPLETED');
    const list = await api.call('GET', `/api/v1/matches/${matchId}/participants`, undefined, org.token);
    const byUser = Object.fromEntries(list.body.participants.map((p: { userId: string; attendanceStatus: string }) => [p.userId, p.attendanceStatus]));
    expect(byUser).toEqual({ [a!.userId]: 'ATTENDED', [b!.userId]: 'NO_SHOW' });

    const stats = await api.call('GET', `/api/v1/players/${b!.userId}`, undefined, org.token);
    expect(stats.body.profile.stats).toMatchObject({ noShows: 1, matchesPlayed: 0 });
  });

  it('attendance cannot be recorded before the match starts', async () => {
    const matchId = await newMatch();
    const p = await makeUser(api, 'p@example.com');
    await join(matchId, p);
    const res = await api.call('PATCH', `/api/v1/matches/${matchId}/participants/${p.userId}/attendance`, { status: 'NO_SHOW' }, org.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTENDANCE_TOO_EARLY');
  });

  it('closes as CLOSED_UNCONFIRMED 48h after the end; the organizer can still confirm within 7 days', async () => {
    const { runLifecycleJobs } = await import('../src/jobs/match-lifecycle');
    const matchId = await newMatch();
    await moveMatchTime(matchId, -60, -50); // ended 50h ago
    expect(await runLifecycleJobs()).toMatchObject({ started: 1, closed: 1 });
    expect((await get(org, matchId)).body.match.status).toBe('CLOSED_UNCONFIRMED');

    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { userId: org.userId, type: 'MATCH_CLOSED_UNCONFIRMED' } })).toBe(1);
    expect((await post(org, `/${matchId}/complete`)).body.match.status).toBe('COMPLETED');
  });

  it('after the 7-day recovery window only an admin can resolve it', async () => {
    const matchId = await newMatch();
    await moveMatchTime(matchId, -300, -290);
    const { prisma } = await import('../src/lib/prisma');
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(`UPDATE "match" SET status='CLOSED_UNCONFIRMED', closed_unconfirmed_at = now() - interval '8 days' WHERE id='${matchId}'`);
    });

    const denied = await post(org, `/${matchId}/complete`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('RECOVERY_WINDOW_EXPIRED');

    const admin = await makeUser(api, 'admin@example.com');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    expect((await post(admin, `/${matchId}/complete`)).body.match.status).toBe('COMPLETED');
  });
});
