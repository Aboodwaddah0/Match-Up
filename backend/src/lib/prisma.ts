import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

// One client per process. Triggers in the DB raise FYM_* errors; services map them (see prisma/README.md).
export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
