import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { notify } from '../modules/notifications/notify';

/*
 * Time-driven match transitions (D5, D16). Designed to be restart-safe and multi-instance-safe:
 *  - no in-memory timers carry state: every run re-derives "what is due" from the database clock;
 *  - rows are claimed atomically (FOR UPDATE SKIP LOCKED) so two instances never double-process;
 *  - the DB state machine re-validates every transition, and handlers enforce the same rules
 *    lazily, so correctness never depends on this job having run on time.
 */

/** OPEN / FULL / SCHEDULED -> IN_PROGRESS once start_at has passed. (DB trigger expires pending requests.) */
export async function startDueMatches(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.$queryRaw<{ id: string; from_status: string }[]>`
      WITH due AS (
        SELECT id, status FROM "match"
         WHERE status IN ('OPEN', 'FULL', 'SCHEDULED') AND start_at <= now()
         FOR UPDATE SKIP LOCKED)
      UPDATE "match" m SET status = 'IN_PROGRESS'
        FROM due WHERE m.id = due.id
      RETURNING m.id, due.status::text AS from_status`;
    if (moved.length > 0) {
      await tx.matchEvent.createMany({
        data: moved.map((r) => ({ matchId: r.id, fromStatus: r.from_status as never, toStatus: 'IN_PROGRESS', reason: 'auto: start time reached' })),
      });
    }
    return moved.length;
  });
}

/** IN_PROGRESS and still unconfirmed 48h after the scheduled end -> CLOSED_UNCONFIRMED; tell the organizer. */
export async function closeUnconfirmedMatches(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const closed = await tx.$queryRaw<{ id: string; organizer_id: string; title: string }[]>`
      WITH due AS (
        SELECT id FROM "match"
         WHERE status = 'IN_PROGRESS' AND end_at + fym_unconfirmed_grace() <= now()
         FOR UPDATE SKIP LOCKED)
      UPDATE "match" m SET status = 'CLOSED_UNCONFIRMED'
        FROM due WHERE m.id = due.id
      RETURNING m.id, m.organizer_id, m.title`;
    for (const m of closed) {
      await tx.matchEvent.create({ data: { matchId: m.id, fromStatus: 'IN_PROGRESS', toStatus: 'CLOSED_UNCONFIRMED', reason: 'auto: not confirmed within 48h' } });
      await notify(tx, [m.organizer_id], 'MATCH_CLOSED_UNCONFIRMED', { matchId: m.id, title: m.title }, { type: 'match', id: m.id });
    }
    return closed.length;
  });
}

/** PENDING booking requests nobody answered within the 2h hold -> EXPIRED (slot released). The DB also expires stale holds lazily, so this is a tidy-up, not a correctness requirement. */
export async function expireStaleBookings(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; created_by_id: string; start_at: Date }[]>`
      WITH due AS (
        SELECT id FROM booking WHERE status = 'PENDING' AND hold_expires_at <= now() FOR UPDATE SKIP LOCKED)
      UPDATE booking b SET status = 'EXPIRED' FROM due WHERE b.id = due.id
      RETURNING b.id, b.created_by_id, b.start_at`;
    for (const b of rows) {
      await tx.bookingEvent.create({ data: { bookingId: b.id, fromStatus: 'PENDING', toStatus: 'EXPIRED', reason: 'auto: not answered within the hold' } });
      await notify(tx, [b.created_by_id], 'BOOKING_EXPIRED', { bookingId: b.id, startAt: b.start_at.toISOString() }, { type: 'booking', id: b.id });
    }
    return rows.length;
  });
}

/** CONFIRMED bookings whose time has passed -> COMPLETED. */
export async function completeFinishedBookings(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH due AS (SELECT id FROM booking WHERE status = 'CONFIRMED' AND end_at <= now() FOR UPDATE SKIP LOCKED)
    UPDATE booking b SET status = 'COMPLETED' FROM due WHERE b.id = due.id RETURNING b.id`;
  return rows.length;
}

/** Unanswered team challenges and team invitations past their deadline -> EXPIRED. Handlers also check lazily, so this is a tidy-up. */
export async function expireStaleTeamOffers(): Promise<number> {
  const challenges = await prisma.$queryRaw<{ id: string; challenger_team_id: string }[]>`
    WITH due AS (SELECT id FROM team_challenge WHERE status = 'PENDING' AND expires_at <= now() FOR UPDATE SKIP LOCKED)
    UPDATE team_challenge c SET status = 'EXPIRED' FROM due WHERE c.id = due.id RETURNING c.id, c.challenger_team_id`;
  for (const c of challenges) {
    const staff = await prisma.teamMember.findMany({ where: { teamId: c.challenger_team_id, role: { in: ['CAPTAIN', 'VICE_CAPTAIN'] } }, select: { userId: true } });
    await notify(prisma, staff.map((s) => s.userId), 'CHALLENGE_CANCELLED', { challengeId: c.id, expired: true }, { type: 'challenge', id: c.id });
  }
  const invites = await prisma.teamInvitation.updateMany({ where: { status: 'PENDING', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED' } });
  return challenges.length + invites.count;
}

/** Runs every sweeper once, in order; each is idempotent, so running them twice or on two instances is safe. */
export async function runLifecycleJobs(): Promise<{ started: number; closed: number; expired: number; completed: number; offers: number }> {
  const started = await startDueMatches();
  const closed = await closeUnconfirmedMatches();
  const expired = await expireStaleBookings();
  const completed = await completeFinishedBookings();
  const offers = await expireStaleTeamOffers();
  return { started, closed, expired, completed, offers };
}

/** Runs the sweepers every minute without overlapping runs; returns a function that stops the schedule (used on shutdown). */
export function scheduleLifecycleJobs(intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap with a slow previous run
    running = true;
    try {
      const r = await runLifecycleJobs();
      if (r.started || r.closed || r.expired || r.completed || r.offers) logger.info(r, 'match lifecycle job');
    } catch (err) {
      logger.error({ err }, 'match lifecycle job failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
