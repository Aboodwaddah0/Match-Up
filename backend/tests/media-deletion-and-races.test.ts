import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { confirm, fakeStorage, insertRow, keyOf, MEDIA, photoAsset, prismaP, requestSlot, smallTeam, TEAMS, uploadMedia, warmPool, worker, type FakeStorage } from './helpers/media';
import { makeUser, PASSWORD, type TestUser } from './helpers/users';

/*
 * D18 (account deletion) and media, and the races around the cap, a confirmation, a deletion and the account deletion itself.
 *   - the player's own media becomes DELETING in the deletion transaction (hidden at once), the worker removes the files, the rows go after that;
 *   - team media stays, its uploader shows as "Deleted user";
 *   - the cap holds under concurrent uploads, and nothing published can survive an account deletion.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let fake: FakeStorage;

const deleteAccount = (u: TestUser) => api.call('POST', '/api/v1/users/me/delete', { password: PASSWORD }, u.token);
const mediaOf = async (where: Record<string, unknown>) => (await prismaP()).mediaItem.findMany({ where, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  api = await startApp();
  await warmPool(); // see warmPool: a cold connection pool would turn a burst of concurrent requests into spurious 500s
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  fake = await fakeStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('account deletion (D18)', () => {
  it("hides the player's media at once (DELETING, no URL), keeps TEAM media with the uploader shown as Deleted user, and the worker removes only the player's files", async () => {
    const t = await smallTeam(api, 'd');
    const prisma = await prismaP();
    const vice = t.vice;
    const mine1 = await uploadMedia(api, fake, vice);
    const mine2 = await uploadMedia(api, fake, vice, { kind: 'VIDEO' });
    const pendingSlot = (await requestSlot(api, vice)).body.media.id as string; // an unconfirmed slot of the same player
    const team = await uploadMedia(api, fake, vice, { owner: { type: 'TEAM', teamId: t.teamId }, caption: 'team trophy' });
    const others = await uploadMedia(api, fake, t.member); // someone else's media is not touched

    // a team member must leave the team themselves before deleting the account (D18); their team media stays with the team
    expect((await api.call('POST', `${TEAMS}/${t.teamId}/leave`, {}, vice.token)).status).toBe(204);
    expect((await deleteAccount(vice)).status).toBe(204);

    const own = await mediaOf({ ownerUserId: vice.userId });
    expect(own.map((m) => m.id).sort()).toEqual([mine1.id, mine2.id, pendingSlot].sort());
    for (const m of own) expect(m).toMatchObject({ status: 'DELETING', url: null, thumbnailUrl: null });

    // team media: untouched, still published, uploader anonymized
    expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ status: 'READY', uploadedById: vice.userId });
    const list = await api.call('GET', `${TEAMS}/${t.teamId}/media`, undefined, t.captain.token);
    expect(list.body.media).toHaveLength(1);
    expect(list.body.media[0]).toMatchObject({ id: team.id, caption: 'team trophy', uploadedBy: { id: vice.userId, fullName: 'Deleted user', deleted: true } });
    expect((await api.call('GET', `/api/v1/players/${vice.userId}/media`, undefined, t.captain.token)).status).toBe(404);

    // the worker: the player's three files go (image / video / the never-confirmed slot), the team file and the other player's file stay
    const teamKey = await keyOf(team.id);
    const othersKey = await keyOf(others.id);
    const result = await (await worker()).runMediaWorkerOnce();
    expect(result).toMatchObject({ deleted: 3, retried: 0 });
    expect(await mediaOf({ ownerUserId: vice.userId })).toEqual([]);
    expect([...fake.objects.keys()].sort()).toEqual([`image:${othersKey}`, `image:${teamKey}`].sort());
    expect(await prisma.mediaItem.count({ where: { status: 'READY' } })).toBe(2);
  });

  it('a failing provider does not block the account deletion: the account is anonymized now, the files are retried until they are gone', async () => {
    const ann = await makeUser(api, 'ann@example.com');
    const a = await uploadMedia(api, fake, ann);
    fake.failDestroy(() => new fake.StorageError('down', 'TRANSIENT', 'HTTP_503'));
    expect((await deleteAccount(ann)).status).toBe(204);
    expect(await (await prismaP()).user.findUniqueOrThrow({ where: { id: ann.userId } })).toMatchObject({ status: 'DELETED', fullName: 'Deleted user' });
    expect(await (await worker()).runMediaWorkerOnce()).toMatchObject({ retried: 1, deleted: 0 });
    expect(await mediaOf({ id: a.id })).toHaveLength(1); // still recorded: the file is still at the provider
    fake.failDestroy(null);
    await (await import('./helpers/media')).asIfTimePassed(`UPDATE media_item SET next_deletion_at = now() - interval '1 second' WHERE id = $1::uuid`, a.id);
    expect(await (await worker()).runMediaWorkerOnce()).toMatchObject({ deleted: 1 });
    expect(await mediaOf({ id: a.id })).toEqual([]);
  });

  it('the audit record of the deletion is unchanged (counts only)', async () => {
    const ann = await makeUser(api, 'ann@example.com');
    await uploadMedia(api, fake, ann);
    await deleteAccount(ann);
    const record = await (await prismaP()).adminAuditLog.findFirstOrThrow({ where: { action: 'ACCOUNT_DELETED' } });
    expect(Object.keys(record.metadata as object).sort()).toEqual(['cancelledBookings', 'cancelledChallenges', 'expiredMatchInvitations', 'expiredTeamInvitations', 'removedStaffRoles', 'withdrawnRequests']);
  });
});

describe('races', () => {
  it('a confirmation that races an account deletion waits for it and then finds the slot gone: nothing READY survives', async () => {
    const prisma = await prismaP();
    const ann = await makeUser(api, 'ann@example.com');
    const slot = await requestSlot(api, ann);
    const id = slot.body.media.id as string;
    const key = await keyOf(id);
    fake.put(key, 'image', photoAsset(key));

    // an account deletion in flight: it holds the user row and has already marked the media DELETING, but has not committed
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const deleting = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${ann.userId}::uuid FOR NO KEY UPDATE`;
        entered();
        await hold;
        const { markPlayerMediaForDeletion } = await import('../src/modules/media/media.service');
        await markPlayerMediaForDeletion(tx, ann.userId);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await inside;
    let settled = false;
    const confirming = confirm(api, ann, id).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 800));
    expect(settled).toBe(false); // queued behind the user-row lock, the same first lock account deletion takes
    release();
    await deleting;
    expect((await confirming).status).toBe(404);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).status).toBe('DELETING');
    expect(await prisma.mediaItem.count({ where: { status: 'READY' } })).toBe(0);
  });

  it('account deletion racing uploads and confirmations (several rounds): every item ends DELETING, none READY, no server errors', async () => {
    const prisma = await prismaP();
    for (let round = 0; round < 4; round++) {
      const u = await makeUser(api, `race${round}@example.com`);
      const ready = await uploadMedia(api, fake, u);
      const slotRes = await requestSlot(api, u);
      const slotId = slotRes.body.media.id as string;
      fake.put(await keyOf(slotId), 'image', photoAsset(await keyOf(slotId)));
      const results = await Promise.all([deleteAccount(u), confirm(api, u, slotId), requestSlot(api, u), api.call('PATCH', `${MEDIA}/${ready.id}`, { caption: 'x' }, u.token)]);
      for (const r of results) expect(r.status).toBeLessThan(500);
      expect(results[0]!.status).toBe(204);
      expect(await prisma.mediaItem.count({ where: { ownerUserId: u.userId, status: { not: 'DELETING' } } })).toBe(0);
    }
  });

  it('a confirmation racing a deletion of the same item ends in exactly one state: DELETING (the file is cleaned up), never a half-published item', async () => {
    const prisma = await prismaP();
    const ann = await makeUser(api, 'ann@example.com');
    for (let round = 0; round < 5; round++) {
      const slot = await requestSlot(api, ann);
      const id = slot.body.media.id as string;
      fake.put(await keyOf(id), 'image', photoAsset(await keyOf(id)));
      const [c, d] = await Promise.all([confirm(api, ann, id), api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token)]);
      expect([200, 404]).toContain(c.status);
      expect(d.status).toBe(204);
      expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DELETING', url: null });
    }
  });

  it('simultaneous slot requests never exceed the cap: with one place left exactly one succeeds, the rest get 409, nobody gets a 500 or a deadlock', async () => {
    const ann = await makeUser(api, 'ann@example.com');
    for (let i = 0; i < 29; i++) await insertRow({ ownerUserId: ann.userId, uploadedById: ann.userId });
    const results = await Promise.all(Array.from({ length: 10 }, () => requestSlot(api, ann)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'MEDIA_LIMIT_REACHED')).toHaveLength(9);
    expect(await (await prismaP()).mediaItem.count({ where: { ownerUserId: ann.userId, status: { not: 'DELETING' } } })).toBe(30);
  });

  it('the same for a team, with the captain and the vice captain uploading at once', async () => {
    const t = await smallTeam(api, 'r');
    for (let i = 0; i < 49; i++) await insertRow({ teamId: t.teamId, ownerUserId: null, uploadedById: t.captain.userId });
    const owner = { type: 'TEAM', teamId: t.teamId };
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => requestSlot(api, t.captain, { owner })),
      ...Array.from({ length: 5 }, () => requestSlot(api, t.vice, { owner })),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await (await prismaP()).mediaItem.count({ where: { teamId: t.teamId, status: { not: 'DELETING' } } })).toBe(50);
  });

  it('uploads racing deletions at the cap: the number of live items never exceeds 30 and a freed place is usable once', async () => {
    const prisma = await prismaP();
    const ann = await makeUser(api, 'ann@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await insertRow({ ownerUserId: ann.userId, uploadedById: ann.userId }));
    const results = await Promise.all([
      api.call('DELETE', `${MEDIA}/${ids[0]}`, undefined, ann.token),
      api.call('DELETE', `${MEDIA}/${ids[1]}`, undefined, ann.token),
      ...Array.from({ length: 8 }, () => requestSlot(api, ann)),
    ]);
    for (const r of results) expect(r.status).toBeLessThan(500);
    const live = await prisma.mediaItem.count({ where: { ownerUserId: ann.userId, status: { not: 'DELETING' } } });
    expect(live).toBeLessThanOrEqual(30);
    // two places were freed: at most two new slots can exist
    expect(results.slice(2).filter((r) => r.status === 201).length).toBeLessThanOrEqual(2);
    expect(live).toBe(28 + results.slice(2).filter((r) => r.status === 201).length);
  });
});
