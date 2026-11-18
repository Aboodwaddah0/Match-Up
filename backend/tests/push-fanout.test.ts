import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { addDevice, addNotification, deliveries, expoToken, fakeExpo, prismaP, pushUser, pushWorker, sql } from './helpers/push';
import { inHours, makeUser, matchBody, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

/** Fan-out only: a pass with a fake Expo that is never reached because we look at the deliveries it created. */
const fanOut = async () => (await pushWorker()).runPushWorkerOnce({ client: fakeExpo().client, maxSendBatches: 0 });
const marked = async (id: string) => (await (await prismaP()).notification.findUniqueOrThrow({ where: { id } })).pushFanoutAt;

describe('fan-out: notification -> one delivery per device', () => {
  it('creates one PENDING delivery for each device of the recipient and marks the notification', async () => {
    const u = await pushUser('two@example.com', { devices: 2 });
    const n = await addNotification(u.userId, 'MATCH_REQUEST_RECEIVED');
    expect(await marked(n.id)).toBeNull();
    const r = await fanOut();
    expect(r).toMatchObject({ notificationsFannedOut: 1, deliveriesCreated: 2 });
    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    expect(rows.every((d) => d.status === 'PENDING' && d.attempts === 0 && d.notification_id === n.id && d.user_id === u.userId)).toBe(true);
    expect(rows.map((d) => d.expo_token).sort()).toEqual(u.tokens.map((t) => t.token).sort());
    expect(await marked(n.id)).not.toBeNull();
  });

  it('creates nothing, but still marks the notification: no device, not a pushed type, a suspended or deleted user', async () => {
    const noDevice = await pushUser('nodev@example.com', { devices: 0 });
    const suspended = await pushUser('susp@example.com', { status: 'SUSPENDED' });
    const deleted = await pushUser('del@example.com', { status: 'DELETED' });
    const active = await pushUser('active@example.com');
    const ids = [
      (await addNotification(noDevice.userId, 'MATCH_CANCELLED')).id,
      (await addNotification(suspended.userId, 'MATCH_CANCELLED')).id,
      (await addNotification(deleted.userId, 'MATCH_CANCELLED')).id,
      (await addNotification(active.userId, 'REVIEW_RECEIVED')).id,
      (await addNotification(active.userId, 'VENUE_SUSPENDED')).id,
      (await addNotification(active.userId, 'SOMETHING_UNKNOWN')).id,
    ];
    const r = await fanOut();
    expect(r).toMatchObject({ notificationsFannedOut: 6, deliveriesCreated: 0 });
    expect(await deliveries()).toHaveLength(0);
    for (const id of ids) expect(await marked(id)).not.toBeNull(); // never looked at again
  });

  it('skips a device whose token is not an Expo token, and keeps the valid ones', async () => {
    const u = await pushUser('mixed@example.com', { devices: 1 });
    await sql(`INSERT INTO device_token (user_id, token, platform) VALUES ('${u.userId}', 'not-an-expo-token-1234567890', 'android'), ('${u.userId}', 'ExponentPushToken[short]', 'ios'), ('${u.userId}', 'FcmToken[abcdefghijklmnop]', 'android')`);
    await addNotification(u.userId, 'MATCH_INVITATION');
    await fanOut();
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expo_token).toBe(u.tokens[0]!.token);
  });

  it('a notification older than 24 hours is marked without any delivery and is counted as stale', async () => {
    const u = await pushUser('old@example.com');
    const old = await addNotification(u.userId, 'MATCH_CANCELLED', undefined, { createdAgoHours: 25 });
    await addNotification(u.userId, 'MATCH_CANCELLED', undefined, { createdAgoHours: 23 });
    const r = await fanOut();
    expect(r).toMatchObject({ notificationsFannedOut: 2, deliveriesCreated: 1, staleNotifications: 1 });
    expect(await marked(old.id)).not.toBeNull();
    expect(await deliveries()).toHaveLength(1);
  });

  it('notifications that existed before the migration (already marked) are never pushed', async () => {
    const u = await pushUser('legacy@example.com');
    const n = await addNotification(u.userId, 'MATCH_CANCELLED');
    await sql(`UPDATE notification SET push_fanout_at = now() WHERE id = '${n.id}'`); // what the migration did to existing rows
    expect(await fanOut()).toMatchObject({ notificationsFannedOut: 0 });
    expect(await deliveries()).toHaveLength(0);
  });
});

