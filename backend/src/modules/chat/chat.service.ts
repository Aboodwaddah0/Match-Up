import { Prisma, type Conversation } from '@prisma/client';
import type { z } from 'zod';
import { areBlocked } from '../../lib/blocks';
import { AppError } from '../../lib/errors';
import { emitToUsers } from '../../lib/realtime';
import { prisma } from '../../lib/prisma';
import type { Actor } from '../../types/actor';
import type { listChatsSchema, listMessagesSchema } from './chat.schemas';


/*
 * Chat. Membership is DERIVED live from the source of truth, so it can never drift:
 *   MATCH  = the organizer + CONFIRMED participants (leave / removal revokes access immediately)
 *   TEAM   = current team members
 *   DIRECT = the two participant rows (created only between people who share a match or a team)
 * Conversations are created lazily on first use. Messages are immutable (no edit / delete in the MVP).
 * A blocked pair loses their DM, and in group chats each side stops seeing the other's messages.
 */

const RATE_LIMIT_PER_MINUTE = 20;
const READ_ONLY_AFTER_MATCH_DAYS = 7;
const DAY = 86_400_000;
const userSummary = { select: { id: true, fullName: true, avatarUrl: true } } as const;

/** userIds that currently belong to the conversation. */
async function memberIds(c: Conversation): Promise<string[]> {
  if (c.type === 'MATCH') {
    const m = await prisma.match.findUnique({
      where: { id: c.matchId! },
      select: { organizerId: true, participants: { where: { status: 'CONFIRMED' }, select: { userId: true } } },
    });
    return m ? [m.organizerId, ...m.participants.map((p) => p.userId)] : [];
  }
  if (c.type === 'TEAM') {
    return (await prisma.teamMember.findMany({ where: { teamId: c.teamId! }, select: { userId: true } })).map((t) => t.userId);
  }
  return (await prisma.conversationParticipant.findMany({ where: { conversationId: c.id }, select: { userId: true } })).map((p) => p.userId);
}

interface Access {
  conversation: Conversation;
  members: string[];
  canWrite: boolean;
}

/** Throws 404 (not 403) for non-members so conversation ids reveal nothing. */
async function loadAccess(conversationId: string, userId: string): Promise<Access> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  const notFound = new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  if (!conversation) throw notFound;
  const members = await memberIds(conversation);
  if (!members.includes(userId)) throw notFound;

  let canWrite = true;
  if (conversation.type === 'DIRECT') {
    const other = members.find((m) => m !== userId);
    if (other && (await areBlocked(userId, other))) throw notFound;
  } else if (conversation.type === 'MATCH') {
    const m = await prisma.match.findUniqueOrThrow({ where: { id: conversation.matchId! }, select: { status: true, endAt: true } });
    canWrite = m.status !== 'CANCELLED' && Date.now() < m.endAt.getTime() + READ_ONLY_AFTER_MATCH_DAYS * DAY;
  }
  return { conversation, members, canWrite };
}

// ───────────────────────── opening a conversation ─────────────────────────

export async function openMatchChat(actor: Actor, matchId: string) {
  // Authorize first: a caller who is not in the match (the organizer or a CONFIRMED player, the same rule as memberIds) must not cause any write.
  // Same 404 for an unknown match and for a stranger, so it reveals nothing. A cancelled or finished match is still opened (read-only history).
  const isMember = await prisma.match.count({
    where: { id: matchId, OR: [{ organizerId: actor.userId }, { participants: { some: { userId: actor.userId, status: 'CONFIRMED' } } }] },
  });
  if (!isMember) throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  // INSERT ... ON CONFLICT DO NOTHING then read: race-safe (a Prisma upsert with an empty update is not atomic and can fail with a unique
  // violation when two members open the chat for the first time at once).
  await prisma.conversation.createMany({ data: [{ type: 'MATCH', matchId }], skipDuplicates: true });
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { matchId }, select: { id: true } });
  return { conversationId: conv.id };
}

/** Get-or-create the team chat. Only current members get an id (404 otherwise). `upsert` on the unique team id makes it race-safe. */
export async function openTeamChat(actor: Actor, teamId: string) {
  const isMember = await prisma.teamMember.count({ where: { teamId, userId: actor.userId } });
  if (!isMember) throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  const conv = await prisma.conversation.upsert({ where: { teamId }, create: { type: 'TEAM', teamId }, update: {} });
  return { conversationId: conv.id };
}

/** Direct messages exist only between people who already share a match (organizer / confirmed player) or a team. */
async function shareContext(a: string, b: string): Promise<boolean> {
  const inMatch = (u: string): Prisma.MatchWhereInput => ({ OR: [{ organizerId: u }, { participants: { some: { userId: u, status: 'CONFIRMED' } } }] });
  const [matches, teams] = await Promise.all([
    prisma.match.count({ where: { AND: [inMatch(a), inMatch(b)] } }),
    prisma.team.count({ where: { AND: [{ members: { some: { userId: a } } }, { members: { some: { userId: b } } }] } }),
  ]);
  return matches + teams > 0;
}

