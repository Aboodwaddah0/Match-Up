import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';
import { setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let admin: TestUser;
let user: TestUser;
let owner: TestUser;
let venueId: string;
let cityId: string;

const A = '/api/v1/admin';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const records = async () => (await prismaP()).adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  const prisma = await prismaP();
  cityId = (await prisma.city.create({ data: { nameAr: 'الخليل', nameEn: 'Hebron' } })).id;
  admin = await makeUser(api, 'admin@example.com');
  await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  user = await makeUser(api, 'user@example.com');
  owner = await makeUser(api, 'owner@example.com');
  ({ venueId } = await setupVenue(api, owner, cityId));
});

/** A trigger that makes writes to one table fail, to prove that an action and its record succeed or fail together. */
async function failWritesOn(table: string, event: 'INSERT' | 'UPDATE', fn: () => Promise<void>) {
  const prisma = await prismaP();
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_audit_test_fail BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION audit_test_fail()`);
  try {
    await fn();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_audit_test_fail ON "${table}"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit_test_fail()`);
  }
}

describe('a successful admin action writes exactly one audit record', () => {
  it('suspending a user: actor, action, target, reason, state change and the request id of the call', async () => {
    const res = await api.call('POST', `${A}/users/${user.userId}/suspend`, { reason: '  repeated harassment  ' }, admin.token);
    expect(res.status).toBe(204);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.userId,
      action: 'USER_SUSPENDED',
      targetType: 'USER',
      targetId: user.userId,
      reason: 'repeated harassment',
      metadata: { fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' },
    });
    expect(rows[0]!.requestId).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it('reactivating a user, suspending and reactivating a venue, and each report status change', async () => {
    const prisma = await prismaP();
    await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token);
    await api.call('POST', `${A}/users/${user.userId}/reactivate`, {}, admin.token);
    await api.call('POST', `${A}/venues/${venueId}/suspend`, { reason: 'fake venue' }, admin.token);
    await api.call('POST', `${A}/venues/${venueId}/reactivate`, {}, admin.token);
    const reporter = await makeUser(api, 'reporter@example.com');
    const rep = await api.call('POST', '/api/v1/reports', { targetType: 'USER', targetId: user.userId, reason: 'SPAM' }, reporter.token);
    const reportId = rep.body.report.id as string;
    expect((await api.call('PATCH', `${A}/reports/${reportId}`, { status: 'IN_REVIEW' }, admin.token)).status).toBe(200);
    expect((await api.call('PATCH', `${A}/reports/${reportId}`, { status: 'RESOLVED' }, admin.token)).status).toBe(200);

    const rows = await records();
    expect(rows.map((r) => `${r.action}:${r.targetType}`)).toEqual([
      'USER_SUSPENDED:USER',
      'USER_REACTIVATED:USER',
      'VENUE_SUSPENDED:VENUE',
      'VENUE_REACTIVATED:VENUE',
      'REPORT_STATUS_CHANGED:REPORT',
      'REPORT_STATUS_CHANGED:REPORT',
    ]);
    expect(rows[2]).toMatchObject({ targetId: venueId, reason: 'fake venue', metadata: { fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' } });
    expect(rows[4]).toMatchObject({ targetId: reportId, metadata: { fromStatus: 'OPEN', toStatus: 'IN_REVIEW' } });
    expect(rows[5]).toMatchObject({ metadata: { fromStatus: 'IN_REVIEW', toStatus: 'RESOLVED' } });
    expect(rows.every((r) => r.actorId === admin.userId)).toBe(true);
    expect(await prisma.adminAuditLog.count()).toBe(6);
  });

  it('repeating an idempotent suspension does not add a second record; refused actions add none', async () => {
    await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token);
    expect((await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token)).status).toBe(204); // no state change
    expect(await (await prismaP()).adminAuditLog.count()).toBe(1);

    expect((await api.call('POST', `${A}/users/${admin.userId}/suspend`, {}, admin.token)).status).toBe(400); // yourself
    expect((await api.call('POST', `${A}/users/${owner.userId}/reactivate`, {}, admin.token)).status).toBe(409); // not suspended
    expect((await api.call('POST', `${A}/venues/${venueId}/reactivate`, {}, admin.token)).status).toBe(409); // not suspended
    expect((await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, owner.token)).status).toBe(403); // not an admin
    expect(await (await prismaP()).adminAuditLog.count()).toBe(1);
  });

  it('a record holds no e-mail, name, password or token', async () => {
    await api.call('POST', `${A}/users/${user.userId}/suspend`, { reason: 'spam' }, admin.token);
    const text = JSON.stringify(await records());
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain('admin@example.com');
    expect(text.toLowerCase()).not.toMatch(/password|token|hash/);
  });
});

