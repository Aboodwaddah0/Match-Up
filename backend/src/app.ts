import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { authRouter } from './modules/auth/auth.routes';
import { bookingsRouter, venueBookingsRouter } from './modules/bookings/bookings.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { chatRouter } from './modules/chat/chat.routes';
import { citiesRouter } from './modules/cities/cities.routes';
import { healthRouter } from './modules/health/health.routes';
import { matchesRouter } from './modules/matches/matches.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { matchReviewsRouter, playerReviewsRouter } from './modules/reviews/reviews.routes';
import { adminReportsRouter, blocksRouter as userBlocksRouter, reportsRouter } from './modules/safety/safety.routes';
import { playersRouter } from './modules/players/players.routes';
import { challengesRouter, teamsRouter } from './modules/teams/teams.routes';
import { usersRouter } from './modules/users/users.routes';
import { blocksRouter, fieldsRouter, venuesRouter } from './modules/venues/venues.routes';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.use(healthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/users/me/blocks', userBlocksRouter);
  app.use('/api/v1/chats', chatRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/admin/reports', adminReportsRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/players', playersRouter);
  app.use('/api/v1/cities', citiesRouter);
  app.use('/api/v1/matches/:matchId/reviews', matchReviewsRouter);
  app.use('/api/v1/players/:userId/reviews', playerReviewsRouter);
  app.use('/api/v1/matches', matchesRouter);
  app.use('/api/v1/venues/:venueId/bookings', venueBookingsRouter);
  app.use('/api/v1/venues', venuesRouter);
  app.use('/api/v1/fields', fieldsRouter);
  app.use('/api/v1/blocks', blocksRouter);
  app.use('/api/v1/bookings', bookingsRouter);
  app.use('/api/v1/teams', teamsRouter);
  app.use('/api/v1/challenges', challengesRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  // Next modules mount here: reviews ...

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
