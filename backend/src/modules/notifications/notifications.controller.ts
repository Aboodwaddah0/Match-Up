import type { Request, Response } from 'express';
import { valid } from '../../middleware/validate';
import { deviceSchema, idParams, listSchema } from './notifications.schemas';
import * as notifications from './notifications.service';

export const list = async (req: Request, res: Response) => {
  res.json(await notifications.listNotifications(req.auth!.userId, valid(req, 'query', listSchema)));
};

export const unreadCount = async (req: Request, res: Response) => {
  res.json(await notifications.getUnreadCount(req.auth!.userId));
};

export const readAll = async (req: Request, res: Response) => {
  res.json(await notifications.markAllRead(req.auth!.userId));
};

export const registerDevice = async (req: Request, res: Response) => {
  await notifications.registerDevice(req.auth!.userId, valid(req, 'body', deviceSchema));
  res.status(204).end();
};

export const removeDevice = async (req: Request, res: Response) => {
  await notifications.removeDevice(req.auth!.userId, req.params.token as string);
  res.status(204).end();
};

export const read = async (req: Request, res: Response) => {
  await notifications.markRead(req.auth!.userId, valid(req, 'params', idParams).id);
  res.status(204).end();
};
