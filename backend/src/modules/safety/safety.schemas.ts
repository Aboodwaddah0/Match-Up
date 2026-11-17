import { z } from 'zod';

export const userIdParams = z.object({ userId: z.uuid() });
export const reportIdParams = z.object({ id: z.uuid() });

export const blockSchema = z.object({ userId: z.uuid() });

export const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'FAKE_PROFILE', 'NO_SHOW', 'INAPPROPRIATE_CONTENT', 'SAFETY', 'OTHER'] as const;

export const createReportSchema = z.object({
  targetType: z.enum(['USER', 'MATCH', 'VENUE', 'TEAM', 'MESSAGE']),
  targetId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(1000).nullish(),
});

export const adminListReportsSchema = z.object({
  status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']).optional(),
  targetType: z.enum(['USER', 'MATCH', 'VENUE', 'TEAM', 'MESSAGE']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const updateReportSchema = z.object({ status: z.enum(['IN_REVIEW', 'RESOLVED', 'DISMISSED']) });
