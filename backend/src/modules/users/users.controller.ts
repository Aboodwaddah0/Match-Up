import type { Request, Response } from 'express';
import { valid } from '../../middleware/validate';
import { updateUserSchema } from './users.schemas';
import * as users from './users.service';

export const getMe = async (req: Request, res: Response) => {
  res.json({ user: await users.getMe(req.auth!.userId) });
};

export const updateMe = async (req: Request, res: Response) => {
  res.json({ user: await users.updateMe(req.auth!.userId, valid(req, 'body', updateUserSchema)) });
};
