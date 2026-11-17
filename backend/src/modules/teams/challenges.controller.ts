import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import * as challenges from './challenges.service';
import { challengeParams, challengesQuerySchema, createChallengeSchema, rosterAddSchema, rosterMemberParams, rosterParams, teamIdParams } from './teams.schemas';

// ── challenges of one team: /teams/:teamId/challenges ──
export const create = async (req: Request, res: Response) => {
  const { teamId } = valid(req, 'params', teamIdParams);
  res.status(201).json(await challenges.createChallenge(actorOf(req), teamId, valid(req, 'body', createChallengeSchema)));
};

export const list = async (req: Request, res: Response) => {
  const { teamId } = valid(req, 'params', teamIdParams);
  res.json(await challenges.listChallenges(actorOf(req), teamId, valid(req, 'query', challengesQuerySchema)));
};

// ── answering a challenge: /challenges/:challengeId ──
export const accept = async (req: Request, res: Response) => {
  res.json(await challenges.acceptChallenge(actorOf(req), valid(req, 'params', challengeParams).challengeId));
};

export const reject = async (req: Request, res: Response) => {
  res.json(await challenges.rejectChallenge(actorOf(req), valid(req, 'params', challengeParams).challengeId));
};

export const cancel = async (req: Request, res: Response) => {
  res.json(await challenges.cancelChallenge(actorOf(req), valid(req, 'params', challengeParams).challengeId));
};

// ── rosters for a team match: /teams/:teamId/matches/:matchId/roster ──
export const getRoster = async (req: Request, res: Response) => {
  const { teamId, matchId } = valid(req, 'params', rosterParams);
  res.json(await challenges.getRoster(actorOf(req), teamId, matchId));
};

export const addToRoster = async (req: Request, res: Response) => {
  const { teamId, matchId } = valid(req, 'params', rosterParams);
  res.status(201).json(await challenges.addToRoster(actorOf(req), teamId, matchId, valid(req, 'body', rosterAddSchema).userId));
};

export const removeFromRoster = async (req: Request, res: Response) => {
  const { teamId, matchId, userId } = valid(req, 'params', rosterMemberParams);
  res.json(await challenges.removeFromRoster(actorOf(req), teamId, matchId, userId));
};