describe('the record and the action commit or roll back together', () => {
  it('if the action fails AFTER the record was written, the record is rolled back too (user suspension)', async () => {
    const prisma = await prismaP();
    expect(await prisma.refreshToken.count({ where: { userId: user.userId, revokedAt: null } })).toBeGreaterThan(0);
    await failWritesOn('refresh_token', 'UPDATE', async () => {
      expect((await api.call('POST', `${A}/users/${user.userId}/suspend`, { reason: 'x' }, admin.token)).status).toBe(500);
    });
    expect(await prisma.adminAuditLog.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).status).toBe('ACTIVE');
  });

  it('if the action fails AFTER the record was written, the record is rolled back too (venue and report, via the owner / reporter notification)', async () => {
    const prisma = await prismaP();
    await failWritesOn('notification', 'INSERT', async () => {
      expect((await api.call('POST', `${A}/venues/${venueId}/suspend`, { reason: 'x' }, admin.token)).status).toBe(500);
      const reporter = await makeUser(api, 'reporter@example.com');
      const rep = await api.call('POST', '/api/v1/reports', { targetType: 'USER', targetId: user.userId, reason: 'SPAM' }, reporter.token);
      expect((await api.call('PATCH', `${A}/reports/${rep.body.report.id}`, { status: 'RESOLVED' }, admin.token)).status).toBe(500);
      expect((await prisma.report.findUniqueOrThrow({ where: { id: rep.body.report.id } })).status).toBe('OPEN');
    });
    expect(await prisma.adminAuditLog.count()).toBe(0);
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).status).toBe('ACTIVE');
  });

  it('if the record cannot be written, the action is NOT applied (no action without a record)', async () => {
    const prisma = await prismaP();
    const reporter = await makeUser(api, 'reporter2@example.com');
    const rep = await api.call('POST', '/api/v1/reports', { targetType: 'USER', targetId: user.userId, reason: 'SPAM' }, reporter.token);
    await api.call('POST', `${A}/users/${owner.userId}/suspend`, {}, admin.token); // so reactivate has something to do
    const before = await prisma.adminAuditLog.count();

    await failWritesOn('admin_audit_log', 'INSERT', async () => {
      expect((await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token)).status).toBe(500);
      expect((await api.call('POST', `${A}/users/${owner.userId}/reactivate`, {}, admin.token)).status).toBe(500);
      expect((await api.call('POST', `${A}/venues/${venueId}/suspend`, {}, admin.token)).status).toBe(500);
      expect((await api.call('PATCH', `${A}/reports/${rep.body.report.id}`, { status: 'DISMISSED' }, admin.token)).status).toBe(500);
    });
    expect(await prisma.adminAuditLog.count()).toBe(before);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).status).toBe('ACTIVE');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).status).toBe('SUSPENDED');
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).status).toBe('ACTIVE');
    expect((await prisma.report.findUniqueOrThrow({ where: { id: rep.body.report.id } })).status).toBe('OPEN');
  });
});

