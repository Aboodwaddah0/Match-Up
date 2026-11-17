import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });

export const teamIdParams = z.object({ teamId: z.uuid() });
export const teamMemberParams = z.object({ teamId: z.uuid(), userId: z.uuid() });
export const invitationParams = z.object({ invitationId: z.uuid() });
export const challengeParams = z.object({ challengeId: z.uuid() });
export const rosterParams = z.object({ teamId: z.uuid(), matchId: z.uuid() });
export const rosterMemberParams = z.object({ teamId: z.uuid(), matchId: z.uuid(), userId: z.uuid() });

export const createTeamSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500).nullish(),
  logoUrl: z.url({ protocol: /^https$/ }).max(500).nullish(),
  cityId: z.uuid().nullish(),
});

export const updateTeamSchema = createTeamSchema.partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const searchTeamsSchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  cityId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const inviteSchema = z.object({ userId: z.uuid() });
export const setRoleSchema = z.object({ role: z.enum(['VICE_CAPTAIN', 'MEMBER']) });
export const transferSchema = z.object({ userId: z.uuid() });

export const createChallengeSchema = z.object({
  challengedTeamId: z.uuid(),
  format: z.enum(['F5', 'F7', 'F11']),
  proposedStartAt: instant,
  message: z.string().trim().max(300).nullish(),
});

export const challengesQuerySchema = z.object({
  direction: z.enum(['incoming', 'outgoing']).default('incoming'),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED']).optional(),
});

export const rosterAddSchema = z.object({ userId: z.uuid() });