describe('fan-out is idempotent and recoverable', () => {
  it('running it again creates nothing new', async () => {
    const u = await pushUser('again@example.com', { devices: 2 });
    await addNotification(u.userId, 'MATCH_CANCELLED');
    await fanOut();
    expect(await fanOut()).toMatchObject({ notificationsFannedOut: 0, deliveriesCreated: 0 });
    expect(await deliveries()).toHaveLength(2);
  });

  it('the database refuses a second delivery for the same notification and device', async () => {
    const u = await pushUser('unique@example.com');
    const n = await addNotification(u.userId, 'MATCH_CANCELLED');
    await fanOut();
    const d = u.tokens[0]!;
    await expect(sql(`INSERT INTO push_delivery (notification_id, user_id, device_token_id, expo_token) VALUES ('${n.id}', '${u.userId}', '${d.id}', '${d.token}')`)).rejects.toThrow(/23505|duplicate key|unique/i);
  });

  it('concurrent fan-outs process every notification exactly once', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => pushUser(`c${i}@example.com`, { devices: 2 })));
    for (let i = 0; i < 60; i++) await addNotification(users[i % 6]!.userId, 'MATCH_CANCELLED');
    const results = await Promise.all([1, 2, 3, 4].map(() => fanOut()));
    expect(results.reduce((n, r) => n + r.notificationsFannedOut, 0)).toBe(60);
    expect(results.reduce((n, r) => n + r.deliveriesCreated, 0)).toBe(120);
    expect(await deliveries()).toHaveLength(120);
    const pairs = new Set((await deliveries()).map((d) => `${d.notification_id}/${d.device_token_id}`));
    expect(pairs.size).toBe(120);
  });

  it('a failure half way leaves NOTHING behind (no deliveries, notification still waiting) and the next pass completes it', async () => {
    const prisma = await prismaP();
    const u = await pushUser('crash@example.com', { devices: 2 });
    const n = await addNotification(u.userId, 'MATCH_CANCELLED');
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION push_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_push_test_fail BEFORE INSERT ON push_delivery FOR EACH ROW EXECUTE FUNCTION push_test_fail()`);
    try {
      await expect(fanOut()).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS trg_push_test_fail ON push_delivery');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS push_test_fail()');
    }
    expect(await deliveries()).toHaveLength(0);
    expect(await marked(n.id)).toBeNull(); // not lost: still waiting
    expect(await fanOut()).toMatchObject({ notificationsFannedOut: 1, deliveriesCreated: 2 });
  });

  it('a business change that is rolled back leaves no notification and therefore no push', async () => {
    const prisma = await prismaP();
    const u = await pushUser('rollback@example.com');
    const { notify } = await import('../src/modules/notifications/notify');
    await expect(
      prisma.$transaction(async (tx) => {
        await notify(tx, [u.userId], 'MATCH_CANCELLED', { title: 'x' });
        throw new Error('the business operation failed');
      }),
    ).rejects.toThrow('the business operation failed');
    expect(await fanOut()).toMatchObject({ notificationsFannedOut: 0 });
    expect(await deliveries()).toHaveLength(0);
  });
});

// ───────────────────────── recipients come from the existing notification logic ─────────────────────────

describe('recipients are exactly the recipients of the notification rows', () => {
  const M = '/api/v1/matches';
  const recipientsOf = async (type: string) => {
    const rows = await deliveries();
    const prisma = await prismaP();
    const notes = await prisma.notification.findMany({ where: { id: { in: rows.map((r) => r.notification_id) }, type } });
    const ids = new Set(notes.map((n) => n.id));
    return rows.filter((r) => ids.has(r.notification_id)).map((r) => r.user_id).sort();
  };
  const withDevices = async (...users: TestUser[]) => {
    for (const u of users) await addDevice(u.userId);
  };

  it('a join request pushes to the organizer only; the decision pushes to the requester', async () => {
    const org = await makeUser(api, 'org@example.com');
    const p1 = await makeUser(api, 'p1@example.com');
    const p2 = await makeUser(api, 'p2@example.com');
    await withDevices(org, p1, p2);
    const m = (await api.call('POST', M, matchBody(), org.token)).body.match.id as string;
    const r1 = (await api.call('POST', `${M}/${m}/requests`, {}, p1.token)).body.request.id as string;
    const r2 = (await api.call('POST', `${M}/${m}/requests`, {}, p2.token)).body.request.id as string;
    await api.call('POST', `${M}/${m}/requests/${r1}/accept`, {}, org.token);
    await api.call('POST', `${M}/${m}/requests/${r2}/reject`, {}, org.token);
    await fanOut();
    expect(await recipientsOf('MATCH_REQUEST_RECEIVED')).toEqual([org.userId, org.userId]);
    expect(await recipientsOf('MATCH_REQUEST_ACCEPTED')).toEqual([p1.userId]);
    expect(await recipientsOf('MATCH_REQUEST_REJECTED')).toEqual([p2.userId]);
  });

  it('a cancellation pushes to the confirmed player and the pending requester, not to the person who cancelled', async () => {
    const org = await makeUser(api, 'org2@example.com');
    const confirmed = await makeUser(api, 'conf@example.com');
    const pending = await makeUser(api, 'pend@example.com');
    const bystander = await makeUser(api, 'by@example.com');
    await withDevices(org, confirmed, pending, bystander);
    const m = (await api.call('POST', M, matchBody(), org.token)).body.match.id as string;
    const r = (await api.call('POST', `${M}/${m}/requests`, {}, confirmed.token)).body.request.id as string;
    await api.call('POST', `${M}/${m}/requests/${r}/accept`, {}, org.token);
    await api.call('POST', `${M}/${m}/requests`, {}, pending.token);
    await sql('UPDATE notification SET push_fanout_at = now()'); // ignore the earlier notifications
    await api.call('POST', `${M}/${m}/cancel`, { reason: 'rain' }, org.token);
    await fanOut();
    expect(await recipientsOf('MATCH_CANCELLED')).toEqual([confirmed.userId, pending.userId].sort());
  });

  it('a private invitation pushes to the invitee', async () => {
    const org = await makeUser(api, 'org3@example.com');
    const invitee = await makeUser(api, 'inv@example.com');
    await withDevices(org, invitee);
    const m = (await api.call('POST', M, matchBody({ visibility: 'PRIVATE' }), org.token)).body.match.id as string;
    expect((await api.call('POST', `${M}/${m}/invitations`, { userId: invitee.userId }, org.token)).status).toBeLessThan(300);
    await fanOut();
    expect(await recipientsOf('MATCH_INVITATION')).toEqual([invitee.userId]);
  });

  it('a team invitation pushes to the invitee', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const invitee = await makeUser(api, 'tinv@example.com');
    await withDevices(cap, invitee);
    const teamId = (await api.call('POST', '/api/v1/teams', { name: 'Eagles' }, cap.token)).body.team.id as string;
    expect((await api.call('POST', `/api/v1/teams/${teamId}/invitations`, { userId: invitee.userId }, cap.token)).status).toBe(201);
    await fanOut();
    expect(await recipientsOf('TEAM_INVITATION')).toEqual([invitee.userId]);
  });

  it('challenges: RECEIVED goes to the CHALLENGED team\'s captain and vice captains, ACCEPTED to the CHALLENGING team\'s; ordinary members get none', async () => {
    const T = '/api/v1/teams';
    const build = async (prefix: string) => {
      const captain = await makeUser(api, `${prefix}0@example.com`);
      const teamId = (await api.call('POST', T, { name: `Team ${prefix}` }, captain.token)).body.team.id as string;
      const members: TestUser[] = [];
      for (let i = 1; i < 5; i++) {
        const u = await makeUser(api, `${prefix}${i}@example.com`);
        const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, captain.token);
        await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, u.token);
        members.push(u);
      }
      const vice = members[0]!;
      expect((await api.call('PATCH', `${T}/${teamId}/members/${vice.userId}`, { role: 'VICE_CAPTAIN' }, captain.token)).status).toBe(200);
      await withDevices(captain, ...members);
      return { captain, vice, plain: members.slice(1), teamId };
    };
    const A = await build('a');
    const B = await build('b');
    const challenge = await api.call('POST', `${T}/${A.teamId}/challenges`, { challengedTeamId: B.teamId, format: 'F5', proposedStartAt: inHours(72) }, A.captain.token);
    expect(challenge.status).toBe(201);
    await fanOut();
    expect(await recipientsOf('CHALLENGE_RECEIVED')).toEqual([B.captain.userId, B.vice.userId].sort());

    expect((await api.call('POST', `/api/v1/challenges/${challenge.body.challenge.id}/accept`, {}, B.captain.token)).status).toBe(200);
    await fanOut();
    expect(await recipientsOf('CHALLENGE_ACCEPTED')).toEqual([A.captain.userId, A.vice.userId].sort());
    const challengeRecipients = new Set([...(await recipientsOf('CHALLENGE_RECEIVED')), ...(await recipientsOf('CHALLENGE_ACCEPTED'))]);
    for (const u of [...A.plain, ...B.plain]) expect(challengeRecipients.has(u.userId)).toBe(false); // ordinary members hear nothing about challenges
  }, 60_000);
});

describe('MATCH_TIME_CHANGED recipients (confirmed participants AND pending requesters)', () => {
  it('the helper returns both groups, once each, never the person who made the change', async () => {
    const { timeChangeRecipients } = await import('../src/modules/matches/matches.service');
    const prisma = await prismaP();
    const org = await makeUser(api, 'tc-org@example.com');
    const confirmed = await makeUser(api, 'tc-conf@example.com');
    const confirmed2 = await makeUser(api, 'tc-conf2@example.com');
    const pending = await makeUser(api, 'tc-pend@example.com');
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match.id as string;
    for (const u of [confirmed, confirmed2]) {
      const r = (await api.call('POST', `/api/v1/matches/${m}/requests`, {}, u.token)).body.request.id as string;
      await api.call('POST', `/api/v1/matches/${m}/requests/${r}/accept`, {}, org.token);
    }
    await api.call('POST', `/api/v1/matches/${m}/requests`, {}, pending.token);

    const recipients = await prisma.$transaction((tx) => timeChangeRecipients(tx, m, org.userId));
    expect([...recipients].sort()).toEqual([confirmed.userId, confirmed2.userId, pending.userId].sort());
    const withoutActor = await prisma.$transaction((tx) => timeChangeRecipients(tx, m, confirmed.userId));
    expect(withoutActor).not.toContain(confirmed.userId);
    expect(withoutActor).toHaveLength(2);
  });

  it('through the API today the confirmed group is empty (D12), so the notification still reaches the pending requesters', async () => {
    const org = await makeUser(api, 'tc2-org@example.com');
    const pending = await makeUser(api, 'tc2-pend@example.com');
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match.id as string;
    await api.call('POST', `/api/v1/matches/${m}/requests`, {}, pending.token);
    expect((await api.call('PATCH', `/api/v1/matches/${m}`, { startAt: inHours(96) }, org.token)).status).toBe(200);
    const prisma = await prismaP();
    const notes = await prisma.notification.findMany({ where: { type: 'MATCH_TIME_CHANGED' } });
    expect(notes.map((n) => n.userId)).toEqual([pending.userId]);
  });
});

describe('device registration accepts Expo push tokens from Android and iOS only', () => {
  const N = '/api/v1/notifications/devices';
  it('accepts valid tokens on android and ios', async () => {
    const u = await makeUser(api, 'dev@example.com');
    expect((await api.call('POST', N, { token: expoToken(), platform: 'android' }, u.token)).status).toBe(204);
    expect((await api.call('POST', N, { token: 'ExpoPushToken[abcdefghijklmnop]', platform: 'ios' }, u.token)).status).toBe(204);
  });

  it('refuses web, unknown platforms and anything that is not an Expo push token', async () => {
    const u = await makeUser(api, 'dev2@example.com');
    for (const body of [
      { token: expoToken(), platform: 'web' },
      { token: expoToken(), platform: 'windows' },
      { token: 'a-web-push-endpoint-https://fcm.googleapis.com/fcm/send/abc', platform: 'android' },
      { token: 'ExponentPushToken[short]', platform: 'android' },
      { token: 'ExponentPushToken[abcdefghij', platform: 'android' },
      { token: 'xExponentPushToken[abcdefghijklmn]', platform: 'ios' },
      { token: '', platform: 'ios' },
      { platform: 'ios' },
    ]) {
      const res = await api.call('POST', N, body, u.token);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await prismaP()).deviceToken.count()).toBe(0);
  });

  it('web SESSIONS are unaffected: logging in and refreshing never depend on device tokens', async () => {
    const u = await makeUser(api, 'websession@example.com');
    const login = await api.call('POST', '/api/v1/auth/login', { email: 'websession@example.com', password: 'correct horse battery' });
    expect(login.status).toBe(200);
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: login.body.refreshToken })).status).toBe(200);
    expect(u.token).toBeTruthy();
    expect(await (await prismaP()).deviceToken.count()).toBe(0);
  });
});
