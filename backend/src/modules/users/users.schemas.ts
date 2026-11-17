import { z } from 'zod';

/** PATCH /users/me: account basics. E-mail and password have their own flows (auth module). */
export const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    avatarUrl: z.url().refine((u) => u.startsWith('https://'), 'Avatar must be an https URL').nullable(),
    locale: z.enum(['ar', 'en']),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown IANA time zone'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field');
