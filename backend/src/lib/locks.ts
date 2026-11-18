import type { MatchStatus, Prisma } from '@prisma/client';
import { AppError } from './errors';

/**
 * Locks a match row (FOR NO KEY UPDATE) and returns its current status, as the FIRST statement of a transaction.
 *
 * WHY: several transactions touch a match AND rows that hang off it (requests, participants):
 *  - cancel / start / complete update the match row first; a database trigger then updates its requests and participants;
 *  - accept / leave / remove update a request or participant row first; a trigger then locks the match row.
 * Two transactions taking those locks in opposite orders deadlock (measured: 15 of 40 cancel-vs-accept races lost the
 * deadlock). If EVERY transaction starts by locking the match row, they queue up in one order and cannot deadlock.
 * Always take this lock before touching requests or participants of that match. When several matches are involved, lock
 * them in ascending id order.
 */
export async function lockMatch(tx: Prisma.TransactionClient, matchId: string): Promise<MatchStatus> {
  const rows = await tx.$queryRaw<{ status: MatchStatus }[]>`SELECT status::text AS status FROM "match" WHERE id = ${matchId}::uuid FOR NO KEY UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
  return rows[0]!.status;
}

/**
 * Locks a venue row (FOR NO KEY UPDATE), as the first statement of an administrator's venue change that is audited (AUD-07).
 * WHY: the audit record must describe a real change ("was X, now Y"), so the before-state is read under this lock; two simultaneous
 * identical changes then queue up and only the first one finds something to change. Parent row first, like lockMatch. Foreign-key
 * checks of children (fields, staff, images) take a weaker lock that does not conflict, so nothing else waits on it needlessly.
 */
export async function lockVenue(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM venue WHERE id = ${venueId}::uuid FOR NO KEY UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'VENUE_NOT_FOUND', 'Venue not found');
}
