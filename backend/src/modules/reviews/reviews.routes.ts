import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { createReview, createReviewSchema, listPlayerReviews, listReviewsSchema, pendingReviews } from './reviews.service';

const actor = (req: { auth?: { userId: string; role: 'USER' | 'ADMIN' } }) => ({ userId: req.auth!.userId, role: req.auth!.role });

// /api/v1/matches/:matchId/reviews
export const matchReviewsRouter = Router({ mergeParams: true });
matchReviewsRouter.use(authenticate);
const matchParams = z.object({ matchId: z.uuid() });

matchReviewsRouter.post('/', requireVerifiedEmail, async (req, res) => {
  const { matchId } = matchParams.parse(req.params);
  res.status(201).json(await createReview(actor(req), matchId, createReviewSchema.parse(req.body)));
});
matchReviewsRouter.get('/pending', async (req, res) => {
  const { matchId } = matchParams.parse(req.params);
  res.json(await pendingReviews(actor(req), matchId));
});

// /api/v1/players/:userId/reviews
export const playerReviewsRouter = Router({ mergeParams: true });
playerReviewsRouter.use(authenticate);
playerReviewsRouter.get('/', async (req, res) => {
  const { userId } = z.object({ userId: z.uuid() }).parse(req.params);
  res.json(await listPlayerReviews(actor(req), userId, listReviewsSchema.parse(req.query)));
});
