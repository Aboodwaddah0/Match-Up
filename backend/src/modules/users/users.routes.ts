import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/authenticate';
import { toPublicUser } from '../auth/auth.service';
import { updateUserSchema } from '../players/players.schemas';

export const usersRouter = Router();

usersRouter.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  res.json({ user: toPublicUser(user) });
});

// Account basics (name, avatar, language, time zone). E-mail/password have their own flows.
usersRouter.patch('/me', authenticate, async (req, res) => {
  const data = updateUserSchema.parse(req.body);
  const user = await prisma.user.update({ where: { id: req.auth!.userId }, data });
  res.json({ user: toPublicUser(user) });
});
