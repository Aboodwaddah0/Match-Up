import { Router } from 'express';
import * as health from './health.controller';

export const healthRouter = Router();

healthRouter.get('/health', health.liveness);
healthRouter.get('/health/db', health.readiness);
