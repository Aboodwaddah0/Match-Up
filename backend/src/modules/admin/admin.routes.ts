import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as mediaAdmin from '../media/media.controller';
import * as admin from './admin.controller';
import { idParams, listAuditLogSchema, listUsersSchema, listVenuesSchema, reasonSchema } from './admin.schemas';

// Everything under /api/v1/admin needs an authenticated administrator.
export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

// users
adminRouter.get('/users', validate({ query: listUsersSchema }), admin.listUsers);
adminRouter.get('/users/:id', validate({ params: idParams }), admin.getUser);
adminRouter.post('/users/:id/suspend', validate({ params: idParams, body: reasonSchema, optionalBody: true }), admin.suspendUser);
adminRouter.post('/users/:id/reactivate', validate({ params: idParams }), admin.reactivateUser);

// venues
adminRouter.get('/venues', validate({ query: listVenuesSchema }), admin.listVenues);
adminRouter.post('/venues/:id/suspend', validate({ params: idParams, body: reasonSchema, optionalBody: true }), admin.suspendVenue);
adminRouter.post('/venues/:id/reactivate', validate({ params: idParams, body: reasonSchema, optionalBody: true }), admin.reactivateVenue);

// media: remove any photo or video (audited; the file is deleted at the provider by the media worker)
adminRouter.post('/media/:id/remove', validate({ params: idParams, body: reasonSchema, optionalBody: true }), mediaAdmin.adminRemove);

adminRouter.get('/stats', admin.stats);

// audit log: read only (no update or delete endpoint exists, by design)
adminRouter.get('/audit-log', validate({ query: listAuditLogSchema }), admin.listAuditLog);
