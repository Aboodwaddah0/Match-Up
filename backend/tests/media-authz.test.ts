import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { asIfTimePassed, confirm, fakeStorage, insertRow, keyOf, MEDIA, prismaP, requestSlot, smallTeam, TEAMS, uploadMedia, type FakeStorage, type SmallTeam } from './helpers/media';
import { makeUser, type TestUser } from './helpers/users';

/*
 * Who may do what with media:
 *   player media  the owner only
 *   team media    captain AND vice captain (any item of their team); members and outsiders read only
 *   admin         removes anything through an audited action
 *   reports       MEDIA is a report target (READY and visible items only)
 */

let api: Awaited<ReturnType<typeof startApp>>;
let fake: FakeStorage;
let t: SmallTeam;
let ann: TestUser;
let bob: TestUser;
let admin: TestUser;

const playerList = (viewer: TestUser, ownerId: string) => api.call('GET', `/api/v1/players/${ownerId}/media`, undefined, viewer.token);
const teamList = (viewer: TestUser) => api.call('GET', `${TEAMS}/${t.teamId}/media`, undefined, viewer.token);
const teamOwner = () => ({ type: 'TEAM' as const, teamId: t.teamId });

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  fake = await fakeStorage();
  t = await smallTeam(api, 'a');
  ann = await makeUser(api, 'ann@example.com');
  bob = await makeUser(api, 'bob@example.com');
  admin = await makeUser(api, 'admin@example.com');
  await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
});

