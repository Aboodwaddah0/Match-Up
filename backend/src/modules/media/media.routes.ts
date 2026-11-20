import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { mediaUploadLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as media from './media.controller';
import { mediaIdParams, mediaOwnerTeamParams, mediaOwnerUserParams, updateMediaSchema, uploadInitSchema } from './media.schemas';

// Who may do what (the owner, team captain / vice captain, an admin) is decided in the service, inside the transaction that acts.

// ───────── /api/v1/media: upload, confirm, caption / order, delete ─────────
export const mediaRouter = Router();
mediaRouter.use(authenticate);

mediaRouter.post('/uploads', requireVerifiedEmail, mediaUploadLimiter, validate({ body: uploadInitSchema }), media.initUpload);
mediaRouter.post('/:mediaId/confirm', requireVerifiedEmail, validate({ params: mediaIdParams }), media.confirm);
mediaRouter.patch('/:mediaId', validate({ params: mediaIdParams, body: updateMediaSchema }), media.update);
mediaRouter.delete('/:mediaId', validate({ params: mediaIdParams }), media.remove);

// ───────── /api/v1/players/:userId/media ─────────
export const playerMediaRouter = Router({ mergeParams: true });
playerMediaRouter.use(authenticate);
playerMediaRouter.get('/', validate({ params: mediaOwnerUserParams }), media.listPlayer);

// ───────── /api/v1/teams/:teamId/media ─────────
export const teamMediaRouter = Router({ mergeParams: true });
teamMediaRouter.use(authenticate);
teamMediaRouter.get('/', validate({ params: mediaOwnerTeamParams }), media.listTeam);