/**
 * Get-or-create the direct chat between the caller and another user. An existing DM is always reachable (unless blocked);
 * a NEW one needs a shared match or team, to prevent unsolicited messages from strangers. Creation takes an advisory
 * lock on the sorted user pair, so two people starting a chat at the same moment end up in ONE conversation.
 */
export async function openDirectChat(actor: Actor, otherId: string) {
  if (otherId === actor.userId) throw new AppError(400, 'INVALID_TARGET', 'You cannot message yourself');
  const other = await prisma.user.findUnique({ where: { id: otherId }, select: { status: true } });
  if (!other || other.status !== 'ACTIVE' || (await areBlocked(actor.userId, otherId))) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

  const existing = await prisma.conversation.findFirst({
    where: { type: 'DIRECT', AND: [{ participants: { some: { userId: actor.userId } } }, { participants: { some: { userId: otherId } } }] },
    select: { id: true },
  });
  if (existing) return { conversationId: existing.id };
  if (!(await shareContext(actor.userId, otherId))) {
    throw new AppError(403, 'NO_SHARED_CONTEXT', 'You can message players you share a match or a team with');
  }

  const [a, b] = [actor.userId, otherId].sort() as [string, string];
  const id = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${a + b}))`; // two simultaneous first messages -> one conversation
    const again = await tx.conversation.findFirst({
      where: { type: 'DIRECT', AND: [{ participants: { some: { userId: a } } }, { participants: { some: { userId: b } } }] },
      select: { id: true },
    });
    if (again) return again.id;
    const c = await tx.conversation.create({ data: { type: 'DIRECT', participants: { create: [{ userId: a }, { userId: b }] } } });
    return c.id;
  });
  return { conversationId: id };
}

// ───────────────────────── messages ─────────────────────────

export async function sendMessage(actor: Actor, conversationId: string, body: string) {
  const { conversation, members, canWrite } = await loadAccess(conversationId, actor.userId);
  if (!canWrite) throw new AppError(403, 'CHAT_READ_ONLY', 'This chat is read-only');

  const recent = await prisma.message.count({ where: { senderId: actor.userId, createdAt: { gt: new Date(Date.now() - 60_000) } } });
  if (recent >= RATE_LIMIT_PER_MINUTE) throw new AppError(429, 'TOO_MANY_MESSAGES', 'You are sending messages too fast');

  const message = await prisma.$transaction(async (tx) => {
    const m = await tx.message.create({ data: { conversationId, senderId: actor.userId, body } });
    // Your own message counts as read up to now.
    await tx.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId: actor.userId } },
      create: { conversationId, userId: actor.userId, lastReadAt: m.createdAt },
      update: { lastReadAt: m.createdAt },
    });
    return m;
  });

  const dto = { id: message.id, conversationId, senderId: actor.userId, body: message.body, createdAt: message.createdAt };
  // Best-effort realtime; never to people who have a block with the sender.
  const blocks = await prisma.blockedUser.findMany({ where: { OR: [{ blockerId: actor.userId }, { blockedId: actor.userId }] } });
  const hidden = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]));
  emitToUsers(members.filter((u) => u !== actor.userId && !hidden.has(u)), 'message:new', { ...dto, conversationType: conversation.type });
  return { message: dto };
}

/** Message history, newest first, paged with a message-id cursor (`before`). Messages from users with a block are hidden. */
export async function listMessages(actor: Actor, conversationId: string, q: z.infer<typeof listMessagesSchema>) {
  const { canWrite } = await loadAccess(conversationId, actor.userId);
  const blocks = await prisma.blockedUser.findMany({ where: { OR: [{ blockerId: actor.userId }, { blockedId: actor.userId }] } });
  const hidden = [...new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]))].filter((u) => u !== actor.userId);

  let cursor: Date | undefined;
  if (q.before) {
    const ref = await prisma.message.findFirst({ where: { id: q.before, conversationId }, select: { createdAt: true } });
    if (!ref) throw new AppError(400, 'INVALID_CURSOR', 'Unknown message to page before');
    cursor = ref.createdAt;
  }
  const rows = await prisma.message.findMany({
    where: { conversationId, senderId: { notIn: hidden }, ...(cursor ? { createdAt: { lt: cursor } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    include: { sender: userSummary },
  });
  const page = rows.slice(0, q.limit);
  return {
    canWrite,
    messages: page.map((m) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt })), // newest first
    nextBefore: rows.length > q.limit ? page[page.length - 1]!.id : null,
  };
}

/** Marks the conversation read for the caller (drives unread counts). */
export async function markRead(actor: Actor, conversationId: string): Promise<void> {
  await loadAccess(conversationId, actor.userId);
  const now = new Date();
  await prisma.conversationParticipant.upsert({
    where: { conversationId_userId: { conversationId, userId: actor.userId } },
    create: { conversationId, userId: actor.userId, lastReadAt: now },
    update: { lastReadAt: now },
  });
}

/** For reports: can this user see this message? */
export async function canSeeMessage(userId: string, messageId: string): Promise<boolean> {
  const m = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
  if (!m) return false;
  try {
    await loadAccess(m.conversationId, userId);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── inbox ─────────────────────────

/**
 * Inbox: conversations that have a visible message, newest activity first, paged with a keyset cursor (audit PERF-01).
 * `before` is the id of the last message of the last chat on the previous page (`nextBefore`), so a page never repeats or
 * skips a chat even while new messages arrive. One aggregate query finds the page (last message, unread count, blocked
 * users filtered out); two batched reads then fetch the related rows. The number of statements does not depend on how
 * many chats the user has. `totalUnread` always covers ALL chats, not just the page.
 */
export async function listChats(actor: Actor, q: z.infer<typeof listChatsSchema>) {
  const me = actor.userId;
  if (q.before && !(await prisma.message.findUnique({ where: { id: q.before }, select: { id: true } }))) {
    throw new AppError(400, 'INVALID_CURSOR', 'Unknown message to page before');
  }
  const cursor = q.before ? Prisma.sql`WHERE (last_at, last_id) < (SELECT created_at, id FROM message WHERE id = ${q.before}::uuid)` : Prisma.empty;

  const page = await prisma.$queryRaw<{ id: string; last_id: string; unread: number; total_unread: number }[]>`
    WITH hidden AS (
      SELECT CASE WHEN blocker_id = ${me}::uuid THEN blocked_id ELSE blocker_id END AS user_id
      FROM blocked_user WHERE blocker_id = ${me}::uuid OR blocked_id = ${me}::uuid
    ),
    mine AS (
      SELECT c.id, cp.last_read_at
      FROM conversation c
      LEFT JOIN conversation_participant cp ON cp.conversation_id = c.id AND cp.user_id = ${me}::uuid
      WHERE (c.type = 'MATCH' AND EXISTS (
              SELECT 1 FROM match m WHERE m.id = c.match_id AND (m.organizer_id = ${me}::uuid OR EXISTS (
                SELECT 1 FROM match_participant mp WHERE mp.match_id = m.id AND mp.user_id = ${me}::uuid AND mp.status = 'CONFIRMED'))))
         OR (c.type = 'TEAM' AND EXISTS (SELECT 1 FROM team_member tm WHERE tm.team_id = c.team_id AND tm.user_id = ${me}::uuid))
         OR (c.type = 'DIRECT' AND cp.user_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM conversation_participant o JOIN hidden h ON h.user_id = o.user_id WHERE o.conversation_id = c.id))
    ),
    stats AS (
      SELECT mine.id, last.id AS last_id, last.created_at AS last_at,
             (SELECT count(*)::int FROM message m
               WHERE m.conversation_id = mine.id AND m.sender_id <> ${me}::uuid
                 AND m.sender_id NOT IN (SELECT user_id FROM hidden)
                 AND (mine.last_read_at IS NULL OR m.created_at > mine.last_read_at)) AS unread
      FROM mine
      JOIN LATERAL (
        SELECT m.id, m.created_at FROM message m
        WHERE m.conversation_id = mine.id AND m.sender_id NOT IN (SELECT user_id FROM hidden)
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) last ON true
    ),
    totals AS (SELECT id, last_id, last_at, unread, COALESCE(SUM(unread) OVER (), 0)::int AS total_unread FROM stats)
    SELECT id, last_id, unread, total_unread FROM totals
    ${cursor}
    ORDER BY last_at DESC, last_id DESC
    LIMIT ${q.limit + 1}`;

  const rows = page.slice(0, q.limit);
  const [convs, lastMessages] = await Promise.all([
    prisma.conversation.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      include: {
        match: { select: { id: true, title: true, startAt: true, status: true } },
        team: { select: { id: true, name: true, logoUrl: true } },
        participants: { include: { user: userSummary } },
      },
    }),
    prisma.message.findMany({ where: { id: { in: rows.map((r) => r.last_id) } }, include: { sender: userSummary } }),
  ]);
  const convById = new Map(convs.map((c) => [c.id, c]));
  const messageById = new Map(lastMessages.map((m) => [m.id, m]));

  const chats = rows.map((r) => {
    const c = convById.get(r.id)!;
    const last = messageById.get(r.last_id)!;
    const other = c.type === 'DIRECT' ? c.participants.find((p) => p.userId !== me)?.user : null;
    return {
      id: c.id,
      type: c.type,
      title: c.type === 'MATCH' ? c.match?.title : c.type === 'TEAM' ? c.team?.name : other?.fullName,
      match: c.match,
      team: c.team,
      with: other ?? null,
      lastMessage: { id: last.id, sender: last.sender, body: last.body, createdAt: last.createdAt },
      unreadCount: r.unread,
    };
  });
  return {
    chats,
    totalUnread: page[0]?.total_unread ?? 0,
    nextBefore: page.length > q.limit ? rows[rows.length - 1]!.last_id : null,
  };
}
