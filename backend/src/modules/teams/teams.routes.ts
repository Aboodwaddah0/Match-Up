import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import * as challenges from './challenges.service';
import {
  challengeParams,
  challengesQuerySchema,
  createChallengeSchema,
  createTeamSchema,
  inviteSchema,
  invitationParams,
  rosterAddSchema,
  rosterMemberParams,
  rosterParams,
  searchTeamsSchema,
  setRoleSchema,
  teamIdParams,
  teamMemberParams,
  transferSchema,
  updateTeamSchema,
} from './teams.schemas';
import * as teams from './teams.service';

const actor = (req: { auth?: { userId: string; role: 'USER' | 'ADMIN' } }) => ({ userId: req.auth!.userId, role: req.auth!.role });

// ───────── /api/v1/teams ─────────
export const teamsRouter = Router();
teamsRouter.use(authenticate);

teamsRouter.post('/', requireVerifiedEmail, async (req, res) => {
  res.status(201).json({ team: await teams.createTeam(actor(req), createTeamSchema.parse(req.body)) });
});
teamsRouter.get('/', async (req, res) => {
  res.json(await teams.searchTeams(actor(req), searchTeamsSchema.parse(req.query)));
});
teamsRouter.get('/mine', async (req, res) => {
  res.json(await teams.myTeams(actor(req)));
});

// invitations received by me (declared before /:teamId so "invitations" is never read as an id)
teamsRouter.get('/invitations/mine', async (req, res) => {
  res.json(await teams.myInvitations(actor(req)));
});
teamsRouter.post('/invitations/:invitationId/accept', requireVerifiedEmail, async (req, res) => {
  const { invitationId } = invitationParams.parse(req.params);
  res.json(await teams.respondToInvitation(actor(req), invitationId, 'accept'));
});
teamsRouter.post('/invitations/:invitationId/decline', async (req, res) => {
  const { invitationId } = invitationParams.parse(req.params);
  res.json(await teams.respondToInvitation(actor(req), invitationId, 'decline'));
});
teamsRouter.post('/invitations/:invitationId/cancel', async (req, res) => {
  const { invitationId } = invitationParams.parse(req.params);
  await teams.cancelInvitation(actor(req), invitationId);
  res.status(204).end();
});

teamsRouter.get('/:teamId', async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  res.json({ team: await teams.getTeam(actor(req), teamId) });
});
teamsRouter.patch('/:teamId', async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  res.json({ team: await teams.updateTeam(actor(req), teamId, updateTeamSchema.parse(req.body)) });
});

// members
teamsRouter.post('/:teamId/leave', async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  await teams.leaveTeam(actor(req), teamId);
  res.status(204).end();
});
teamsRouter.delete('/:teamId/members/:userId', async (req, res) => {
  const { teamId, userId } = teamMemberParams.parse(req.params);
  await teams.removeMember(actor(req), teamId, userId);
  res.status(204).end();
});
teamsRouter.patch('/:teamId/members/:userId', async (req, res) => {
  const { teamId, userId } = teamMemberParams.parse(req.params);
  res.json({ team: await teams.setMemberRole(actor(req), teamId, userId, setRoleSchema.parse(req.body).role) });
});
teamsRouter.post('/:teamId/transfer-captaincy', async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  res.json({ team: await teams.transferCaptaincy(actor(req), teamId, transferSchema.parse(req.body).userId) });
});

// invitations sent by the team
teamsRouter.post('/:teamId/invitations', async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  res.status(201).json(await teams.inviteToTeam(actor(req), teamId, inviteSchema.parse(req.body).userId));
});
teamsRouter.get('/:teamId/invitations', async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  res.json(await teams.listTeamInvitations(actor(req), teamId));
});

// challenges of one team
teamsRouter.post('/:teamId/challenges', requireVerifiedEmail, async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  res.status(201).json(await challenges.createChallenge(actor(req), teamId, createChallengeSchema.parse(req.body)));
});
teamsRouter.get('/:teamId/challenges', async (req, res) => {
  const { teamId } = teamIdParams.parse(req.params);
  res.json(await challenges.listChallenges(actor(req), teamId, challengesQuerySchema.parse(req.query)));
});

// roster for a team challenge match
teamsRouter.get('/:teamId/matches/:matchId/roster', async (req, res) => {
  const { teamId, matchId } = rosterParams.parse(req.params);
  res.json(await challenges.getRoster(actor(req), teamId, matchId));
});
teamsRouter.post('/:teamId/matches/:matchId/roster', async (req, res) => {
  const { teamId, matchId } = rosterParams.parse(req.params);
  res.status(201).json(await challenges.addToRoster(actor(req), teamId, matchId, rosterAddSchema.parse(req.body).userId));
});
teamsRouter.delete('/:teamId/matches/:matchId/roster/:userId', async (req, res) => {
  const { teamId, matchId, userId } = rosterMemberParams.parse(req.params);
  res.json(await challenges.removeFromRoster(actor(req), teamId, matchId, userId));
});

// ───────── /api/v1/challenges ─────────
export const challengesRouter = Router();
challengesRouter.use(authenticate);

challengesRouter.post('/:challengeId/accept', requireVerifiedEmail, async (req, res) => {
  const { challengeId } = challengeParams.parse(req.params);
  res.json(await challenges.acceptChallenge(actor(req), challengeId));
});
challengesRouter.post('/:challengeId/reject', async (req, res) => {
  const { challengeId } = challengeParams.parse(req.params);
  res.json(await challenges.rejectChallenge(actor(req), challengeId));
});
challengesRouter.post('/:challengeId/cancel', async (req, res) => {
  const { challengeId } = challengeParams.parse(req.params);
  res.json(await challenges.cancelChallenge(actor(req), challengeId));
});
