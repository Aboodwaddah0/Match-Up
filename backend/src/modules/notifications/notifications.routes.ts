import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/authenticate';

/*
 * Read side of the transactional outbox. Rows are written by notify() in the same transaction as the
 * change; here users list them, count unread, and mark them read. `params` is data: clients render
 * the text in the user's language. Push delivery is not wired yet (device tokens are only stored).
 */

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

const listSchema = z.object({
  unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
const idParams = z.object({ id: z.uuid() });
const deviceSchema = z.object({ token: z.string().trim().min(10).max(300), platform: z.enum(['ios', 'android', 'web']) });

notificationsRouter.get('/', async (req, res) => {
  const q = listSchema.parse(req.query);
  const where = { userId: req.auth!.userId, ...(q.unread ? { readAt: null } : {}) };
  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: req.auth!.userId, readAt: null } }),
  ]);
  res.json({
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
  });
});

notificationsRouter.get('/unread-count', async (req, res) => {
  res.json({ unreadCount: await prisma.notification.count({ where: { userId: req.auth!.userId, readAt: null } }) });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const r = await prisma.notification.updateMany({ where: { userId: req.auth!.userId, readAt: null }, data: { readAt: new Date() } });
  res.json({ updated: r.count });
});

// Device tokens for push (delivery comes later). A token belongs to one user: registering it again moves it.
notificationsRouter.post('/devices', async (req, res) => {
  const { token, platform } = deviceSchema.parse(req.body);
  await prisma.deviceToken.upsert({
    where: { token },
    create: { token, platform, userId: req.auth!.userId },
    update: { userId: req.auth!.userId, platform },
  });
  res.status(204).end();
});
notificationsRouter.delete('/devices/:token', async (req, res) => {
  await prisma.deviceToken.deleteMany({ where: { token: req.params.token, userId: req.auth!.userId } });
  res.status(204).end();
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const own = await prisma.notification.findFirst({ where: { id, userId: req.auth!.userId }, select: { id: true } });
  if (!own) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
  await prisma.notification.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } }); // idempotent
  res.status(204).end();
});
