import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { verifyAccessTokenClaims } from './jwt';
import { logger } from './logger';
import { prisma } from './prisma';

/*
 * Realtime is a convenience layer: the database (REST) stays the source of truth. A client that is offline or misses an
 * event just calls GET /chats/:id/messages. Each authenticated socket joins the room `user:<id>`; sending a message emits
 * `message:new` to every member's room.
 *
 * Authentication lifetime (audit AUTH-04): a socket is authenticated once, at connection, with an access token. It is
 *  - disconnected when that token expires (clients reconnect with a fresh access token), and
 *  - disconnected at once when the account is suspended or all its sessions are revoked (see disconnectUser).
 * Without this a suspended or logged-out user would keep receiving live chat until they happened to disconnect.
 */

let io: Server | null = null;

/** Idempotent: a second call returns the server created by the first. */
export function attachRealtime(server: HttpServer): Server {
  if (io) return io;
  io = new Server(server, { cors: { origin: true } });

  io.use(async (socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
      const { userId, expiresAt } = await verifyAccessTokenClaims(token);
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!user || user.status !== 'ACTIVE') return next(new Error('UNAUTHENTICATED'));
      socket.data.userId = userId;
      socket.data.expiresAt = expiresAt;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join(`user:${socket.data.userId as string}`);
    // Drop the connection when the access token that opened it expires.
    const ms = Math.max(0, (socket.data.expiresAt as number) * 1000 - Date.now());
    const timer = setTimeout(() => socket.disconnect(true), ms);
    timer.unref();
    socket.on('disconnect', () => clearTimeout(timer));
    logger.debug({ userId: socket.data.userId }, 'socket connected');
  });
  return io;
}

/** No-op when no socket server is attached (tests, scripts). Never throws: delivery is best effort. */
export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  if (!io) return;
  for (const id of new Set(userIds)) io.to(`user:${id}`).emit(event, payload);
}

/** Disconnects every socket of a user (all devices). Used on suspension and when all sessions are revoked. */
export function disconnectUser(userId: string): void {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

/** Disconnects every client and closes the Socket.IO server (which also closes the HTTP server it is attached to). */
export async function closeRealtime(): Promise<void> {
  const current = io;
  io = null;
  if (current) await current.close().catch(() => undefined);
}
