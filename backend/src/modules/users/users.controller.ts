import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import * as deletion from './deletion.service';
import { deleteAccountSchema, updateUserSchema } from './users.schemas';
import * as users from './users.service';

export const getMe = async (req: Request, res: Response) => {
  res.json({ user: await users.getMe(req.auth!.userId) });
};

export const updateMe = async (req: Request, res: Response) => {
  res.json({ user: await users.updateMe(req.auth!.userId, valid(req, 'body', updateUserSchema)) });
};

export const deletionBlockers = async (req: Request, res: Response) => {
  res.json(await deletion.getDeletionBlockers(actorOf(req)));
};

export const deleteAccount = async (req: Request, res: Response) => {
  await deletion.deleteAccount(actorOf(req), valid(req, 'body', deleteAccountSchema).password, String(req.id));
  res.status(204).end();
};