describe('the log is append-only and keeps its history', () => {
  it('UPDATE and DELETE are refused by the database, for the application role too', async () => {
    const prisma = await prismaP();
    await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token);
    const [row] = await records();
    await expect(prisma.adminAuditLog.update({ where: { id: row!.id }, data: { reason: 'edited' } })).rejects.toThrow(/FYM_AUDIT_IMMUTABLE/);
    await expect(prisma.adminAuditLog.delete({ where: { id: row!.id } })).rejects.toThrow(/FYM_AUDIT_IMMUTABLE/);
    await expect(prisma.adminAuditLog.deleteMany({})).rejects.toThrow(/FYM_AUDIT_IMMUTABLE/);
    expect(await prisma.adminAuditLog.count()).toBe(1);
  });

  it('there is no API route to create, change or delete records', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    for (const [method, path] of [['POST', `${A}/audit-log`], ['PUT', `${A}/audit-log/${id}`], ['PATCH', `${A}/audit-log/${id}`], ['DELETE', `${A}/audit-log/${id}`], ['DELETE', `${A}/audit-log`]] as const) {
      expect((await api.call(method, path, {}, admin.token)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('TRUNCATE is refused, including the TRUNCATE of "user" that would cascade into the log', async () => {
    const prisma = await prismaP();
    await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token);
    await expect(prisma.$executeRawUnsafe('TRUNCATE admin_audit_log')).rejects.toThrow(/FYM_AUDIT_IMMUTABLE/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE "user" CASCADE')).rejects.toThrow(/FYM_AUDIT_IMMUTABLE/);
    expect(await prisma.adminAuditLog.count()).toBe(1);
    expect(await prisma.user.count()).toBe(3); // nothing was emptied
  });

  it('the target can be anonymized or removed later without touching or blocking the record; the actor stays attached', async () => {
    const prisma = await prismaP();
    await api.call('POST', `${A}/venues/${venueId}/suspend`, {}, admin.token);
    await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token);
    // anonymize the target user in place (what D18 will do) and delete the venue's rows: the records keep their target ids
    await prisma.user.update({ where: { id: user.userId }, data: { status: 'DELETED', fullName: 'Deleted user', email: `deleted-${user.userId}@invalid.local` } });
    await prisma.$executeRawUnsafe(`DELETE FROM "venue_field" WHERE venue_id = '${venueId}'::uuid`);
    const rows = await records();
    expect(rows.map((r) => r.targetId).sort()).toEqual([user.userId, venueId].sort());
    // the actor cannot be hard-deleted while records reference it (accounts are anonymized, never removed)
    await expect(prisma.user.delete({ where: { id: admin.userId } })).rejects.toThrow();
    expect((await records()).every((r) => r.actorId === admin.userId)).toBe(true);
  });
});

describe('admin overrides on matches are audited', () => {
  const M = '/api/v1/matches';
  const newMatch = async (by: TestUser = owner) => (await api.call('POST', M, matchBody(), by.token)).body.match.id as string;
  const statusOf = async (id: string) => (await (await prismaP()).match.findUniqueOrThrow({ where: { id } })).status;

  /** A match that has started (IN_PROGRESS) without waiting for the sweeper. */
  async function runningMatch(by: TestUser = owner) {
    const id = await newMatch(by);
    await moveMatchTime(id, -2, -0.5);
    await api.call('GET', `${M}/${id}`, undefined, by.token); // lazy start
    expect(await statusOf(id)).toBe('IN_PROGRESS');
    return id;
  }

  async function closedUnconfirmedLongAgo(): Promise<string> {
    const id = await newMatch();
    await moveMatchTime(id, -300, -290);
    const prisma = await prismaP();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(`UPDATE "match" SET status='CLOSED_UNCONFIRMED', closed_unconfirmed_at = now() - interval '8 days' WHERE id='${id}'`);
    });
    return id;
  }

  it('an admin cancelling someone else\'s match leaves exactly one record, with reason, organizer and the request id', async () => {
    const id = await newMatch();
    const res = await api.call('POST', `${M}/${id}/cancel`, { reason: 'duplicate listing' }, admin.token);
    expect(res.status).toBe(200);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.userId,
      action: 'MATCH_CANCELLED_BY_ADMIN',
      targetType: 'MATCH',
      targetId: id,
      reason: 'duplicate listing',
      metadata: { fromStatus: 'OPEN', toStatus: 'CANCELLED', organizerId: owner.userId },
    });
    expect(rows[0]!.requestId).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it('cancelling a RUNNING match (an admin-only decision) is recorded with its previous status', async () => {
    const id = await runningMatch();
    expect((await api.call('POST', `${M}/${id}/cancel`, {}, owner.token)).status).toBe(409); // the organizer cannot
    expect(await (await prismaP()).adminAuditLog.count()).toBe(0);
    expect((await api.call('POST', `${M}/${id}/cancel`, { reason: 'abuse' }, admin.token)).status).toBe(200);
    expect(await records()).toMatchObject([{ action: 'MATCH_CANCELLED_BY_ADMIN', targetId: id, metadata: { fromStatus: 'IN_PROGRESS' } }]);
  });

  it('an admin completing a started match is recorded as a completion', async () => {
    const id = await runningMatch();
    expect((await api.call('POST', `${M}/${id}/complete`, undefined, admin.token)).status).toBe(200);
    expect(await records()).toMatchObject([{ action: 'MATCH_COMPLETED_BY_ADMIN', targetType: 'MATCH', targetId: id, metadata: { fromStatus: 'IN_PROGRESS', toStatus: 'COMPLETED', organizerId: owner.userId } }]);
  });

  it('recovering a CLOSED_UNCONFIRMED match after the 7-day window: refused for the organizer (no record), recorded for the admin', async () => {
    const id = await closedUnconfirmedLongAgo();
    const denied = await api.call('POST', `${M}/${id}/complete`, undefined, owner.token);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('RECOVERY_WINDOW_EXPIRED');
    expect(await (await prismaP()).adminAuditLog.count()).toBe(0);

    expect((await api.call('POST', `${M}/${id}/complete`, undefined, admin.token)).status).toBe(200);
    expect(await records()).toMatchObject([{ action: 'MATCH_RECOVERED_BY_ADMIN', targetId: id, metadata: { fromStatus: 'CLOSED_UNCONFIRMED', toStatus: 'COMPLETED' } }]);
  });

  it('is NOT an override, so nothing is recorded: an organizer acting, an admin acting on their OWN match, or a refused request', async () => {
    const prisma = await prismaP();
    const mine = await newMatch();
    expect((await api.call('POST', `${M}/${mine}/cancel`, {}, owner.token)).status).toBe(200); // ordinary organizer action
    const adminOwn = await newMatch(admin);
    expect((await api.call('POST', `${M}/${adminOwn}/cancel`, {}, admin.token)).status).toBe(200); // admin organizing their own match
    expect((await api.call('POST', `${M}/${mine}/cancel`, {}, admin.token)).status).toBe(409); // already cancelled: refused
    const other = await newMatch();
    expect((await api.call('POST', `${M}/${other}/cancel`, {}, user.token)).status).toBe(403); // neither organizer nor admin
    expect((await api.call('POST', `${M}/${other}/complete`, undefined, admin.token)).status).toBe(409); // not started: refused
    expect(await statusOf(other)).toBe('OPEN');
    expect(await prisma.adminAuditLog.count()).toBe(0);
  });

  it('rollback: if the cancellation or completion fails after the record was written, the record is rolled back too', async () => {
    const prisma = await prismaP();
    const open = await newMatch();
    const running = await runningMatch();
    await failWritesOn('match_event', 'INSERT', async () => {
      expect((await api.call('POST', `${M}/${open}/cancel`, { reason: 'x' }, admin.token)).status).toBe(500);
      expect((await api.call('POST', `${M}/${running}/complete`, undefined, admin.token)).status).toBe(500);
    });
    expect(await prisma.adminAuditLog.count()).toBe(0);
    expect(await statusOf(open)).toBe('OPEN');
    expect(await statusOf(running)).toBe('IN_PROGRESS');
  });

  it('rollback: if the record cannot be written, the match action is NOT applied', async () => {
    const prisma = await prismaP();
    const open = await newMatch();
    const running = await runningMatch();
    await failWritesOn('admin_audit_log', 'INSERT', async () => {
      expect((await api.call('POST', `${M}/${open}/cancel`, {}, admin.token)).status).toBe(500);
      expect((await api.call('POST', `${M}/${running}/complete`, undefined, admin.token)).status).toBe(500);
    });
    expect(await statusOf(open)).toBe('OPEN');
    expect(await statusOf(running)).toBe('IN_PROGRESS');
    expect(await prisma.adminAuditLog.count()).toBe(0);
  });
});

