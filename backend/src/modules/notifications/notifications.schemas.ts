import { z } from 'zod';

export const listSchema = z.object({
  unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const idParams = z.object({ id: z.uuid() });

export const deviceSchema = z.object({ token: z.string().trim().min(10).max(300), platform: z.enum(['ios', 'android', 'web']) });