describe('player media: the owner only', () => {
  it('another user can view READY items but cannot edit, delete or confirm them (403), and cannot see unconfirmed ones at all (404)', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    const pending = (await requestSlot(api, ann)).body.media.id as string;
    expect((await playerList(bob, ann.userId)).body.media.map((m: { id: string }) => m.id)).toEqual([id]); // visible to others, PENDING is not
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: 'mine now' }, bob.token)).status).toBe(403);
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, bob.token)).status).toBe(403);
    expect((await api.call('PATCH', `${MEDIA}/${pending}`, { caption: 'x' }, bob.token)).status).toBe(404);
    expect((await api.call('DELETE', `${MEDIA}/${pending}`, undefined, bob.token)).status).toBe(404);
    expect((await confirm(api, bob, pending)).status).toBe(404);
    const row = await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'READY', caption: null });
  });

  it("nobody can upload INTO another player's media: the slot is always the caller's own", async () => {
    const res = await requestSlot(api, bob, { owner: { type: 'PLAYER' } });
    expect((await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id: res.body.media.id } })).ownerUserId).toBe(bob.userId);
  });

  it('a blocked pair cannot see each other\'s media (404, like profiles) and a suspended or deleted owner\'s media is hidden', async () => {
    await uploadMedia(api, fake, ann);
    expect((await playerList(bob, ann.userId)).status).toBe(200);
    await api.call('POST', '/api/v1/users/me/blocks', { userId: bob.userId }, ann.token);
    expect((await playerList(bob, ann.userId)).status).toBe(404);
    expect((await playerList(ann, ann.userId)).status).toBe(200); // the owner still sees their own
    await api.call('DELETE', `/api/v1/users/me/blocks/${bob.userId}`, undefined, ann.token);
    await (await prismaP()).user.update({ where: { id: ann.userId }, data: { status: 'SUSPENDED' } });
    expect((await playerList(bob, ann.userId)).status).toBe(404);
    expect((await playerList(bob, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('every call needs a signed-in user', async () => {
    expect((await api.call('GET', `/api/v1/players/${ann.userId}/media`)).status).toBe(401);
    expect((await api.call('GET', `${TEAMS}/${t.teamId}/media`)).status).toBe(401);
    expect((await api.call('PATCH', `${MEDIA}/${ann.userId}`, { caption: 'x' })).status).toBe(401);
    expect((await api.call('DELETE', `${MEDIA}/${ann.userId}`)).status).toBe(401);
    expect((await api.call('POST', `${MEDIA}/${ann.userId}/confirm`, {})).status).toBe(401);
  });
});

describe('team media: captain and vice captain manage, everyone else reads', () => {
  it('captain and vice captain can both upload, confirm, edit and delete; the list says who uploaded and whether I can manage', async () => {
    const a = await uploadMedia(api, fake, t.captain, { owner: teamOwner(), caption: 'Cup final' });
    const b = await uploadMedia(api, fake, t.vice, { owner: teamOwner(), kind: 'VIDEO' });
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    expect(a.res.body.media.owner).toEqual({ type: 'TEAM', teamId: t.teamId });

    const asVice = await teamList(t.vice);
    expect(asVice.body).toMatchObject({ count: 2, limit: 50, canManage: true });
    expect(asVice.body.media.map((m: { uploadedBy: { id: string } }) => m.uploadedBy.id)).toEqual([t.captain.userId, t.vice.userId]);
    expect((await teamList(t.member)).body.canManage).toBe(false);
    expect((await teamList(t.outsider)).body.canManage).toBe(false);

    // each can edit and delete ANY item of the team, including one the other uploaded
    expect((await api.call('PATCH', `${MEDIA}/${a.id}`, { caption: 'by vice' }, t.vice.token)).body.media.caption).toBe('by vice');
    expect((await api.call('PATCH', `${MEDIA}/${b.id}`, { sortOrder: 9 }, t.captain.token)).body.media.sortOrder).toBe(9);
    expect((await api.call('DELETE', `${MEDIA}/${a.id}`, undefined, t.vice.token)).status).toBe(204);
    expect((await api.call('DELETE', `${MEDIA}/${b.id}`, undefined, t.captain.token)).status).toBe(204);
    expect((await teamList(t.member)).body.media).toEqual([]);
  });

  it('a plain member and an outsider can read but cannot upload, edit, delete or confirm (403)', async () => {
    const { id } = await uploadMedia(api, fake, t.captain, { owner: teamOwner() });
    expect((await teamList(t.member)).body.count).toBe(1);
    expect((await teamList(t.outsider)).body.count).toBe(1); // teams are readable by every signed-in user
    for (const user of [t.member, t.outsider]) {
      expect((await requestSlot(api, user, { owner: teamOwner() })).status).toBe(403);
      expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: 'x' }, user.token)).status).toBe(403);
      expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, user.token)).status).toBe(403);
    }
    expect(await (await prismaP()).mediaItem.count()).toBe(1);
  });

  it("an unconfirmed upload of a colleague is invisible to the rest of the team (404) and only its uploader may confirm it", async () => {
    const slot = await requestSlot(api, t.vice, { owner: teamOwner() });
    const id = slot.body.media.id as string;
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: 'x' }, t.captain.token)).status).toBe(404);
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, t.captain.token)).status).toBe(404);
    expect((await confirm(api, t.captain, id)).status).toBe(404); // not the uploader
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, t.vice.token)).status).toBe(204); // the uploader may abandon it
  });

  it('an unknown team is 404; the cap of 50 is per team', async () => {
    expect((await requestSlot(api, ann, { owner: { type: 'TEAM', teamId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
    for (let i = 0; i < 50; i++) await insertRow({ teamId: t.teamId, ownerUserId: null, uploadedById: t.captain.userId });
    const res = await requestSlot(api, t.captain, { owner: teamOwner() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MEDIA_LIMIT_REACHED');
    expect((await requestSlot(api, t.captain)).status).toBe(201); // the captain's own player media is a separate counter
  });

  it('after the captain demotes the vice captain, the vice captain cannot upload, edit or delete team media any more', async () => {
    const { id } = await uploadMedia(api, fake, t.captain, { owner: teamOwner() });
    expect((await api.call('PATCH', `${TEAMS}/${t.teamId}/members/${t.vice.userId}`, { role: 'MEMBER' }, t.captain.token)).status).toBe(200);
    expect((await requestSlot(api, t.vice, { owner: teamOwner() })).status).toBe(403);
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: 'x' }, t.vice.token)).status).toBe(403);
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, t.vice.token)).status).toBe(403);
    expect((await teamList(t.vice)).body.canManage).toBe(false);
  });

  it('team media outlives its uploader leaving the team: the new staff manage it, the old uploader no longer can', async () => {
    const { id } = await uploadMedia(api, fake, t.vice, { owner: teamOwner() });
    expect((await api.call('POST', `${TEAMS}/${t.teamId}/leave`, {}, t.vice.token)).status).toBe(204);
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, t.vice.token)).status).toBe(403);
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: 'kept' }, t.captain.token)).status).toBe(200);
  });
});