describe('GET /admin/audit-log', () => {
  const L = `${A}/audit-log`;

  /** Seeds a known history through the real endpoints. */
  async function seedHistory() {
    await api.call('POST', `${A}/users/${user.userId}/suspend`, { reason: 'one' }, admin.token);
    await api.call('POST', `${A}/users/${user.userId}/reactivate`, {}, admin.token);
    await api.call('POST', `${A}/venues/${venueId}/suspend`, { reason: 'two' }, admin.token);
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), owner.token)).body.match.id as string;
    await api.call('POST', `/api/v1/matches/${m}/cancel`, { reason: 'three' }, admin.token);
    return m;
  }

  it('is admin-only', async () => {
    expect((await api.call('GET', L)).status).toBe(401);
    expect((await api.call('GET', L, undefined, user.token)).status).toBe(403);
    expect((await api.call('GET', L, undefined, owner.token)).status).toBe(403);
    expect((await api.call('GET', L, undefined, admin.token)).status).toBe(200);
  });

  it('returns newest first, only the audit fields, and no personal data of the people involved', async () => {
    await seedHistory();
    const res = await api.call('GET', L, undefined, admin.token);
    expect(res.body).toMatchObject({ page: 1, pageSize: 30, total: 4 });
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual(['MATCH_CANCELLED_BY_ADMIN', 'VENUE_SUSPENDED', 'USER_REACTIVATED', 'USER_SUSPENDED']);
    expect(Object.keys(res.body.entries[0]).sort()).toEqual(['action', 'actorId', 'createdAt', 'id', 'metadata', 'reason', 'requestId', 'targetId', 'targetType']);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('@example.com');
    expect(text).not.toContain('Player ');
  });

  it('filters by actor, action, target type, target id and date range, and combines filters', async () => {
    const matchId = await seedHistory();
    const get = async (qs: string) => (await api.call('GET', `${L}?${qs}`, undefined, admin.token)).body;

    expect((await get(`actorId=${admin.userId}`)).total).toBe(4);
    expect((await get(`actorId=${user.userId}`)).total).toBe(0);
    expect((await get('action=USER_SUSPENDED')).entries).toHaveLength(1);
    expect((await get('targetType=USER')).total).toBe(2);
    expect((await get(`targetType=MATCH&targetId=${matchId}`)).total).toBe(1);
    expect((await get(`targetId=${user.userId}`)).total).toBe(2);
    expect((await get(`targetType=VENUE&targetId=${user.userId}`)).total).toBe(0); // combined: no such pair

    const all = (await get('')).entries as { createdAt: string }[];
    const newest = all[0]!.createdAt;
    const oldest = all[all.length - 1]!.createdAt;
    const after = encodeURIComponent(new Date(Date.parse(newest) + 1000).toISOString());
    const before = encodeURIComponent(new Date(Date.parse(oldest) - 1000).toISOString());
    expect((await get(`from=${after}`)).total).toBe(0);
    expect((await get(`to=${before}`)).total).toBe(0);
    expect((await get(`from=${before}&to=${after}`)).total).toBe(4);
    expect((await get(`from=${encodeURIComponent(newest)}`)).total).toBeGreaterThanOrEqual(1); // from is inclusive
    expect((await get(`to=${encodeURIComponent(newest)}`)).entries.every((e: { createdAt: string }) => e.createdAt < newest)).toBe(true); // to is exclusive
  });

  it('paginates without repeats and reports the total', async () => {
    await seedHistory();
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await api.call('GET', `${L}?pageSize=2&page=${page}`, undefined, admin.token);
      expect(res.body.total).toBe(4);
      seen.push(...res.body.entries.map((e: { id: string }) => e.id));
      expect(res.body.entries).toHaveLength(page === 3 ? 0 : 2);
    }
    expect(new Set(seen).size).toBe(4);
  });

  it('validates its input', async () => {
    for (const qs of ['actorId=nope', 'targetId=123', 'action=DROP_TABLE', 'targetType=TEAM', 'from=yesterday', 'to=2026-13-45', 'page=0', 'pageSize=101', 'pageSize=0', `from=${encodeURIComponent('2026-02-01T00:00:00Z')}&to=${encodeURIComponent('2026-01-01T00:00:00Z')}`]) {
      expect((await api.call('GET', `${L}?${qs}`, undefined, admin.token)).status, qs).toBe(400);
    }
  });

  it('reading never writes: the log has the same rows afterwards', async () => {
    await seedHistory();
    const before = await (await prismaP()).adminAuditLog.count();
    await api.call('GET', L, undefined, admin.token);
    expect(await (await prismaP()).adminAuditLog.count()).toBe(before);
  });
});

