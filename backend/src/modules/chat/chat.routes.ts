import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as chat from './chat.controller';
import { directChatSchema, idParams, listMessagesSchema, sendMessageSchema } from './chat.schemas';

export const chatRouter = Router();
chatRouter.use(authenticate);

chatRouter.get('/', chat.inbox);

// open (get-or-create) a conversation
chatRouter.post('/match/:id', validate({ params: idParams }), chat.openMatchChat);
chatRouter.post('/team/:id', validate({ params: idParams }), chat.openTeamChat);
chatRouter.post('/direct', requireVerifiedEmail, validate({ body: directChatSchema }), chat.openDirectChat);

// messages
chatRouter.get('/:id/messages', validate({ params: idParams, query: listMessagesSchema }), chat.listMessages);
chatRouter.post('/:id/messages', requireVerifiedEmail, validate({ params: idParams, body: sendMessageSchema }), chat.sendMessage);
chatRouter.post('/:id/read', validate({ params: idParams }), chat.markRead);
