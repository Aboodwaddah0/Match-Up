import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { deviceSchema, listSchema } from './notifications.schemas';

/*
 * Read side of the transactional outbox. Rows are WRITTEN by notify() (notify.ts) in the same transaction
 * as the change they describe; here users list them, count unread, and mark them read. `params` is data,
 * not text: the client renders the message in the user's language. Push delivery is not wired yet
 * (device tokens are only stored).
 */

/** A page of the user's notifications (newest first) plus their total unread count. */
export async function listNotifications(userId: string, q: z.infer<typeof listSchema>) {
  const where = { userId, ...(q.unread ? { readAt: null } : {}) };
  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return {
    notifications: rows.map((n) => ({
      id: n.id,
      type: n.type,
      params: n.params,
      resource: n.resourceType && n.resourceId ? { type: n.resourceType, id: n.resourceId } : null,
      read: n.readAt !== null,
      createdAt: n.createdAt,
    })),
    unreadCount,
    page: q.page,
    pageSize: q.pageSize,
    total,
  };
}

/** The badge number. */
export async function getUnreadCount(userId: string) {
  return { unreadCount: await prisma.notification.count({ where: { userId, readAt: null } }) };
}

/** Marks everything read; returns how many rows changed. */
export async function markAllRead(userId: string) {
  const r = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: r.count };
}

/** Marks one notification read. Idempotent. A notification of another user is reported as 404 (not 403) so ids reveal nothing. */
export async function markRead(userId: string, id: string): Promise<void> {
  const own = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
  if (!own) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
  await prisma.notification.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } });
}

/** Registers a push token. A token belongs to one user: registering it again moves it to the caller. */
export async function registerDevice(userId: string, { token, platform }: z.infer<typeof deviceSchema>): Promise<void> {
  await prisma.deviceToken.upsert({
    where: { token },
    create: { token, platform, userId },
    update: { userId, platform },
  });
}

/** Removes the caller's own push token (someone else's token is left alone). */
export async function removeDevice(userId: string, token: string): Promise<void> {
  await prisma.deviceToken.deleteMany({ where: { token, userId } });
}
