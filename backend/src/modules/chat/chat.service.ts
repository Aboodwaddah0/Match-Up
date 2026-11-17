import type { Conversation, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { Actor } from '../matches/matches.service';
import { emitToUsers } from './realtime';

/*
 * Chat. Membership is DERIVED live from the source of truth, so it can never drift:
 *   MATCH  = the organizer + CONFIRMED participants (leave / removal revokes access immediately)
 *   TEAM   = current team members
 *   DIRECT = the two participant rows (created only between people who share a match or a team)
 * Conversations are created lazily on first use. Messages are immutable (no edit / delete in the MVP).
 * A blocked pair loses their DM, and in group chats each side stops seeing the other's messages.
 */

export const sendMessageSchema = z.object({ body: z.string().trim().min(1).max(2000) });
export const listMessagesSchema = z.object({
  before: z.uuid().optional(), // message id: return messages older than this one
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const RATE_LIMIT_PER_MINUTE = 20;
const READ_ONLY_AFTER_MATCH_DAYS = 7;
const DAY = 86_400_000;
const userSummary = { select: { id: true, fullName: true, avatarUrl: true } } as const;

async function blockedBetween(a: string, b: string): Promise<boolean> {
  return (await prisma.blockedUser.count({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } })) > 0;
}

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
    if (other && (await blockedBetween(userId, other))) throw notFound;
  } else if (conversation.type === 'MATCH') {
    const m = await prisma.match.findUniqueOrThrow({ where: { id: conversation.matchId! }, select: { status: true, endAt: true } });
    canWrite = m.status !== 'CANCELLED' && Date.now() < m.endAt.getTime() + READ_ONLY_AFTER_MATCH_DAYS * DAY;
  }
  return { conversation, members, canWrite };
}

// ───────────────────────── opening a conversation ─────────────────────────

export async function openMatchChat(actor: Actor, matchId: string) {
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { id: true } });
  const conv = m ? await prisma.conversation.upsert({ where: { matchId }, create: { type: 'MATCH', matchId }, update: {} }) : null;
  if (!conv || !(await memberIds(conv)).includes(actor.userId)) throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  return { conversationId: conv.id };
}

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

export async function openDirectChat(actor: Actor, otherId: string) {
  if (otherId === actor.userId) throw new AppError(400, 'INVALID_TARGET', 'You cannot message yourself');
  const other = await prisma.user.findUnique({ where: { id: otherId }, select: { status: true } });
  if (!other || other.status !== 'ACTIVE' || (await blockedBetween(actor.userId, otherId))) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

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

export async function listChats(actor: Actor) {
  const me = actor.userId;
  const convs = await prisma.conversation.findMany({
    where: {
      messages: { some: {} },
      OR: [
        { match: { OR: [{ organizerId: me }, { participants: { some: { userId: me, status: 'CONFIRMED' } } }] } },
        { team: { members: { some: { userId: me } } } },
        { type: 'DIRECT', participants: { some: { userId: me } } },
      ],
    },
    include: {
      match: { select: { id: true, title: true, startAt: true, status: true } },
      team: { select: { id: true, name: true, logoUrl: true } },
      participants: { include: { user: userSummary } },
    },
  });

  const blocks = await prisma.blockedUser.findMany({ where: { OR: [{ blockerId: me }, { blockedId: me }] } });
  const hidden = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]).filter((u) => u !== me));

  const rows = await Promise.all(
    convs
      .filter((c) => c.type !== 'DIRECT' || !c.participants.some((p) => hidden.has(p.userId)))
      .map(async (c) => {
        const mine = c.participants.find((p) => p.userId === me);
        const visible = { conversationId: c.id, senderId: { notIn: [...hidden] } };
        const [last, unread] = await Promise.all([
          prisma.message.findFirst({ where: visible, orderBy: { createdAt: 'desc' }, include: { sender: userSummary } }),
          prisma.message.count({ where: { ...visible, senderId: { notIn: [...hidden, me] }, ...(mine?.lastReadAt ? { createdAt: { gt: mine.lastReadAt } } : {}) } }),
        ]);
        const other = c.type === 'DIRECT' ? c.participants.find((p) => p.userId !== me)?.user : null;
        return {
          id: c.id,
          type: c.type,
          title: c.type === 'MATCH' ? c.match?.title : c.type === 'TEAM' ? c.team?.name : other?.fullName,
          match: c.match,
          team: c.team,
          with: other ?? null,
          lastMessage: last ? { id: last.id, sender: last.sender, body: last.body, createdAt: last.createdAt } : null,
          unreadCount: unread,
        };
      }),
  );
  rows.sort((a, b) => (b.lastMessage?.createdAt.getTime() ?? 0) - (a.lastMessage?.createdAt.getTime() ?? 0));
  return { chats: rows, totalUnread: rows.reduce((s, r) => s + r.unreadCount, 0) };
}
