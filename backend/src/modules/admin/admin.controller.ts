import type { Request, Response } from 'express';
import { valid } from '../../middleware/validate';
import { idParams, listAuditLogSchema, listUsersSchema, listVenuesSchema, reasonSchema } from './admin.schemas';
import * as admin from './admin.service';

export const listUsers = async (req: Request, res: Response) => {
  res.json(await admin.listUsers(valid(req, 'query', listUsersSchema)));
};

export const getUser = async (req: Request, res: Response) => {
  res.json(await admin.getUser(valid(req, 'params', idParams).id));
};

export const suspendUser = async (req: Request, res: Response) => {
  await admin.suspendUser(req.auth!.userId, valid(req, 'params', idParams).id, valid(req, 'body', reasonSchema).reason, String(req.id));
  res.status(204).end();
};

export const reactivateUser = async (req: Request, res: Response) => {
  await admin.reactivateUser(req.auth!.userId, valid(req, 'params', idParams).id, String(req.id));
  res.status(204).end();
};

export const listVenues = async (req: Request, res: Response) => {
  res.json(await admin.listVenues(valid(req, 'query', listVenuesSchema)));
};

export const suspendVenue = async (req: Request, res: Response) => {
  await admin.setVenueStatus(req.auth!.userId, valid(req, 'params', idParams).id, 'SUSPENDED', valid(req, 'body', reasonSchema).reason, String(req.id));
  res.status(204).end();
};

export const reactivateVenue = async (req: Request, res: Response) => {
  await admin.setVenueStatus(req.auth!.userId, valid(req, 'params', idParams).id, 'ACTIVE', valid(req, 'body', reasonSchema).reason, String(req.id));
  res.status(204).end();
};

export const stats = async (_req: Request, res: Response) => {
  res.json(await admin.getStats());
};

export const listAuditLog = async (req: Request, res: Response) => {
  res.json(await admin.listAuditLog(valid(req, 'query', listAuditLogSchema)));
};
