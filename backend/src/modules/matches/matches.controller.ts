import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import { cancelSchema, createMatchSchema, matchIdParams, mineSchema, searchSchema, updateMatchSchema } from './matches.schemas';
import * as matches from './matches.service';

// ── discovery ──
export const search = async (req: Request, res: Response) => {
  res.json(await matches.searchMatches(actorOf(req), valid(req, 'query', searchSchema)));
};

export const mine = async (req: Request, res: Response) => {
  res.json(await matches.myMatches(actorOf(req), valid(req, 'query', mineSchema)));
};

// ── match CRUD and lifecycle ──
export const create = async (req: Request, res: Response) => {
  res.status(201).json({ match: await matches.createMatch(actorOf(req), valid(req, 'body', createMatchSchema)) });
};

export const get = async (req: Request, res: Response) => {
  res.json({ match: await matches.getMatch(actorOf(req), valid(req, 'params', matchIdParams).matchId) });
};

export const update = async (req: Request, res: Response) => {
  const { matchId } = valid(req, 'params', matchIdParams);
  res.json({ match: await matches.updateMatch(actorOf(req), matchId, valid(req, 'body', updateMatchSchema)) });
};

export const cancel = async (req: Request, res: Response) => {
  const { matchId } = valid(req, 'params', matchIdParams);
  const { reason, releaseBooking } = valid(req, 'body', cancelSchema);
  res.json({ match: await matches.cancelMatch(actorOf(req), matchId, reason, releaseBooking) });
};

export const complete = async (req: Request, res: Response) => {
  res.json({ match: await matches.completeMatch(actorOf(req), valid(req, 'params', matchIdParams).matchId) });
};
