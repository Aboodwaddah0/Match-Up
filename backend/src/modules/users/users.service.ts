import type { User } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma';
import type { updateUserSchema } from './users.schemas';

/** The user fields that are safe to send to the client (never the password hash). */
export function toPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    timezone: user.timezone,
    platformRole: user.platformRole,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
  };
}

/** The signed-in user's own account. */
export async function getMe(userId: string) {
  return toPublicUser(await prisma.user.findUniqueOrThrow({ where: { id: userId } }));
}

/** Updates account basics (name, avatar, language, time zone); the schema guarantees at least one field. */
export async function updateMe(userId: string, data: z.infer<typeof updateUserSchema>) {
  return toPublicUser(await prisma.user.update({ where: { id: userId }, data }));
}
