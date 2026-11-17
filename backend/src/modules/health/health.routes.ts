import { Router } from 'express';
import { prisma } from '../../lib/prisma';

export const healthRouter = Router();

// Liveness: the process is up. Used by the container healthcheck.
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: the database answers.
healthRouter.get('/health/db', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'up' });
  } catch {
    res.status(503).json({ status: 'error', database: 'down' });
  }
});
