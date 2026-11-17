import { z } from 'zod';

export const idParams = z.object({ id: z.uuid() });
export const directChatSchema = z.object({ userId: z.uuid() });

export const sendMessageSchema = z.object({ body: z.string().trim().min(1).max(2000) });

export const listMessagesSchema = z.object({
  before: z.uuid().optional(), // message id: return messages older than this one
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
