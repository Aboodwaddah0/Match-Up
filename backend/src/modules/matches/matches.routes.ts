import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { createMatchLimiter, invitationLimiter, joinRequestLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as matches from './matches.controller';
import {
  attendanceSchema,
  cancelSchema,
  createMatchSchema,
  createRequestSchema,
  inviteSchema,
  listRequestsQuery,
  matchIdParams,
  mineSchema,
  participantParams,
  requestParams,
  searchSchema,
  updateMatchSchema,
} from './matches.schemas';
import * as participation from './participation.controller';

// Ownership checks (organizer / admin) live in the services; the routes only authenticate and validate.
export const matchesRouter = Router();
matchesRouter.use(authenticate);

// ── discovery ──
matchesRouter.get('/', validate({ query: searchSchema }), matches.search);
matchesRouter.get('/mine', validate({ query: mineSchema }), matches.mine);

// ── match CRUD and lifecycle ──
matchesRouter.post('/', requireVerifiedEmail, createMatchLimiter, validate({ body: createMatchSchema }), matches.create);
matchesRouter.get('/:matchId', validate({ params: matchIdParams }), matches.get);
matchesRouter.patch('/:matchId', validate({ params: matchIdParams, body: updateMatchSchema }), matches.update);
matchesRouter.post('/:matchId/cancel', validate({ params: matchIdParams, body: cancelSchema, optionalBody: true }), matches.cancel);
matchesRouter.post('/:matchId/complete', validate({ params: matchIdParams }), matches.complete);

// ── join requests ──
matchesRouter.post('/:matchId/requests', requireVerifiedEmail, joinRequestLimiter, validate({ params: matchIdParams, body: createRequestSchema, optionalBody: true }), participation.createRequest);
matchesRouter.delete('/:matchId/requests/me', validate({ params: matchIdParams }), participation.withdrawRequest);
matchesRouter.get('/:matchId/requests', validate({ params: matchIdParams, query: listRequestsQuery }), participation.listRequests);
matchesRouter.post('/:matchId/requests/:requestId/accept', validate({ params: requestParams }), participation.acceptRequest);
matchesRouter.post('/:matchId/requests/:requestId/reject', validate({ params: requestParams }), participation.rejectRequest);

// ── participants ──
matchesRouter.get('/:matchId/participants', validate({ params: matchIdParams }), participation.listParticipants);
matchesRouter.post('/:matchId/leave', validate({ params: matchIdParams }), participation.leave);
matchesRouter.delete('/:matchId/participants/:userId', validate({ params: participantParams }), participation.removeParticipant);
matchesRouter.patch('/:matchId/participants/:userId/attendance', validate({ params: participantParams, body: attendanceSchema }), participation.setAttendance);

// ── invitations ──
matchesRouter.post('/:matchId/invitations', requireVerifiedEmail, invitationLimiter, validate({ params: matchIdParams, body: inviteSchema }), participation.invite);
