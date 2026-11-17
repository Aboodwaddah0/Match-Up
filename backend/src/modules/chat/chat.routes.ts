import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import * as chat from './chat.service';

const actor = (req: { auth?: { userId: string; role: 'USER' | 'ADMIN' } }) => ({ userId: req.auth!.userId, role: req.auth!.role });
const idParams = z.object({ id: z.uuid() });

export const chatRouter = Router();
chatRouter.use(authenticate);

chatRouter.get('/', async (req, res) => {
  res.json(await chat.listChats(actor(req)));
});

// Open (get-or-create) a conversation; returns its id. Non-members get 404.
chatRouter.post('/match/:id', async (req, res) => {
  res.json(await chat.openMatchChat(actor(req), idParams.parse(req.params).id));
});
chatRouter.post('/team/:id', async (req, res) => {
  res.json(await chat.openTeamChat(actor(req), idParams.parse(req.params).id));
});
chatRouter.post('/direct', requireVerifiedEmail, async (req, res) => {
  res.json(await chat.openDirectChat(actor(req), z.object({ userId: z.uuid() }).parse(req.body).userId));
});

chatRouter.get('/:id/messages', async (req, res) => {
  res.json(await chat.listMessages(actor(req), idParams.parse(req.params).id, chat.listMessagesSchema.parse(req.query)));
});
chatRouter.post('/:id/messages', requireVerifiedEmail, async (req, res) => {
  res.status(201).json(await chat.sendMessage(actor(req), idParams.parse(req.params).id, chat.sendMessageSchema.parse(req.body).body));
});
chatRouter.post('/:id/read', async (req, res) => {
  await chat.markRead(actor(req), idParams.parse(req.params).id);
  res.status(204).end();
});
