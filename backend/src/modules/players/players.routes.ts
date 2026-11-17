import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { playerIdParams, upsertProfileSchema } from './players.schemas';
import * as players from './players.service';

export const playersRouter = Router();
playersRouter.use(authenticate);

playersRouter.get('/me', async (req, res) => {
  res.json({ profile: await players.getMyProfile(req.auth!.userId) });
});

// Create or replace my profile (idempotent).
playersRouter.put('/me', async (req, res) => {
  const profile = await players.upsertMyProfile(req.auth!.userId, upsertProfileSchema.parse(req.body));
  res.json({ profile });
});

playersRouter.get('/:userId', async (req, res) => {
  const { userId } = playerIdParams.parse(req.params);
  res.json({ profile: await players.getPublicProfile(req.auth!.userId, userId) });
});
