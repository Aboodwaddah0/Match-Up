import { prisma } from '../../lib/prisma';

/** Seeded reference data (sign-up screens, filters, venue forms), alphabetical by English name. */
export function listCities() {
  return prisma.city.findMany({
    orderBy: { nameEn: 'asc' },
    select: { id: true, nameAr: true, nameEn: true, timezone: true },
  });
}
