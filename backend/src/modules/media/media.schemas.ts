import { z } from 'zod';
import { MEDIA_LIMITS, SUPPORTED_MIME_TYPES } from './media.limits';

/** Optional caption: trimmed, at most 300 characters; an empty string means "no caption". */
const caption = z
  .string()
  .trim()
  .max(MEDIA_LIMITS.captionChars)
  .transform((v) => (v === '' ? null : v));

/**
 * Ask for an upload slot. `mimeType` and `sizeBytes` are what the CLIENT says (they only let us refuse an obviously unsupported or oversized file
 * before any slot is issued); the server verifies the real file with the provider when the upload is confirmed and keeps those figures, not these.
 */
export const uploadInitSchema = z.object({
  owner: z.discriminatedUnion('type', [z.object({ type: z.literal('PLAYER') }), z.object({ type: z.literal('TEAM'), teamId: z.uuid() })]),
  mimeType: z.enum(SUPPORTED_MIME_TYPES),
  sizeBytes: z.number().int().positive(),
  caption: caption.optional(),
});

export const mediaIdParams = z.object({ mediaId: z.uuid() });
export const mediaOwnerUserParams = z.object({ userId: z.uuid() });
export const mediaOwnerTeamParams = z.object({ teamId: z.uuid() });

/** Caption and display order. `caption: null` (or "") removes the caption. */
export const updateMediaSchema = z
  .object({
    caption: caption.nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((v) => v.caption !== undefined || v.sortOrder !== undefined, 'Send a caption or a sortOrder');
