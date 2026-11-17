import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as notifications from './notifications.controller';
import { deviceSchema, idParams, listSchema } from './notifications.schemas';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', validate({ query: listSchema }), notifications.list);
notificationsRouter.get('/unread-count', notifications.unreadCount);
notificationsRouter.post('/read-all', notifications.readAll);

// Device tokens for push (delivery comes later).
notificationsRouter.post('/devices', validate({ body: deviceSchema }), notifications.registerDevice);
notificationsRouter.delete('/devices/:token', notifications.removeDevice);

notificationsRouter.post('/:id/read', validate({ params: idParams }), notifications.read);
