import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as players from './players.controller';
import { playerIdParams, upsertProfileSchema } from './players.schemas';

export const playersRouter = Router();
playersRouter.use(authenticate);

playersRouter.get('/me', players.getMyProfile);
// Create or replace my profile (idempotent).
playersRouter.put('/me', validate({ body: upsertProfileSchema }), players.saveMyProfile);
playersRouter.get('/:userId', validate({ params: playerIdParams }), players.getPublicProfile);