describe("an admin editing another organizer's match is audited", () => {
  const M = '/api/v1/matches';
  const newMatch = async (by: TestUser = owner) => (await api.call('POST', M, matchBody({ description: 'Private pitch, call 0599-000-000', requiredPositions: [{ position: 'GOALKEEPER', count: 1 }] }), by.token)).body.match.id as string;
  const edit = (id: string, body: Record<string, unknown>, by: TestUser) => api.call('PATCH', `${M}/${id}`, body, by.token);
  const countAudit = async () => (await prismaP()).adminAuditLog.count();

  it('success: exactly one record naming the changed fields, with before/after only for non-personal values', async () => {
    const id = await newMatch();
    const newStart = new Date(Date.now() + 96 * 3_600_000).toISOString();
    const res = await edit(id, { title: 'Totally new secret title', capacity: 8, pricePerPlayer: 15, startAt: newStart, requiredPositions: [{ position: 'DEFENDER', count: 2 }] }, admin);
    expect(res.status).toBe(200);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, action: 'MATCH_EDITED_BY_ADMIN', targetType: 'MATCH', targetId: id });
    expect(rows[0]!.requestId).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    const meta = rows[0]!.metadata as { organizerId: string; changedFields: string[]; before: Record<string, unknown>; after: Record<string, unknown> };
    expect(meta.organizerId).toBe(owner.userId);
    expect([...meta.changedFields].sort()).toEqual(['capacity', 'pricePerPlayer', 'requiredPositions', 'time', 'title']);
    expect(meta.before).toMatchObject({ capacity: 6, pricePerPlayer: null });
    expect(meta.after).toMatchObject({ capacity: 8, pricePerPlayer: 15, startAt: newStart });
    // free text, coordinates, positions and booking are named only: no value of them is stored
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain('Totally new secret title');
    expect(text).not.toContain('Evening 7v7');
    expect(text).not.toContain('0599');
    expect(Object.keys(meta.before)).not.toContain('title');
  });

  it('a text-only edit and a location edit record the field NAMES and no values at all', async () => {
    const id = await newMatch();
    expect((await edit(id, { description: 'Moved because of a complaint, contact abu-khaled', locationName: 'Al Hussein pitch', latitude: 31.5, longitude: 35.1 }, admin)).status).toBe(200);
    const [row] = await records();
    const meta = row!.metadata as { changedFields: string[]; before: object; after: object };
    expect([...meta.changedFields].sort()).toEqual(['description', 'location', 'locationName']);
    expect(meta.before).toEqual({});
    expect(meta.after).toEqual({});
    expect(JSON.stringify(row)).not.toMatch(/abu-khaled|Hussein|31\.5|35\.1/);
  });

  it('an edit that changes nothing leaves no record', async () => {
    const id = await newMatch();
    expect((await edit(id, { capacity: 6, title: 'Evening 7v7' }, admin)).status).toBe(200);
    expect(await countAudit()).toBe(0);
  });

  it('no record when it is not an override: the organizer editing, or an admin editing their OWN match', async () => {
    const mine = await newMatch();
    expect((await edit(mine, { capacity: 7 }, owner)).status).toBe(200);
    const adminOwn = await newMatch(admin);
    expect((await edit(adminOwn, { capacity: 7 }, admin)).status).toBe(200);
    expect(await countAudit()).toBe(0);
  });

  it('refusals leave no record: not the organizer, not open, invalid body', async () => {
    const id = await newMatch();
    expect((await edit(id, { capacity: 7 }, user)).status).toBe(403); // an ordinary user is still refused (rules unchanged)
    expect((await edit(id, { capacity: 0 }, admin)).status).toBe(400);
    expect((await edit(id, {}, admin)).status).toBe(400);
    expect((await edit(id, { capacity: 7, startAt: new Date(Date.now() - 3_600_000).toISOString() }, admin)).status).toBeGreaterThanOrEqual(400);
    await api.call('POST', `${M}/${id}/cancel`, {}, owner.token); // organizer cancels: not an admin action
    expect((await edit(id, { capacity: 7 }, admin)).status).toBe(409); // only open matches can be edited, also for admins
    expect(await countAudit()).toBe(0);
  });

  it('rollback: if the edit fails after the record was written, the record is rolled back with it', async () => {
    const id = await newMatch();
    await failWritesOn('match_required_position', 'INSERT', async () => {
      expect((await edit(id, { capacity: 8, requiredPositions: [{ position: 'STRIKER', count: 1 }] }, admin)).status).toBe(500);
    });
    expect(await countAudit()).toBe(0);
    const m = await (await prismaP()).match.findUniqueOrThrow({ where: { id } });
    expect(m.capacity).toBe(6);
  });

  it('rollback: if the record cannot be written, the edit is NOT applied', async () => {
    const id = await newMatch();
    await failWritesOn('admin_audit_log', 'INSERT', async () => {
      expect((await edit(id, { capacity: 8, title: 'Edited by admin' }, admin)).status).toBe(500);
    });
    const m = await (await prismaP()).match.findUniqueOrThrow({ where: { id } });
    expect(m.capacity).toBe(6);
    expect(m.title).toBe('Evening 7v7');
    expect(await countAudit()).toBe(0);
  });
});

