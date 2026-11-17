import type { Request, Response } from 'express';
import { valid } from '../../middleware/validate';
import { adminListReportsSchema, blockSchema, createReportSchema, reportIdParams, updateReportSchema, userIdParams } from './safety.schemas';
import * as safety from './safety.service';

// ── blocking: /users/me/blocks ──
export const listBlocks = async (req: Request, res: Response) => {
  res.json(await safety.listBlocks(req.auth!.userId));
};

export const block = async (req: Request, res: Response) => {
  await safety.blockUser(req.auth!.userId, valid(req, 'body', blockSchema).userId);
  res.status(204).end();
};

export const unblock = async (req: Request, res: Response) => {
  await safety.unblockUser(req.auth!.userId, valid(req, 'params', userIdParams).userId);
  res.status(204).end();
};

// ── reports: /reports ──
export const createReport = async (req: Request, res: Response) => {
  res.status(201).json(await safety.createReport(req.auth!.userId, valid(req, 'body', createReportSchema)));
};

export const myReports = async (req: Request, res: Response) => {
  res.json(await safety.myReports(req.auth!.userId));
};

// ── moderation queue: /admin/reports ──
export const adminListReports = async (req: Request, res: Response) => {
  res.json(await safety.adminListReports(valid(req, 'query', adminListReportsSchema)));
};

export const adminUpdateReport = async (req: Request, res: Response) => {
  res.json(await safety.updateReportStatus(req.auth!.userId, valid(req, 'params', reportIdParams).id, valid(req, 'body', updateReportSchema).status));
};
