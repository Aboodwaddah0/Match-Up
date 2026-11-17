import { z } from 'zod';

export const idParams = z.object({ id: z.uuid() });

/** Optional note: stored in the admin audit log and, for venues, sent to the owner in the notification. */
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

const instant = z.iso.datetime({ offset: true });
const AUDIT_ACTIONS = ['USER_SUSPENDED', 'USER_REACTIVATED', 'VENUE_SUSPENDED', 'VENUE_REACTIVATED', 'REPORT_STATUS_CHANGED', 'MATCH_CANCELLED_BY_ADMIN', 'MATCH_COMPLETED_BY_ADMIN', 'MATCH_RECOVERED_BY_ADMIN', 'MATCH_EDITED_BY_ADMIN'] as const;

/** Filters of the audit-log read endpoint. `from` is inclusive, `to` is exclusive. */
export const listAuditLogSchema = paging
  .extend({
    actorId: z.uuid().optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    targetType: z.enum(['USER', 'VENUE', 'REPORT', 'MATCH']).optional(),
    targetId: z.uuid().optional(),
    from: instant.optional(),
    to: instant.optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), { message: 'from must be before to', path: ['from'] });
