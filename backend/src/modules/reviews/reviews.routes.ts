import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as reviews from './reviews.controller';
import { createReviewSchema, listReviewsSchema, matchParams, playerParams } from './reviews.schemas';

// /api/v1/matches/:matchId/reviews
export const matchReviewsRouter = Router({ mergeParams: true });
matchReviewsRouter.use(authenticate);
matchReviewsRouter.post('/', requireVerifiedEmail, validate({ params: matchParams, body: createReviewSchema }), reviews.create);
matchReviewsRouter.get('/pending', validate({ params: matchParams }), reviews.pending);

// /api/v1/players/:userId/reviews
export const playerReviewsRouter = Router({ mergeParams: true });
playerReviewsRouter.use(authenticate);
playerReviewsRouter.get('/', validate({ params: playerParams, query: listReviewsSchema }), reviews.listForPlayer);
