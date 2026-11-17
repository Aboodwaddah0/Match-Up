import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { directChatLimiter, messageLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as chat from './chat.controller';
import { directChatSchema, idParams, listChatsSchema, listMessagesSchema, sendMessageSchema } from './chat.schemas';

export const chatRouter = Router();
chatRouter.use(authenticate);

chatRouter.get('/', validate({ query: listChatsSchema }), chat.inbox);

// open (get-or-create) a conversation
chatRouter.post('/match/:id', validate({ params: idParams }), chat.openMatchChat);
chatRouter.post('/team/:id', validate({ params: idParams }), chat.openTeamChat);
chatRouter.post('/direct', requireVerifiedEmail, directChatLimiter, validate({ body: directChatSchema }), chat.openDirectChat);

// messages
chatRouter.get('/:id/messages', validate({ params: idParams, query: listMessagesSchema }), chat.listMessages);
chatRouter.post('/:id/messages', requireVerifiedEmail, messageLimiter, validate({ params: idParams, body: sendMessageSchema }), chat.sendMessage);
chatRouter.post('/:id/read', validate({ params: idParams }), chat.markRead);
