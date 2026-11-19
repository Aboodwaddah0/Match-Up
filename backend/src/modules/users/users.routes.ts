import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { deleteAccountLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as users from './users.controller';
import { deleteAccountSchema, updateUserSchema } from './users.schemas';

export const usersRouter = Router();

usersRouter.get('/me', authenticate, users.getMe);
// Account basics (name, avatar, language, time zone). E-mail/password have their own flows.
usersRouter.patch('/me', authenticate, validate({ body: updateUserSchema }), users.updateMe);

// Account deletion (PRIV-01 / D18): a read-only preview of what blocks it, and the deletion itself (password re-check, anonymized in place, 204).
usersRouter.get('/me/deletion-blockers', authenticate, users.deletionBlockers);
usersRouter.post('/me/delete', authenticate, deleteAccountLimiter, validate({ body: deleteAccountSchema }), users.deleteAccount);
