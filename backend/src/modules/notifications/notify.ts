import type { Prisma, PrismaClient } from '@prisma/client';

type Db = Prisma.TransactionClient | PrismaClient;

export type NotificationType =
  | 'MATCH_REQUEST_RECEIVED'
  | 'MATCH_REQUEST_ACCEPTED'
  | 'MATCH_REQUEST_REJECTED'
  | 'MATCH_CANCELLED'
  | 'MATCH_PLAYER_LEFT'
  | 'MATCH_REMOVED'
  | 'MATCH_TIME_CHANGED'
  | 'MATCH_INVITATION'
  | 'MATCH_CLOSED_UNCONFIRMED'
  | 'MATCH_VENUE_UNCONFIRMED'
  | 'BOOKING_REQUEST_RECEIVED'
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_REJECTED'
  | 'BOOKING_CANCELLED'
  | 'BOOKING_EXPIRED'
  | 'TEAM_INVITATION'
  | 'TEAM_INVITATION_ACCEPTED'
  | 'TEAM_INVITATION_DECLINED'
  | 'TEAM_MEMBER_REMOVED'
  | 'TEAM_MEMBER_LEFT'
  | 'TEAM_CAPTAIN_TRANSFERRED'
  | 'TEAM_ROSTER_ADDED'
  | 'TEAM_ROSTER_REMOVED'
  | 'CHALLENGE_RECEIVED'
  | 'CHALLENGE_ACCEPTED'
  | 'CHALLENGE_REJECTED'
  | 'CHALLENGE_CANCELLED'
  | 'REVIEW_RECEIVED'
  | 'REPORT_RESOLVED';

/**
 * Transactional outbox: call this with the SAME transaction client as the state change, so a
 * notification exists if and only if the change committed. `params` is data, not text: the
 * client renders it in the user's language. (Listing / push delivery comes with the notifications module.)
 */
export async function notify(
  db: Db,
  userIds: string[],
  type: NotificationType,
  params: Record<string, unknown>,
  resource?: { type: string; id: string },
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db.notification.createMany({
    data: unique.map((userId) => ({
      userId,
      type,
      params: params as Prisma.InputJsonValue,
      resourceType: resource?.type,
      resourceId: resource?.id,
    })),
  });
}
