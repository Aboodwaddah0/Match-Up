import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import { createReviewSchema, listReviewsSchema, matchParams, playerParams } from './reviews.schemas';
import * as reviews from './reviews.service';

export const create = async (req: Request, res: Response) => {
  const { matchId } = valid(req, 'params', matchParams);
  res.status(201).json(await reviews.createReview(actorOf(req), matchId, valid(req, 'body', createReviewSchema)));
};

export const pending = async (req: Request, res: Response) => {
  res.json(await reviews.pendingReviews(actorOf(req), valid(req, 'params', matchParams).matchId));
};

export const listForPlayer = async (req: Request, res: Response) => {
  const { userId } = valid(req, 'params', playerParams);
  res.json(await reviews.listPlayerReviews(actorOf(req), userId, valid(req, 'query', listReviewsSchema)));
};
