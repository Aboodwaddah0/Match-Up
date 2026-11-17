import { prisma } from './prisma';

/**
 * True when either user has blocked the other. Blocking is symmetric in effect: neither side can see or interact
 * with the other (matches, profiles, invitations, reviews, chat). Used by every module that enforces blocks, so the rule
 * lives in one place. Callers decide what to answer; most return 404 so a block never reveals itself.
 */
export async function areBlocked(a: string, b: string): Promise<boolean> {
  const n = await prisma.blockedUser.count({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } });
  return n > 0;
}
