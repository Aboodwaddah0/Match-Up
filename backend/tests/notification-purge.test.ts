import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { addDevice, addNotification } from './helpers/push';
import { makeUser, matchBody, PASSWORD, type TestUser } from './helpers/users';

/*
 * PRIV-01 review fix: a notification can be inserted for an account that is being deleted a moment before the deletion commits (the notifier read
 * the recipient as ACTIVE; its insert takes only a key-share lock on the user row, so it is neither blocked by nor visible to the deletion).
 * The bounded, idempotent lifecycle job `purgeDeletedUserNotifications` removes such rows. It takes no lock on any user row.
 */

let api: Awaited<ReturnType<typeof startApp>>;
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const jobs = () => import('../src/jobs/match-lifecycle');

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

const user = (email: string) => makeUser(api, email, { verified: true, profile: false });
const markDeleted = async (u: TestUser) => void (await (await prismaP()).user.update({ where: { id: u.userId }, data: { status: 'DELETED' } }));
const count = async (u: TestUser) => (await prismaP()).notification.count({ where: { userId: u.userId } });
async function strays(u: TestUser, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await addNotification(u.userId, 'MATCH_CANCELLED')).id);
  return ids;
}

describe('purging notifications of deleted accounts', () => {
  it('removes the notifications (and their push deliveries first) of DELETED accounts only, and leaves history alone', async () => {
    const prisma = await prismaP();
    const gone = await user('gone@example.com');
    const live = await user('live@example.com');
    const host = await user('host@example.com');
    // history that must survive: a match the user organized, a report they filed, an audit record
    const matchId = (await api.call('POST', '/api/v1/matches', matchBody({ title: 'History match' }), gone.token)).body.match.id as string;
    await api.call('POST', '/api/v1/reports', { targetType: 'USER', targetId: host.userId, reason: 'OTHER', details: 'kept text' }, gone.token);
    await prisma.adminAuditLog.create({ data: { actorId: host.userId, action: 'USER_SUSPENDED', targetType: 'USER', targetId: gone.userId, metadata: {} } });
    const before = { matches: await prisma.match.count(), reports: await prisma.report.count(), audit: await prisma.adminAuditLog.count() };

    const device = await addDevice(gone.userId);
    const strayIds = await strays(gone, 3);
    await prisma.pushDelivery.create({ data: { notificationId: strayIds[0]!, userId: gone.userId, deviceTokenId: device.id, expoToken: device.token } });
    const liveIds = await strays(live, 2);
    await markDeleted(gone);

    expect(await (await jobs()).purgeDeletedUserNotifications()).toBe(3);

    expect(await count(gone)).toBe(0);
    expect(await prisma.pushDelivery.count({ where: { userId: gone.userId } })).toBe(0);
    expect(await count(live)).toBe(liveIds.length); // an ACTIVE account is never touched
    expect({ matches: await prisma.match.count(), reports: await prisma.report.count(), audit: await prisma.adminAuditLog.count() }).toEqual(before);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).organizerId).toBe(gone.userId);
  });

  it('is idempotent: a second run finds nothing, and running it twice at the same time is safe', async () => {
    const gone = await user('gone@example.com');
    await strays(gone, 4);
    await markDeleted(gone);
    const { purgeDeletedUserNotifications } = await jobs();
    const results = await Promise.all([purgeDeletedUserNotifications(), purgeDeletedUserNotifications()]);
    expect(results[0]! + results[1]!).toBe(4); // each notification removed exactly once
    expect(await purgeDeletedUserNotifications()).toBe(0);
    expect(await count(gone)).toBe(0);
  });

  it('is bounded: at most batchSize notifications of a user per run, the backlog continues on the next run; users are taken batchSize at a time', async () => {
    const gone = await user('gone@example.com');
    await strays(gone, 5);
    await markDeleted(gone);
    const { purgeDeletedUserNotifications } = await jobs();
    const removed = [];
    for (let i = 0; i < 4; i++) removed.push(await purgeDeletedUserNotifications({ batchSize: 2 }));
    expect(removed).toEqual([2, 2, 1, 0]);
    expect(await count(gone)).toBe(0);

    // several users: maxBatches limits how many are handled in one run
    const others: TestUser[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await user(`other${i}@example.com`);
      await strays(u, 1);
      await markDeleted(u);
      others.push(u);
    }
    expect(await purgeDeletedUserNotifications({ batchSize: 1, maxBatches: 2 })).toBe(2);
    expect(await purgeDeletedUserNotifications({ batchSize: 1, maxBatches: 2 })).toBe(1);
    expect(await purgeDeletedUserNotifications()).toBe(0);
  });

  it('is part of the lifecycle jobs and reports what it removed', async () => {
    const gone = await user('gone@example.com');
    await strays(gone, 2);
    await markDeleted(gone);
    const { runLifecycleJobs } = await jobs();
    expect(await runLifecycleJobs()).toMatchObject({ purged: 2, failedJobs: [], failedRows: 0 });
    expect(await runLifecycleJobs()).toMatchObject({ purged: 0 });
  });

  it('a notifier already INSERTING while the account is deleted is removed by the deletion itself: it waits for that insert and erases the row afterwards', async () => {
    const prisma = await prismaP();
    const u = await user('inflight@example.com');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const notifier = prisma.$transaction(
      async (tx) => {
        await tx.notification.create({ data: { userId: u.userId, type: 'MATCH_CANCELLED', params: {} } });
        entered();
        await hold;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await inside;
    let settled = false;
    const deleting = api.call('POST', '/api/v1/users/me/delete', { password: PASSWORD }, u.token).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 700));
    expect(settled).toBe(false); // the anonymizing UPDATE waits for the in-flight insert that references the user
    release();
    await notifier;
    expect((await deleting).status).toBe(204);
    expect(await count(u)).toBe(0); // the notification the notifier committed was erased too: no stray
  });

  it('removes a REAL stray: a notifier that starts inserting while the deletion holds its locks commits after it, and the job then removes the row', async () => {
    const prisma = await prismaP();
    const u = await user('racing@example.com');
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION purge_test_slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'DELETED' AND OLD.status <> 'DELETED' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_purge_test_slow_delete BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION purge_test_slow_delete()`);
    try {
      const deleting = api.call('POST', '/api/v1/users/me/delete', { password: PASSWORD }, u.token);
      await new Promise((r) => setTimeout(r, 900)); // the deletion now holds the user row (inside its slowed anonymizing update)
      // a notifier that read the account as ACTIVE a moment ago: its insert has to wait for that lock and commits after the deletion
      const notifying = prisma.notification.create({ data: { userId: u.userId, type: 'MATCH_CANCELLED', params: {} } });
      expect((await deleting).status).toBe(204);
      await notifying;
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_purge_test_slow_delete ON "user"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS purge_test_slow_delete()`);
    }
    expect(await count(u)).toBe(1); // the stray the review describes

    expect(await (await jobs()).purgeDeletedUserNotifications()).toBe(1);
    expect(await count(u)).toBe(0);
  });
});
