import { z } from 'zod';

export const matchParams = z.object({ matchId: z.uuid() });
export const playerParams = z.object({ userId: z.uuid() });

const score = z.number().int().min(1).max(5);

/** One review: three 1-5 scores and an optional comment. Attendance is not a score; it comes from organizer-confirmed data. */
export const createReviewSchema = z.object({
  reviewedId: z.uuid(),
  sportsmanshipScore: score,
  skillScore: score,
  reliabilityScore: score,
  comment: z.string().trim().max(500).nullish(),
});

export const listReviewsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
