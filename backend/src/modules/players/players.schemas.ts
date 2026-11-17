import { z } from 'zod';

const position = z.enum(['GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'WINGER', 'STRIKER']);

function ageOn(dateIso: string): number {
  const dob = new Date(dateIso);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** PUT = replace: omitted optional fields are cleared. */
export const upsertProfileSchema = z
  .object({
    positions: z
      .array(position)
      .min(1, 'Choose at least one position')
      .max(5)
      .refine((a) => new Set(a).size === a.length, 'Positions must be unique'),
    primaryPosition: position,
    skillLevel: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL']),
    preferredFoot: z.enum(['RIGHT', 'LEFT', 'BOTH']).nullish(),
    dateOfBirth: z
      .iso.date()
      .refine((d) => ageOn(d) >= 10 && ageOn(d) <= 100, 'Date of birth must give an age between 10 and 100')
      .nullish(),
    bio: z.string().trim().max(500).nullish(),
    cityId: z.uuid().nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
  })
  .refine((v) => v.positions.includes(v.primaryPosition), {
    path: ['primaryPosition'],
    message: 'Primary position must be one of the selected positions',
  })
  .refine((v) => (v.latitude == null) === (v.longitude == null), {
    path: ['latitude'],
    message: 'Send latitude and longitude together',
  });

export const playerIdParams = z.object({ userId: z.uuid() });