describe('confirmation and deletion re-check the team role when they commit (not only when the upload was requested)', () => {
  it('a vice captain demoted between the slot and the confirmation cannot publish: 403, and the upload is cleaned up', async () => {
    const slot = await requestSlot(api, t.vice, { owner: teamOwner() });
    const id = slot.body.media.id as string;
    fake.put(await keyOf(id), 'image', (await import('./helpers/media')).photoAsset(await keyOf(id)));
    await api.call('PATCH', `${TEAMS}/${t.teamId}/members/${t.vice.userId}`, { role: 'MEMBER' }, t.captain.token);
    const res = await confirm(api, t.vice, id);
    expect(res.status).toBe(403);
    const row = await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'DELETING', url: null }); // the file is removed by the worker; nothing was published
  });

  it('a demotion that is IN FLIGHT when the confirmation commits is serialized with it: the confirmation waits and then fails', async () => {
    const prisma = await prismaP();
    const { photoAsset } = await import('./helpers/media');
    const slot = await requestSlot(api, t.vice, { owner: teamOwner() });
    const id = slot.body.media.id as string;
    fake.put(await keyOf(id), 'image', photoAsset(await keyOf(id)));

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    // the captain's demotion of the vice captain, started but not yet committed: it holds the membership row
    const demoting = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT role FROM team_member WHERE team_id = ${t.teamId}::uuid AND user_id = ${t.vice.userId}::uuid FOR UPDATE`;
        entered();
        await hold;
        await tx.teamMember.update({ where: { teamId_userId: { teamId: t.teamId, userId: t.vice.userId } }, data: { role: 'MEMBER' } });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await inside;
    let settled = false;
    const confirming = confirm(api, t.vice, id).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 800));
    expect(settled).toBe(false); // waits for the membership row instead of deciding on the old role
    release();
    await demoting;
    const res = await confirming;
    expect(res.status).toBe(403);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).status).toBe('DELETING');
  });

  it('the same for deletion: a delete that races a demotion waits and is refused when the role is gone', async () => {
    const prisma = await prismaP();
    const { id } = await uploadMedia(api, fake, t.captain, { owner: teamOwner() });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const demoting = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT role FROM team_member WHERE team_id = ${t.teamId}::uuid AND user_id = ${t.vice.userId}::uuid FOR UPDATE`;
        entered();
        await hold;
        await tx.teamMember.update({ where: { teamId_userId: { teamId: t.teamId, userId: t.vice.userId } }, data: { role: 'MEMBER' } });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await inside;
    let settled = false;
    const deleting = api.call('DELETE', `${MEDIA}/${id}`, undefined, t.vice.token).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 800));
    expect(settled).toBe(false);
    release();
    await demoting;
    expect((await deleting).status).toBe(403);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).status).toBe('READY'); // nothing was removed
  });
});