describe('admin edit records are computed from the LOCKED match, so concurrent edits cannot give misleading before-values', () => {
  const M = '/api/v1/matches';
  const edit = (id: string, body: Record<string, unknown>, by: TestUser) => api.call('PATCH', `${M}/${id}`, body, by.token);
  type Meta = { before: { capacity?: number }; after: { capacity?: number }; changedFields: string[] };

  it('two simultaneous edits of the same field form a chain: exactly one starts from the original value, the other from its result', async () => {
    const prisma = await prismaP();
    for (let round = 0; round < 8; round++) {
      const id = (await api.call('POST', M, matchBody({ title: `Chain round number ${round}`, startAt: new Date(Date.now() + (200 + round * 4) * 3_600_000).toISOString() }), owner.token)).body.match.id as string;
      const [a, b] = await Promise.all([edit(id, { capacity: 8 }, admin), edit(id, { capacity: 9 }, admin)]);
      expect([a.status, b.status]).toEqual([200, 200]);

      const rows = (await prisma.adminAuditLog.findMany({ where: { targetId: id } })).map((r) => r.metadata as Meta);
      expect(rows).toHaveLength(2);
      const first = rows.find((r) => r.before.capacity === 6);
      const second = rows.find((r) => r !== first);
      expect(first, `round ${round}: one record must start from the original capacity 6`).toBeDefined();
      expect(second!.before.capacity, `round ${round}: the other must start from the first one's result`).toBe(first!.after.capacity);
      expect(second!.after.capacity).toBe((await prisma.match.findUniqueOrThrow({ where: { id } })).capacity); // and ends at what is stored
    }
  });

  it('an edit racing a cancellation either happens fully (with its record) or is refused (without one), never half', async () => {
    const prisma = await prismaP();
    for (let round = 0; round < 8; round++) {
      const id = (await api.call('POST', M, matchBody({ title: `Cancel race number ${round}`, startAt: new Date(Date.now() + (300 + round * 4) * 3_600_000).toISOString() }), owner.token)).body.match.id as string;
      const [e, c] = await Promise.all([edit(id, { capacity: 8 }, admin), api.call('POST', `${M}/${id}/cancel`, {}, owner.token)]);
      expect(c.status).toBe(200);
      expect([200, 409]).toContain(e.status);
      const records = await prisma.adminAuditLog.count({ where: { targetId: id, action: 'MATCH_EDITED_BY_ADMIN' } });
      const m = await prisma.match.findUniqueOrThrow({ where: { id } });
      expect(m.status).toBe('CANCELLED');
      expect(records).toBe(e.status === 200 ? 1 : 0);
      expect(m.capacity).toBe(e.status === 200 ? 8 : 6);
    }
  });
});
