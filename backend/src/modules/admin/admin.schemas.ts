import { z } from 'zod';

export const idParams = z.object({ id: z.uuid() });

/** Optional note stored nowhere yet; sent to the venue owner in the suspension notification. */
export const reasonSchema = z.object({ reason: z.string().trim().max(500).nullish() });

const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const listUsersSchema = paging.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
});

export const listVenuesSchema = paging.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
});
