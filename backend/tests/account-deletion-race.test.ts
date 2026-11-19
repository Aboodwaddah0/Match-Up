import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeTeam, T, transferCaptaincy } from './helpers/teams';
import { inHours, makeUser, matchBody, PASSWORD, type TestUser } from './helpers/users';
import { localSlot, setupVenue } from './helpers/venues';

/*
 * Account deletion racing the operations that create or change the things it checks (PRIV-01), with REAL concurrent transactions.
 * "In flight" changes are held open in a second transaction (executed, not committed); "deletion first" is forced by slowing the final
 * user UPDATE of the deletion with a temporary trigger, so the deletion really holds its locks while the competitor starts.
 * Every test asserts BOTH orderings' outcomes where the ordering can be forced, and never an inconsistent mix.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let cityId: string;
let owner: TestUser;
let host: TestUser;
let u: TestUser;
let venueId: string;
let fieldId: string;

const M = '/api/v1/matches';
const B = '/api/v1/bookings';
const V = '/api/v1/venues';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const remove = (who: TestUser = u) => api.call('POST', '/api/v1/users/me/delete', { password: PASSWORD }, who.token);
const statusOf = async (who: TestUser = u) => (await (await prismaP()).user.findUniqueOrThrow({ where: { id: who.userId } })).status;
const audits = async (who: TestUser = u) => (await prismaP()).adminAuditLog.count({ where: { action: 'ACCOUNT_DELETED', targetId: who.userId } });

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
  owner = await makeUser(api, 'owner@example.com');
  host = await makeUser(api, 'host@example.com');
  u = await makeUser(api, 'deleter@example.com');
  ({ venueId, fieldId } = await setupVenue(api, owner, cityId));
});

type Tx = Prisma.TransactionClient;
/** Runs `change` in a transaction that stays OPEN until `release()`; resolves once the change has been executed (uncommitted). */
async function holdOpen(change: (tx: Tx) => Promise<unknown>) {
  const prisma = await prismaP();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const finished = prisma.$transaction(
    async (tx) => {
      await change(tx);
      entered();
      await hold;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await inside;
  return { release, finished };
}

/** A promise that tells whether it has settled yet, without changing its result. */
function watch<T2>(p: Promise<T2>) {
  const state = { settled: false };
  const wrapped = p.then((v) => ((state.settled = true), v));
  return { state, wrapped };
}

async function withTrigger(name: string, table: string, event: 'INSERT' | 'UPDATE', body: string, fn: () => Promise<void>) {
  const prisma = await prismaP();
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    await fn();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_${name} ON ${table}`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}
/** The deletion's final user UPDATE sleeps 2 s: the deletion holds all its locks for that long. */
const slowDeletion = (fn: () => Promise<void>) =>
  withTrigger('priv01_slow_delete', '"user"', 'UPDATE', `IF NEW.status = 'DELETED' AND OLD.status <> 'DELETED' THEN PERFORM pg_sleep(2); END IF;`, fn);
const slowInsert = (table: string, fn: () => Promise<void>) => withTrigger(`priv01_slow_${table}`, table, 'INSERT', 'PERFORM pg_sleep(1.2);', fn);
/** A venue status change keeps the venue row locked for 1.5 s (the lock is taken before the trigger runs). */
const slowVenueStatus = (fn: () => Promise<void>) => withTrigger('priv01_slow_venue', 'venue', 'UPDATE', `IF NEW.status <> OLD.status THEN PERFORM pg_sleep(1.5); END IF;`, fn);

const newMatch = async (by: TestUser, over: Record<string, unknown> = {}) => (await api.call('POST', M, matchBody(over), by.token)).body.match.id as string;
const bookSlot = async (by: TestUser, day: number, hour = 18) => {
  const res = await api.call('POST', B, { venueFieldId: fieldId, startAt: localSlot(day, hour).toISOString(), durationMinutes: 60 }, by.token);
  expect(res.status).toBe(201);
  return res.body.booking.id as string;
};

// ───────────────────────────── dependencies being CREATED ─────────────────────────────

describe('deletion vs a new match', () => {
  it('the match is created first (still uncommitted): the deletion waits for it, then sees it and refuses', async () => {
    const { release, finished } = await holdOpen((tx) =>
      tx.match.create({ data: { organizerId: u.userId, type: 'OPEN_MATCH', status: 'OPEN', visibility: 'PUBLIC', format: 'F7', title: 'Created during deletion', startAt: new Date(Date.now() + 80 * 3_600_000), endAt: new Date(Date.now() + 82 * 3_600_000), capacity: 4 } }),
    );
    const deleting = watch(remove());
    await sleep(600);
    expect(deleting.state.settled).toBe(false); // queued behind the creation, not racing past it with a stale view
    release();
    await finished;
    const res = await deleting.wrapped;
    expect(res.status).toBe(409);
    expect(res.body.error.details.blockers[0].code).toBe('ORGANIZES_UPCOMING_MATCHES');
    expect(await statusOf()).toBe('ACTIVE');
  });

  it('the deletion is first: a match request that was already past authentication is refused, nothing is created', async () => {
    await slowDeletion(async () => {
      const deleting = remove();
      await sleep(800);
      const creating = await api.call('POST', M, matchBody({ title: 'Too late match' }), u.token); // authenticated while the account was still ACTIVE
      expect((await deleting).status).toBe(204);
      expect(creating.status).toBe(409);
      expect(creating.body.error.code).toBe('ACCOUNT_DELETED');
    });
    expect(await (await prismaP()).match.count({ where: { organizerId: u.userId } })).toBe(0);
  });
});

describe('deletion vs match cancellation', () => {
  it('a cancellation still in flight does not let the deletion through, and the deletion works once it has committed', async () => {
    const matchId = await newMatch(u);
    const { release, finished } = await holdOpen((tx) => tx.match.update({ where: { id: matchId }, data: { status: 'CANCELLED', cancelledById: u.userId } }));
    const early = await remove(); // sees the match as still upcoming: refused straight away
    expect(early.status).toBe(409);
    expect(early.body.error.details.blockers[0].resourceIds).toEqual([matchId]);
    release();
    await finished;
    expect((await remove()).status).toBe(204);
    expect((await (await prismaP()).match.findUniqueOrThrow({ where: { id: matchId } })).status).toBe('CANCELLED'); // history kept
  });
});

describe('deletion vs bookings of the deleting user', () => {
  it('a booking request made at the same time (uncommitted): the deletion waits for it, then cancels it like any other own future booking', async () => {
    const { release, finished } = await holdOpen((tx) =>
      tx.booking.create({ data: { source: 'IN_APP', status: 'PENDING', createdById: u.userId, venueFieldId: fieldId, startAt: localSlot(5, 18), endAt: localSlot(5, 19), totalPrice: 100 } }),
    );
    const deleting = watch(remove());
    await sleep(600);
    expect(deleting.state.settled).toBe(false);
    release();
    await finished;
    expect((await deleting.wrapped).status).toBe(204);
    const prisma = await prismaP();
    const booking = await prisma.booking.findFirstOrThrow({ where: { createdById: u.userId } });
    expect(booking.status).toBe('CANCELLED');
    expect(await prisma.bookingEvent.count({ where: { bookingId: booking.id, toStatus: 'CANCELLED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: booking.id, userId: owner.userId } })).toBe(1);
  });

  it('the deletion is first: a booking request that was already past authentication is refused', async () => {
    await slowDeletion(async () => {
      const deleting = remove();
      await sleep(800);
      const booking = await api.call('POST', B, { venueFieldId: fieldId, startAt: localSlot(6, 18).toISOString(), durationMinutes: 60 }, u.token);
      expect((await deleting).status).toBe(204);
      expect(booking.status).toBe(409);
      expect(booking.body.error.code).toBe('ACCOUNT_DELETED');
    });
    expect(await (await prismaP()).booking.count({ where: { createdById: u.userId } })).toBe(0);
  });

  it('the venue cancels the booking at the same time: one cancellation, one event, one notification', async () => {
    const id = await bookSlot(u, 5);
    expect((await api.call('POST', `${B}/${id}/confirm`, {}, owner.token)).status).toBe(200);
    const { release, finished } = await holdOpen(async (tx) => {
      await tx.booking.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: owner.userId, cancelReason: 'closed' } });
      await tx.bookingEvent.create({ data: { bookingId: id, actorId: owner.userId, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', reason: 'closed' } });
    });
    const deleting = watch(remove());
    await sleep(600);
    expect(deleting.state.settled).toBe(false); // waits for the booking row, as BOOK-01 / BOOK-02 require
    release();
    await finished;
    expect((await deleting.wrapped).status).toBe(204);
    const prisma = await prismaP();
    expect(await prisma.bookingEvent.count({ where: { bookingId: id, toStatus: 'CANCELLED' } })).toBe(1); // not a second transition
    expect(await prisma.notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: id } })).toBe(0); // and no duplicate notification
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ACCOUNT_DELETED', targetId: u.userId } })).metadata).toMatchObject({ cancelledBookings: 0 });
  });

  it('the venue confirms the pending request at the same time: it is confirmed first, then cancelled by the deletion, once', async () => {
    const id = await bookSlot(u, 5);
    const { release, finished } = await holdOpen(async (tx) => {
      await tx.booking.update({ where: { id }, data: { status: 'CONFIRMED', decidedById: owner.userId } });
      await tx.bookingEvent.create({ data: { bookingId: id, actorId: owner.userId, fromStatus: 'PENDING', toStatus: 'CONFIRMED' } });
    });
    const deleting = watch(remove());
    await sleep(600);
    expect(deleting.state.settled).toBe(false);
    release();
    await finished;
    expect((await deleting.wrapped).status).toBe(204);
    const prisma = await prismaP();
    expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
    expect(await prisma.bookingEvent.count({ where: { bookingId: id, toStatus: 'CANCELLED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: id, userId: owner.userId } })).toBe(1);
  });
});

describe('deletion vs a join request', () => {
  it('the organizer accepts first (slowed): the deletion waits for the request row; the player stays confirmed in the match, nothing is withdrawn', async () => {
    const matchId = await newMatch(host, { startAt: inHours(80) });
    const requestId = (await api.call('POST', `${M}/${matchId}/requests`, {}, u.token)).body.request.id as string;
    await slowInsert('match_participant', async () => {
      const accepting = api.call('POST', `${M}/${matchId}/requests/${requestId}/accept`, {}, host.token);
      await sleep(400);
      const deleting = remove();
      const [accepted, deleted] = await Promise.all([accepting, deleting]);
      expect(accepted.status).toBe(200);
      expect(deleted.status).toBe(204);
    });
    const prisma = await prismaP();
    expect((await prisma.matchRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('ACCEPTED');
    expect((await prisma.matchParticipant.findFirstOrThrow({ where: { matchId, userId: u.userId } })).status).toBe('CONFIRMED');
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ACCOUNT_DELETED' } })).metadata).toMatchObject({ withdrawnRequests: 0 });
  });

  it('the deletion is first (slowed): the request is withdrawn and a late acceptance is refused, so nobody deleted joins the match', async () => {
    const matchId = await newMatch(host, { startAt: inHours(80) });
    const requestId = (await api.call('POST', `${M}/${matchId}/requests`, {}, u.token)).body.request.id as string;
    await slowDeletion(async () => {
      const deleting = remove();
      await sleep(800);
      const accepted = await api.call('POST', `${M}/${matchId}/requests/${requestId}/accept`, {}, host.token);
      expect((await deleting).status).toBe(204);
      expect(accepted.status).toBe(409);
    });
    const prisma = await prismaP();
    expect((await prisma.matchRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('WITHDRAWN');
    expect(await prisma.matchParticipant.count({ where: { matchId, userId: u.userId } })).toBe(0);
  });
});

describe('deletion vs team changes', () => {
  async function invitationFor(user: TestUser) {
    const captain = await makeUser(api, `team-captain-${Math.random().toString(36).slice(2, 8)}@example.com`);
    const teamId = (await api.call('POST', T, { name: 'Racing team' }, captain.token)).body.team.id as string;
    const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: user.userId }, captain.token);
    expect(inv.status).toBe(201);
    return { teamId, invitationId: inv.body.invitation.id as string };
  }

  it('the player accepts a team invitation first (slowed): the deletion waits for the invitation, then refuses because they are a member now', async () => {
    const { teamId, invitationId } = await invitationFor(u);
    await slowInsert('team_member', async () => {
      const accepting = api.call('POST', `${T}/invitations/${invitationId}/accept`, {}, u.token);
      await sleep(400);
      const deleting = remove();
      const [accepted, deleted] = await Promise.all([accepting, deleting]);
      expect(accepted.status).toBe(200);
      expect(deleted.status).toBe(409);
      expect(deleted.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual(['TEAM_MEMBERSHIP']);
    });
    expect(await statusOf()).toBe('ACTIVE');
    expect(await (await prismaP()).teamMember.count({ where: { teamId, userId: u.userId } })).toBe(1);
  });

  it('the deletion is first (slowed): the invitation is expired, a late acceptance is refused, nobody deleted joins the team', async () => {
    const { teamId, invitationId } = await invitationFor(u);
    await slowDeletion(async () => {
      const deleting = remove();
      await sleep(800);
      const accepted = await api.call('POST', `${T}/invitations/${invitationId}/accept`, {}, u.token);
      expect((await deleting).status).toBe(204);
      expect(accepted.status).toBeGreaterThanOrEqual(400);
      expect(accepted.status).toBeLessThan(500);
    });
    const prisma = await prismaP();
    expect((await prisma.teamInvitation.findUniqueOrThrow({ where: { id: invitationId } })).status).toBe('EXPIRED');
    expect(await prisma.teamMember.count({ where: { teamId, userId: u.userId } })).toBe(0);
  });

  it('a captaincy transfer to the deleting member racing the deletion: the deletion is refused either way, the account stays ACTIVE, no deleted captain with members', async () => {
    const A = await makeTeam(api, 'a');
    const member = A.members[3]!;
    for (let round = 0; round < 2; round++) {
      const [transferred, deleted] = await Promise.all([transferCaptaincy(api, A, round === 0 ? A.captain : member, round === 0 ? member : A.captain), remove(member)]);
      expect([200, 409]).toContain(transferred.status);
      expect(deleted.status).toBe(409);
      expect(deleted.body.error.code).toBe('ACCOUNT_DELETION_BLOCKED');
      expect(await statusOf(member)).toBe('ACTIVE');
    }
  });
});

describe('deletion vs venue changes', () => {
  it('the owner adds the player as staff first (uncommitted): the deletion waits, then removes the role', async () => {
    const { release, finished } = await holdOpen((tx) => tx.venueStaff.create({ data: { venueId, userId: u.userId, role: 'STAFF', permissions: ['MANAGE_BOOKINGS'] } }));
    const deleting = watch(remove());
    await sleep(600);
    expect(deleting.state.settled).toBe(false);
    release();
    await finished;
    expect((await deleting.wrapped).status).toBe(204);
    const prisma = await prismaP();
    expect(await prisma.venueStaff.count({ where: { userId: u.userId } })).toBe(0);
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ACCOUNT_DELETED' } })).metadata).toMatchObject({ removedStaffRoles: 1 });
  });

  it('the deletion is first (slowed): adding the player as staff is refused, no role is created for a deleted account', async () => {
    await slowDeletion(async () => {
      const deleting = remove();
      await sleep(800);
      const adding = await api.call('POST', `${V}/${venueId}/staff`, { userId: u.userId, role: 'STAFF' }, owner.token);
      expect((await deleting).status).toBe(204);
      expect(adding.status).toBe(409);
      expect(adding.body.error.code).toBe('ACCOUNT_DELETED');
    });
    expect(await (await prismaP()).venueStaff.count({ where: { userId: u.userId } })).toBe(0);
  });

  it('a booking request racing the owner deactivating the venue: either it is in first (and the owner then has a pending booking to resolve before deleting) or it is refused; never a booking on a venue that is not active', async () => {
    const prisma = await prismaP();
    const player = await makeUser(api, 'booker@example.com');
    const { release, finished } = await holdOpen((tx) =>
      tx.booking.create({ data: { source: 'IN_APP', status: 'PENDING', createdById: player.userId, venueFieldId: fieldId, startAt: localSlot(5, 18), endAt: localSlot(5, 19), totalPrice: 100 } }),
    );
    const deactivating = watch(api.call('PATCH', `${V}/${venueId}`, { status: 'INACTIVE' }, owner.token));
    await sleep(600);
    expect(deactivating.state.settled).toBe(false); // the venue change waits for the booking that is being inserted
    release();
    await finished;
    expect((await deactivating.wrapped).status).toBe(200);
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).status).toBe('INACTIVE');
    const blockers = (await api.call('GET', '/api/v1/users/me/deletion-blockers', undefined, owner.token)).body.blockers.map((b: { code: string }) => b.code);
    expect(blockers).toEqual(['VENUE_FUTURE_PENDING_BOOKINGS']); // the owner must reject it first: the deletion check saw it
  });
});

// ───────────────────────────── everything at once ─────────────────────────────

describe('every interleaving ends consistent and deadlock-free', () => {
  it('deletion, the venue cancelling the booking, the host accepting the request and the owner removing the staff role, fired together (several rounds)', async () => {
    const prisma = await prismaP();
    for (let round = 0; round < 4; round++) {
      const who = await makeUser(api, `storm${round}@example.com`);
      const matchId = await newMatch(host, { title: `Storm game ${round}`, startAt: inHours(100 + round * 5) });
      const requestId = (await api.call('POST', `${M}/${matchId}/requests`, {}, who.token)).body.request.id as string;
      const bookingId = await bookSlot(who, 10 + round);
      expect((await api.call('POST', `${B}/${bookingId}/confirm`, {}, owner.token)).status).toBe(200);
      expect((await api.call('POST', `${V}/${venueId}/staff`, { userId: who.userId, role: 'STAFF' }, owner.token)).status).toBe(201);

      const results = await Promise.all([
        remove(who),
        api.call('POST', `${B}/${bookingId}/cancel`, { reason: 'storm' }, owner.token),
        api.call('POST', `${M}/${matchId}/requests/${requestId}/accept`, {}, host.token),
        api.call('DELETE', `${V}/${venueId}/staff/${who.userId}`, undefined, owner.token),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.body)).not.toBe(500);
      expect([204, 409]).toContain(results[0].status);

      // consistent end state
      const deleted = (await statusOf(who)) === 'DELETED';
      expect(await audits(who)).toBe(deleted ? 1 : 0);
      const request = await prisma.matchRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(['ACCEPTED', 'WITHDRAWN']).toContain(request.status); // decided exactly one way
      expect(await prisma.bookingEvent.count({ where: { bookingId, toStatus: 'CANCELLED' } })).toBe(1); // one cancellation however it happened
      // told once at most: the venue's cancellation tells the player (whose notifications the deletion then erases), the deletion's tells the venue
      expect(await prisma.notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: bookingId } })).toBeLessThanOrEqual(1);
      expect(await prisma.venueStaff.count({ where: { userId: who.userId } })).toBe(0);
      if (deleted) {
        expect(await prisma.notification.count({ where: { userId: who.userId } })).toBe(0);
        expect(await prisma.matchRequest.count({ where: { userId: who.userId, status: 'PENDING' } })).toBe(0);
        expect(await prisma.booking.count({ where: { createdById: who.userId, status: { in: ['PENDING', 'CONFIRMED'] } } })).toBe(0);
      }
    }
  });
});

// ───────────────────────────── venues: blocks and reactivation (PRIV-01 review) ─────────────────────────────

describe('deletion vs a VenueBlock or a reactivation of an owned venue', () => {
  let staff: TestUser;
  let admin: TestUser;
  const blockBody = (day: number) => ({ startAt: localSlot(day, 10).toISOString(), endAt: localSlot(day, 11).toISOString(), reason: 'OFFLINE_BOOKING' });
  const createBlockAs = (who: TestUser, day: number) => api.call('POST', `/api/v1/fields/${fieldId}/blocks`, blockBody(day), who.token);
  const deactivate = async () => expect((await api.call('PATCH', `${V}/${venueId}`, { status: 'INACTIVE' }, owner.token)).status).toBe(200);
  const venueStatus = async () => (await (await prismaP()).venue.findUniqueOrThrow({ where: { id: venueId } })).status;
  const codesOf = (res: { body: { error?: { details?: { blockers?: { code: string }[] } } } }) => (res.body.error?.details?.blockers ?? []).map((b) => b.code);

  beforeEach(async () => {
    staff = await makeUser(api, 'staff@example.com');
    admin = await makeUser(api, 'admin@example.com');
    await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    expect((await api.call('POST', `${V}/${venueId}/staff`, { userId: staff.userId, role: 'STAFF' }, owner.token)).status).toBe(201);
  });

  const insertBlock = (tx: Tx, createdById: string) =>
    tx.venueBlock.create({ data: { venueFieldId: fieldId, startAt: localSlot(9, 10), endAt: localSlot(9, 11), reason: 'OFFLINE_BOOKING', createdById } });

  it('a block created by STAFF is in flight (uncommitted): the deletion waits for the venue, then sees the block and refuses', async () => {
    await deactivate();
    const { release, finished } = await holdOpen((tx) => insertBlock(tx, staff.userId));
    const deleting = watch(remove(owner));
    await sleep(600);
    expect(deleting.state.settled).toBe(false); // queued on the venue row, not racing past with a stale view
    release();
    await finished;
    const res = await deleting.wrapped;
    expect(res.status).toBe(409);
    expect(codesOf(res)).toEqual(['VENUE_FUTURE_BLOCKS']);
    expect(await statusOf(owner)).toBe('ACTIVE');
  });

  it('a block created by the OWNER (second session) is in flight: the deletion waits for it and refuses', async () => {
    await deactivate();
    const { release, finished } = await holdOpen((tx) => insertBlock(tx, owner.userId));
    const deleting = watch(remove(owner));
    await sleep(600);
    expect(deleting.state.settled).toBe(false);
    release();
    await finished;
    const res = await deleting.wrapped;
    expect(res.status).toBe(409);
    expect(codesOf(res)).toEqual(['VENUE_FUTURE_BLOCKS']);
  });

  it("the deletion is first: the deleted owner's own session cannot create a block (409 ACCOUNT_DELETED, nothing created)", async () => {
    await deactivate();
    await slowDeletion(async () => {
      const deleting = remove(owner);
      await sleep(800);
      const creating = await createBlockAs(owner, 12); // authenticated while the account was still ACTIVE
      expect((await deleting).status).toBe(204);
      expect(creating.status).toBe(409);
      expect(creating.body.error.code).toBe('ACCOUNT_DELETED');
    });
    expect(await (await prismaP()).venueBlock.count()).toBe(0);
  });

  it('the deletion is first: a block by STAFF waits and then succeeds, and an admin can create one afterwards too (managing the venue of a deleted owner stays possible)', async () => {
    await deactivate();
    await slowDeletion(async () => {
      const deleting = remove(owner);
      await sleep(800);
      const creating = watch(createBlockAs(staff, 12));
      await sleep(300);
      expect(creating.state.settled).toBe(false); // waits for the deletion's lock on the venue
      expect((await deleting).status).toBe(204);
      expect((await creating.wrapped).status).toBe(201);
    });
    expect((await createBlockAs(admin, 13)).status).toBe(201);
    expect((await createBlockAs(staff, 14)).status).toBe(201);
    expect(await (await prismaP()).venueBlock.count()).toBe(3);
  });

  it('owner reactivation first (slowed): the deletion waits for the venue and refuses because it is ACTIVE again', async () => {
    await deactivate();
    await slowVenueStatus(async () => {
      const reactivating = api.call('PATCH', `${V}/${venueId}`, { status: 'ACTIVE' }, owner.token);
      await sleep(400);
      const deleting = remove(owner);
      const [reactivated, deleted] = await Promise.all([reactivating, deleting]);
      expect(reactivated.status).toBe(200);
      expect(deleted.status).toBe(409);
      expect(codesOf(deleted)).toEqual(['OWNS_ACTIVE_VENUES']);
    });
    expect(await statusOf(owner)).toBe('ACTIVE');
    expect(await venueStatus()).toBe('ACTIVE');
  });

  it("deletion first: the owner's own late reactivation is refused, the venue stays deactivated", async () => {
    await deactivate();
    await slowDeletion(async () => {
      const deleting = remove(owner);
      await sleep(800);
      const reactivating = await api.call('PATCH', `${V}/${venueId}`, { status: 'ACTIVE' }, owner.token);
      expect((await deleting).status).toBe(204);
      expect(reactivating.status).toBe(409);
      expect(reactivating.body.error.code).toBe('ACCOUNT_DELETED');
    });
    expect(await venueStatus()).toBe('INACTIVE');
  });

  it('admin reactivation first (slowed): the deletion waits and refuses; deletion first: the admin reactivation then goes through (an admin keeps managing the venue)', async () => {
    await deactivate();
    await slowVenueStatus(async () => {
      const reactivating = api.call('POST', `/api/v1/admin/venues/${venueId}/reactivate`, undefined, admin.token);
      await sleep(400);
      const deleting = remove(owner);
      const [reactivated, deleted] = await Promise.all([reactivating, deleting]);
      expect(reactivated.status).toBe(204);
      expect(deleted.status).toBe(409);
      expect(codesOf(deleted)).toEqual(['OWNS_ACTIVE_VENUES']);
    });
    expect(await venueStatus()).toBe('ACTIVE');
    await deactivate(); // the owner resolves it again

    await slowDeletion(async () => {
      const deleting = remove(owner);
      await sleep(800);
      const reactivating = await api.call('POST', `/api/v1/admin/venues/${venueId}/reactivate`, undefined, admin.token);
      expect((await deleting).status).toBe(204);
      expect(reactivating.status).toBe(204);
    });
    expect(await venueStatus()).toBe('ACTIVE'); // reactivated by the admin after the owner's account was deleted
    expect(await statusOf(owner)).toBe('DELETED');
  });

  it('block creation racing the owner deactivating the venue, in both orderings: both succeed, no deadlock', async () => {
    // block first (uncommitted): the deactivation waits for it
    const first = await holdOpen((tx) => insertBlock(tx, staff.userId));
    const deactivating = watch(api.call('PATCH', `${V}/${venueId}`, { status: 'INACTIVE' }, owner.token));
    await sleep(600);
    expect(deactivating.state.settled).toBe(false);
    first.release();
    await first.finished;
    expect((await deactivating.wrapped).status).toBe(200);
    expect(await venueStatus()).toBe('INACTIVE');
    expect(await (await prismaP()).venueBlock.count()).toBe(1);

    // deactivation first (slowed): a block created meanwhile waits for it, then succeeds
    expect((await api.call('PATCH', `${V}/${venueId}`, { status: 'ACTIVE' }, owner.token)).status).toBe(200);
    await slowVenueStatus(async () => {
      const deact = api.call('PATCH', `${V}/${venueId}`, { status: 'INACTIVE' }, owner.token);
      await sleep(400);
      const creating = watch(createBlockAs(staff, 15));
      await sleep(300);
      expect(creating.state.settled).toBe(false);
      expect((await deact).status).toBe(200);
      expect((await creating.wrapped).status).toBe(201);
    });
    expect(await venueStatus()).toBe('INACTIVE');
    expect(await (await prismaP()).venueBlock.count()).toBe(2);
  });
});
