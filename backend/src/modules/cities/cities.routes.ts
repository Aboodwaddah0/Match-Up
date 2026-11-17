import { Router } from 'express';
import { prisma } from '../../lib/prisma';

export const citiesRouter = Router();

// Public reference data (used by sign-up screens, filters, venue forms).
citiesRouter.get('/', async (_req, res) => {
  const cities = await prisma.city.findMany({
    orderBy: { nameEn: 'asc' },
    select: { id: true, nameAr: true, nameEn: true, timezone: true },
  });
  res.json({ cities });
});
