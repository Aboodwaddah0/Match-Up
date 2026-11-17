import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as users from './users.controller';
import { updateUserSchema } from './users.schemas';

export const usersRouter = Router();

usersRouter.get('/me', authenticate, users.getMe);
// Account basics (name, avatar, language, time zone). E-mail/password have their own flows.
usersRouter.patch('/me', authenticate, validate({ body: updateUserSchema }), users.updateMe);