describe('administrators', () => {
  it('only an admin may use the removal endpoint (403 for everyone, including the owner)', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    expect((await api.call('POST', `/api/v1/admin/media/${id}/remove`, {}, ann.token)).status).toBe(403);
    expect((await api.call('POST', `/api/v1/admin/media/${id}/remove`, {})).status).toBe(401);
    expect((await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id } })).status).toBe('READY');
  });

  it('removes any item (player or team) with ONE immutable audit record each, hides it at once and queues the file for deletion', async () => {
    const prisma = await prismaP();
    const player = await uploadMedia(api, fake, ann, { caption: 'private words' });
    const team = await uploadMedia(api, fake, t.vice, { owner: teamOwner() });
    expect((await api.call('POST', `/api/v1/admin/media/${player.id}/remove`, { reason: 'inappropriate' }, admin.token)).status).toBe(204);
    expect((await api.call('POST', `/api/v1/admin/media/${team.id}/remove`, {}, admin.token)).status).toBe(204);

    for (const id of [player.id, team.id]) {
      expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DELETING', url: null, thumbnailUrl: null });
    }
    expect((await playerList(bob, ann.userId)).body.media).toEqual([]);
    expect((await teamList(bob)).body.media).toEqual([]);

    const records = await prisma.adminAuditLog.findMany({ where: { action: 'MEDIA_REMOVED_BY_ADMIN' }, orderBy: { createdAt: 'asc' } });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ actorId: admin.userId, targetType: 'MEDIA', targetId: player.id, reason: 'inappropriate' });
    expect(records[0]!.metadata).toEqual({ kind: 'PHOTO', fromStatus: 'READY', ownerType: 'PLAYER', ownerUserId: ann.userId, uploadedById: ann.userId });
    expect(records[1]!.metadata).toEqual({ kind: 'PHOTO', fromStatus: 'READY', ownerType: 'TEAM', teamId: t.teamId, uploadedById: t.vice.userId });
    expect(JSON.stringify(records.map((r) => r.metadata))).not.toContain('private words'); // free text never enters the audit log
    // the audit log can be filtered by the new target type
    const log = await api.call('GET', '/api/v1/admin/audit-log?targetType=MEDIA', undefined, admin.token);
    expect(log.status).toBe(200);
    expect(log.body.total).toBe(2);
  });

  it('removing the same item twice (or at once) records ONE action: the second answer is 409', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    const results = await Promise.all([1, 2, 3].map(() => api.call('POST', `/api/v1/admin/media/${id}/remove`, {}, admin.token)));
    expect(results.map((r) => r.status).sort()).toEqual([204, 409, 409]);
    expect(await (await prismaP()).adminAuditLog.count({ where: { action: 'MEDIA_REMOVED_BY_ADMIN' } })).toBe(1);
    expect((await api.call('POST', `/api/v1/admin/media/00000000-0000-4000-8000-000000000000/remove`, {}, admin.token)).status).toBe(404);
  });

  it('the stats show files that stay undeleted for more than a day', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token);
    expect((await api.call('GET', '/api/v1/admin/stats', undefined, admin.token)).body.mediaDeletionStuck).toBe(0);
    await asIfTimePassed(`UPDATE media_item SET deleting_since = now() - interval '25 hours' WHERE id = $1::uuid`, id);
    expect((await api.call('GET', '/api/v1/admin/stats', undefined, admin.token)).body.mediaDeletionStuck).toBe(1);
  });
});

describe('reporting media', () => {
  const report = (user: TestUser, targetId: string) => api.call('POST', '/api/v1/reports', { targetType: 'MEDIA', targetId, reason: 'INAPPROPRIATE_CONTENT', details: 'not ok' }, user.token);

  it('anyone who can see a READY item can report it; one open report per reporter and target; it enters the moderation queue', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    const res = await report(bob, id);
    expect(res.status).toBe(201);
    expect((await report(bob, id)).body.error.code).toBe('ALREADY_REPORTED');
    const queue = await api.call('GET', '/api/v1/admin/reports?targetType=MEDIA', undefined, admin.token);
    expect(queue.body.total).toBe(1);
    expect(queue.body.reports[0]).toMatchObject({ targetType: 'MEDIA', targetId: id });
    // team media too
    const team = await uploadMedia(api, fake, t.captain, { owner: teamOwner() });
    expect((await report(bob, team.id)).status).toBe(201);
  });

  it('cannot report an unconfirmed item, a removed one, a missing one, or one of a user who blocked you / who is suspended', async () => {
    const pending = (await requestSlot(api, ann)).body.media.id as string;
    expect((await report(bob, pending)).status).toBe(404);
    const { id } = await uploadMedia(api, fake, ann);
    await api.call('POST', '/api/v1/users/me/blocks', { userId: bob.userId }, ann.token);
    expect((await report(bob, id)).status).toBe(404);
    await api.call('DELETE', `/api/v1/users/me/blocks/${bob.userId}`, undefined, ann.token);
    expect((await report(bob, id)).status).toBe(201);
    const gone = await uploadMedia(api, fake, ann);
    await api.call('DELETE', `${MEDIA}/${gone.id}`, undefined, ann.token);
    expect((await report(bob, gone.id)).status).toBe(404);
    expect((await report(bob, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
