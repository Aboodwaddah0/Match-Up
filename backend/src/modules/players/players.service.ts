import type { City, PlayerPosition, PlayerProfile, User } from '@prisma/client';
import { z } from 'zod';
import { areBlocked } from '../../lib/blocks';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { upsertProfileSchema } from './players.schemas';

type ProfileRow = PlayerProfile & { positions: PlayerPosition[]; city: City | null; user: User };

const include = { positions: true, city: true, user: true } as const;

function ageFrom(dob: Date | null): number | null {
  if (!dob) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  if (now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/**
 * Match history stats are DERIVED from participant rows (never stored).
 * D16: a match that ended CANCELLED or CLOSED_UNCONFIRMED ("unknown whether it happened") produces no stats and no
 * reliability change, so late cancellations and no-shows on such matches are not counted. Every other status counts
 * (a late cancellation is counted as soon as the player leaves). If an organizer later recovers a CLOSED_UNCONFIRMED
 * match and completes it, its rows start counting again, because the filter looks at the match's CURRENT status.
 * `matchesPlayed` needs no filter: ATTENDED is only ever set when the match is COMPLETED.
 */
export async function statsFor(userId: string) {
  const counts: { match: { status: { notIn: ('CANCELLED' | 'CLOSED_UNCONFIRMED')[] } } } = { match: { status: { notIn: ['CANCELLED', 'CLOSED_UNCONFIRMED'] } } };
  const [matchesPlayed, lateCancellations, noShows] = await Promise.all([
    prisma.matchParticipant.count({ where: { userId, status: 'CONFIRMED', attendanceStatus: 'ATTENDED' } }),
    prisma.matchParticipant.count({ where: { userId, isLateCancellation: true, ...counts } }),
    prisma.matchParticipant.count({ where: { userId, attendanceStatus: 'NO_SHOW', ...counts } }),
  ]);
  return { matchesPlayed, lateCancellations, noShows };
}

/** Objective reliability (0-100), derived from organizer-confirmed attendance, never from reviewer opinion. A no-show weighs double a late cancellation; null until there is history. */
export function reliabilityFrom(s: { matchesPlayed: number; lateCancellations: number; noShows: number }): number | null {
  const denominator = s.matchesPlayed + 2 * s.noShows + s.lateCancellations;
  return denominator === 0 ? null : Math.round((s.matchesPlayed / denominator) * 10000) / 100;
}

function base(p: ProfileRow) {
  return {
    userId: p.userId,
    fullName: p.user.fullName,
    avatarUrl: p.user.avatarUrl,
    bio: p.bio,
    city: p.city ? { id: p.city.id, nameAr: p.city.nameAr, nameEn: p.city.nameEn } : null,
    positions: p.positions.map((x) => x.position).sort(),
    primaryPosition: p.primaryPosition,
    preferredFoot: p.preferredFoot,
    skillLevel: p.skillLevel,
    // Cache kept in step by the reviews module (average of the three review scores). Reliability is derived on read (toPublic).
    rating: { average: p.ratingAvg === null ? null : Number(p.ratingAvg), count: p.ratingCount },
    reliabilityScore: null as number | null,
  };
}

/** What other players see: no birth date, no exact coordinates, no e-mail. */
async function toPublic(p: ProfileRow) {
  const stats = await statsFor(p.userId);
  return { ...base(p), reliabilityScore: reliabilityFrom(stats), age: ageFrom(p.dateOfBirth), stats };
}

/** What the owner sees: includes birth date and the location they saved. */
async function toSelf(p: ProfileRow) {
  return {
    ...(await toPublic(p)),
    dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null,
    latitude: p.latitude,
    longitude: p.longitude,
  };
}

/** The caller's own profile, including birth date and saved location. 404 until they create one. */
export async function getMyProfile(userId: string) {
  const p = await prisma.playerProfile.findUnique({ where: { userId }, include });
  if (!p) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Create your player profile first');
  return toSelf(p);
}

/** Creates or fully replaces the caller's profile (idempotent PUT): positions, primary position, skill level, location. */
export async function upsertMyProfile(userId: string, input: z.infer<typeof upsertProfileSchema>) {
  if (input.cityId && !(await prisma.city.findUnique({ where: { id: input.cityId } }))) {
    throw new AppError(400, 'INVALID_CITY', 'Unknown city');
  }

  const data = {
    dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
    bio: input.bio ?? null,
    cityId: input.cityId ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    primaryPosition: input.primaryPosition,
    skillLevel: input.skillLevel,
    preferredFoot: input.preferredFoot ?? null,
  };

  // One transaction: profile + positions change together. "Primary position is one of the
  // selected positions" is re-checked by a deferred DB constraint at COMMIT.
  await prisma.$transaction(async (tx) => {
    const profile = await tx.playerProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    await tx.playerPosition.deleteMany({ where: { playerProfileId: profile.id } });
    await tx.playerPosition.createMany({
      data: input.positions.map((position) => ({ playerProfileId: profile.id, position })),
    });
  });

  return getMyProfile(userId);
}

/** What other players see (no birth date, coordinates or e-mail). A profile of a user with a block either way is 404. */
export async function getPublicProfile(viewerId: string, targetUserId: string) {
  const p = await prisma.playerProfile.findUnique({ where: { userId: targetUserId }, include });
  const notFound = new AppError(404, 'PLAYER_NOT_FOUND', 'Player not found');
  if (!p || p.user.status !== 'ACTIVE') throw notFound;

  if (viewerId !== targetUserId) {
    const blocked = await areBlocked(viewerId, targetUserId);
    if (blocked) throw notFound; // indistinguishable from "does not exist"
  }
  return toPublic(p);
}
