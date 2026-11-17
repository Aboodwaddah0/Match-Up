import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import {
  createTeamSchema,
  invitationParams,
  inviteSchema,
  searchTeamsSchema,
  setRoleSchema,
  teamIdParams,
  teamMemberParams,
  transferSchema,
  updateTeamSchema,
} from './teams.schemas';
import * as teams from './teams.service';

// ── teams ──
export const create = async (req: Request, res: Response) => {
  res.status(201).json({ team: await teams.createTeam(actorOf(req), valid(req, 'body', createTeamSchema)) });
};

export const search = async (req: Request, res: Response) => {
  res.json(await teams.searchTeams(actorOf(req), valid(req, 'query', searchTeamsSchema)));
};

export const mine = async (req: Request, res: Response) => {
  res.json(await teams.myTeams(actorOf(req)));
};

export const get = async (req: Request, res: Response) => {
  res.json({ team: await teams.getTeam(actorOf(req), valid(req, 'params', teamIdParams).teamId) });
};

export const update = async (req: Request, res: Response) => {
  const { teamId } = valid(req, 'params', teamIdParams);
  res.json({ team: await teams.updateTeam(actorOf(req), teamId, valid(req, 'body', updateTeamSchema)) });
};

// ── members ──
export const leave = async (req: Request, res: Response) => {
  await teams.leaveTeam(actorOf(req), valid(req, 'params', teamIdParams).teamId);
  res.status(204).end();
};

export const removeMember = async (req: Request, res: Response) => {
  const { teamId, userId } = valid(req, 'params', teamMemberParams);
  await teams.removeMember(actorOf(req), teamId, userId);
  res.status(204).end();
};

export const setRole = async (req: Request, res: Response) => {
  const { teamId, userId } = valid(req, 'params', teamMemberParams);
  res.json({ team: await teams.setMemberRole(actorOf(req), teamId, userId, valid(req, 'body', setRoleSchema).role) });
};

export const transferCaptaincy = async (req: Request, res: Response) => {
  const { teamId } = valid(req, 'params', teamIdParams);
  res.json({ team: await teams.transferCaptaincy(actorOf(req), teamId, valid(req, 'body', transferSchema).userId) });
};

// ── invitations sent by the team ──
export const invite = async (req: Request, res: Response) => {
  const { teamId } = valid(req, 'params', teamIdParams);
  res.status(201).json(await teams.inviteToTeam(actorOf(req), teamId, valid(req, 'body', inviteSchema).userId));
};

export const listTeamInvitations = async (req: Request, res: Response) => {
  res.json(await teams.listTeamInvitations(actorOf(req), valid(req, 'params', teamIdParams).teamId));
};

// ── invitations I received (and staff withdrawing one) ──
export const myInvitations = async (req: Request, res: Response) => {
  res.json(await teams.myInvitations(actorOf(req)));
};

export const acceptInvitation = async (req: Request, res: Response) => {
  res.json(await teams.respondToInvitation(actorOf(req), valid(req, 'params', invitationParams).invitationId, 'accept'));
};

export const declineInvitation = async (req: Request, res: Response) => {
  res.json(await teams.respondToInvitation(actorOf(req), valid(req, 'params', invitationParams).invitationId, 'decline'));
};

export const cancelInvitation = async (req: Request, res: Response) => {
  await teams.cancelInvitation(actorOf(req), valid(req, 'params', invitationParams).invitationId);
  res.status(204).end();
};
