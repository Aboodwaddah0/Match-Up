import { prisma } from '../../lib/prisma';

/** True when the database answers a trivial query (readiness check). */
export async function isDatabaseUp(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
