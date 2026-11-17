import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as safety from './safety.controller';
import { adminListReportsSchema, blockSchema, createReportSchema, reportIdParams, updateReportSchema, userIdParams } from './safety.schemas';

// ───────── /api/v1/users/me/blocks ─────────
export const blocksRouter = Router();
blocksRouter.use(authenticate);
blocksRouter.get('/', safety.listBlocks);
blocksRouter.post('/', validate({ body: blockSchema }), safety.block);
blocksRouter.delete('/:userId', validate({ params: userIdParams }), safety.unblock);

// ───────── /api/v1/reports ─────────
export const reportsRouter = Router();
reportsRouter.use(authenticate);
reportsRouter.post('/', validate({ body: createReportSchema }), safety.createReport);
reportsRouter.get('/mine', safety.myReports);

// ───────── /api/v1/admin/reports (moderation queue, admins only) ─────────
export const adminReportsRouter = Router();
adminReportsRouter.use(authenticate, requireAdmin);
adminReportsRouter.get('/', validate({ query: adminListReportsSchema }), safety.adminListReports);
adminReportsRouter.patch('/:id', validate({ params: reportIdParams, body: updateReportSchema }), safety.adminUpdateReport);
