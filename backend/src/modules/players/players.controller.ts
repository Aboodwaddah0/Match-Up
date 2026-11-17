import type { Request, Response } from 'express';
import { valid } from '../../middleware/validate';
import { playerIdParams, upsertProfileSchema } from './players.schemas';
import * as players from './players.service';

export const getMyProfile = async (req: Request, res: Response) => {
  res.json({ profile: await players.getMyProfile(req.auth!.userId) });
};

export const saveMyProfile = async (req: Request, res: Response) => {
  res.json({ profile: await players.upsertMyProfile(req.auth!.userId, valid(req, 'body', upsertProfileSchema)) });
};

export const getPublicProfile = async (req: Request, res: Response) => {
  res.json({ profile: await players.getPublicProfile(req.auth!.userId, valid(req, 'params', playerIdParams).userId) });
};
