import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import {
  attendanceSchema,
  cancelSchema,
  createMatchSchema,
  createRequestSchema,
  inviteSchema,
  matchIdParams,
  mineSchema,
  participantParams,
  requestParams,
  searchSchema,
  updateMatchSchema,
} from './matches.schemas';
import * as matches from './matches.service';
import * as participation from './participation.service';

export const matchesRouter = Router();
matchesRouter.use(authenticate);

const actor = (req: { auth?: { userId: string; role: 'USER' | 'ADMIN' } }) => ({ userId: req.auth!.userId, role: req.auth!.role });

// ── discovery ──
matchesRouter.get('/', async (req, res) => {
  res.json(await matches.searchMatches(actor(req), searchSchema.parse(req.query)));
});

matchesRouter.get('/mine', async (req, res) => {
  res.json(await matches.myMatches(actor(req), mineSchema.parse(req.query)));
});

// ── match CRUD ──
matchesRouter.post('/', requireVerifiedEmail, async (req, res) => {
  res.status(201).json({ match: await matches.createMatch(actor(req), createMatchSchema.parse(req.body)) });
});

matchesRouter.get('/:matchId', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  res.json({ match: await matches.getMatch(actor(req), matchId) });
});

matchesRouter.patch('/:matchId', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  res.json({ match: await matches.updateMatch(actor(req), matchId, updateMatchSchema.parse(req.body)) });
});

matchesRouter.post('/:matchId/cancel', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  const { reason, releaseBooking } = cancelSchema.parse(req.body ?? {});
  res.json({ match: await matches.cancelMatch(actor(req), matchId, reason, releaseBooking) });
});

matchesRouter.post('/:matchId/complete', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  res.json({ match: await matches.completeMatch(actor(req), matchId) });
});

// ── join requests ──
matchesRouter.post('/:matchId/requests', requireVerifiedEmail, async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  const { message } = createRequestSchema.parse(req.body ?? {});
  res.status(201).json(await participation.createRequest(actor(req), matchId, message));
});

matchesRouter.delete('/:matchId/requests/me', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  await participation.withdrawRequest(actor(req), matchId);
  res.status(204).end();
});

matchesRouter.get('/:matchId/requests', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  res.json(await participation.listPendingRequests(actor(req), matchId));
});

matchesRouter.post('/:matchId/requests/:requestId/accept', async (req, res) => {
  const { matchId, requestId } = requestParams.parse(req.params);
  res.json(await participation.decideRequest(actor(req), matchId, requestId, 'accept'));
});

matchesRouter.post('/:matchId/requests/:requestId/reject', async (req, res) => {
  const { matchId, requestId } = requestParams.parse(req.params);
  res.json(await participation.decideRequest(actor(req), matchId, requestId, 'reject'));
});

// ── participants ──
matchesRouter.get('/:matchId/participants', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  res.json(await participation.listParticipants(actor(req), matchId));
});

matchesRouter.post('/:matchId/leave', async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  res.json(await participation.leaveMatch(actor(req), matchId));
});

matchesRouter.delete('/:matchId/participants/:userId', async (req, res) => {
  const { matchId, userId } = participantParams.parse(req.params);
  await participation.removeParticipant(actor(req), matchId, userId);
  res.status(204).end();
});

matchesRouter.patch('/:matchId/participants/:userId/attendance', async (req, res) => {
  const { matchId, userId } = participantParams.parse(req.params);
  const { status } = attendanceSchema.parse(req.body);
  res.json(await participation.setAttendance(actor(req), matchId, userId, status));
});

// ── invitations ──
matchesRouter.post('/:matchId/invitations', requireVerifiedEmail, async (req, res) => {
  const { matchId } = matchIdParams.parse(req.params);
  const { userId } = inviteSchema.parse(req.body);
  await participation.inviteUser(actor(req), matchId, userId);
  res.status(201).json({ invited: true });
});
