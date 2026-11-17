import type { Request, Response } from 'express';
import * as health from './health.service';

/** Liveness: the process is up. Used by the container healthcheck. */
export const liveness = (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
};

/** Readiness: the database answers; 503 otherwise. */
export const readiness = async (_req: Request, res: Response) => {
  if (await health.isDatabaseUp()) res.json({ status: 'ok', database: 'up' });
  else res.status(503).json({ status: 'error', database: 'down' });
};
