import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import { directChatSchema, idParams, listChatsSchema, listMessagesSchema, sendMessageSchema } from './chat.schemas';
import * as chat from './chat.service';

export const inbox = async (req: Request, res: Response) => {
  res.json(await chat.listChats(actorOf(req), valid(req, 'query', listChatsSchema)));
};

// Opening returns the conversation id (get-or-create). Non-members get 404.
export const openMatchChat = async (req: Request, res: Response) => {
  res.json(await chat.openMatchChat(actorOf(req), valid(req, 'params', idParams).id));
};

export const openTeamChat = async (req: Request, res: Response) => {
  res.json(await chat.openTeamChat(actorOf(req), valid(req, 'params', idParams).id));
};

export const openDirectChat = async (req: Request, res: Response) => {
  res.json(await chat.openDirectChat(actorOf(req), valid(req, 'body', directChatSchema).userId));
};

export const listMessages = async (req: Request, res: Response) => {
  res.json(await chat.listMessages(actorOf(req), valid(req, 'params', idParams).id, valid(req, 'query', listMessagesSchema)));
};

export const sendMessage = async (req: Request, res: Response) => {
  res.status(201).json(await chat.sendMessage(actorOf(req), valid(req, 'params', idParams).id, valid(req, 'body', sendMessageSchema).body));
};

export const markRead = async (req: Request, res: Response) => {
  await chat.markRead(actorOf(req), valid(req, 'params', idParams).id);
  res.status(204).end();
};
