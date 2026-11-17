import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { logger } from '../../lib/logger';
import { verifyAccessToken } from '../../lib/jwt';
import { prisma } from '../../lib/prisma';

/*
 * Realtime is a convenience layer: the database (REST) stays the source of truth. A client that is
 * offline or misses an event just calls GET /chats/:id/messages. Each authenticated socket joins
 * the room `user:<id>`; sending a message emits `message:new` to every member's room.
 */

let io: Server | null = null;

export function attachRealtime(server: HttpServer): Server {
  io = new Server(server, { cors: { origin: true } });

  io.use(async (socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
      const userId = await verifyAccessToken(token);
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!user || user.status !== 'ACTIVE') return next(new Error('UNAUTHENTICATED'));
      socket.data.userId = userId;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join(`user:${socket.data.userId as string}`);
    logger.debug({ userId: socket.data.userId }, 'socket connected');
  });
  return io;
}

/** No-op when no socket server is attached (tests, scripts). Never throws: delivery is best effort. */
export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  if (!io) return;
  for (const id of new Set(userIds)) io.to(`user:${id}`).emit(event, payload);
}

export async function closeRealtime(): Promise<void> {
  if (io) await io.close();
  io = null;
}
