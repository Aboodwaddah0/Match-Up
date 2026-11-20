import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import { idParams, reasonSchema } from '../admin/admin.schemas';
import { mediaIdParams, mediaOwnerTeamParams, mediaOwnerUserParams, updateMediaSchema, uploadInitSchema } from './media.schemas';
import * as media from './media.service';

export const initUpload = async (req: Request, res: Response) => {
  res.status(201).json(await media.initUpload(actorOf(req), valid(req, 'body', uploadInitSchema)));
};

export const confirm = async (req: Request, res: Response) => {
  res.json(await media.confirmUpload(actorOf(req), valid(req, 'params', mediaIdParams).mediaId));
};

export const update = async (req: Request, res: Response) => {
  res.json(await media.updateMedia(actorOf(req), valid(req, 'params', mediaIdParams).mediaId, valid(req, 'body', updateMediaSchema)));
};

export const remove = async (req: Request, res: Response) => {
  await media.deleteMedia(actorOf(req), valid(req, 'params', mediaIdParams).mediaId);
  res.status(204).end();
};

export const listPlayer = async (req: Request, res: Response) => {
  res.json(await media.listPlayerMedia(actorOf(req), valid(req, 'params', mediaOwnerUserParams).userId));
};

export const listTeam = async (req: Request, res: Response) => {
  res.json(await media.listTeamMedia(actorOf(req), valid(req, 'params', mediaOwnerTeamParams).teamId));
};

// administrator (mounted under /api/v1/admin)
export const adminRemove = async (req: Request, res: Response) => {
  await media.adminRemoveMedia(req.auth!.userId, valid(req, 'params', idParams).id, valid(req, 'body', reasonSchema).reason, String(req.id));
  res.status(204).end();
};
