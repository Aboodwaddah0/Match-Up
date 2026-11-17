import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as challenges from './challenges.controller';
import {
  challengeParams,
  challengesQuerySchema,
  createChallengeSchema,
  createTeamSchema,
  invitationParams,
  inviteSchema,
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
import * as teams from './teams.controller';

// Who may do what (captain / vice captain / member) is decided in the services, per team.

// ───────── /api/v1/teams ─────────
export const teamsRouter = Router();
teamsRouter.use(authenticate);

teamsRouter.post('/', requireVerifiedEmail, validate({ body: createTeamSchema }), teams.create);
teamsRouter.get('/', validate({ query: searchTeamsSchema }), teams.search);
teamsRouter.get('/mine', teams.mine);

// Invitations I received. Declared BEFORE /:teamId so the word "invitations" is never read as a team id.
teamsRouter.get('/invitations/mine', teams.myInvitations);
teamsRouter.post('/invitations/:invitationId/accept', requireVerifiedEmail, validate({ params: invitationParams }), teams.acceptInvitation);
teamsRouter.post('/invitations/:invitationId/decline', validate({ params: invitationParams }), teams.declineInvitation);
teamsRouter.post('/invitations/:invitationId/cancel', validate({ params: invitationParams }), teams.cancelInvitation);

teamsRouter.get('/:teamId', validate({ params: teamIdParams }), teams.get);
teamsRouter.patch('/:teamId', validate({ params: teamIdParams, body: updateTeamSchema }), teams.update);

// members
teamsRouter.post('/:teamId/leave', validate({ params: teamIdParams }), teams.leave);
teamsRouter.delete('/:teamId/members/:userId', validate({ params: teamMemberParams }), teams.removeMember);
teamsRouter.patch('/:teamId/members/:userId', validate({ params: teamMemberParams, body: setRoleSchema }), teams.setRole);
teamsRouter.post('/:teamId/transfer-captaincy', validate({ params: teamIdParams, body: transferSchema }), teams.transferCaptaincy);

// invitations sent by the team
teamsRouter.post('/:teamId/invitations', validate({ params: teamIdParams, body: inviteSchema }), teams.invite);
teamsRouter.get('/:teamId/invitations', validate({ params: teamIdParams }), teams.listTeamInvitations);

// challenges of one team
teamsRouter.post('/:teamId/challenges', requireVerifiedEmail, validate({ params: teamIdParams, body: createChallengeSchema }), challenges.create);
teamsRouter.get('/:teamId/challenges', validate({ params: teamIdParams, query: challengesQuerySchema }), challenges.list);

// roster for a team challenge match
teamsRouter.get('/:teamId/matches/:matchId/roster', validate({ params: rosterParams }), challenges.getRoster);
teamsRouter.post('/:teamId/matches/:matchId/roster', validate({ params: rosterParams, body: rosterAddSchema }), challenges.addToRoster);
teamsRouter.delete('/:teamId/matches/:matchId/roster/:userId', validate({ params: rosterMemberParams }), challenges.removeFromRoster);

// ───────── /api/v1/challenges ─────────
export const challengesRouter = Router();
challengesRouter.use(authenticate);

challengesRouter.post('/:challengeId/accept', requireVerifiedEmail, validate({ params: challengeParams }), challenges.accept);
challengesRouter.post('/:challengeId/reject', validate({ params: challengeParams }), challenges.reject);
challengesRouter.post('/:challengeId/cancel', validate({ params: challengeParams }), challenges.cancel);
