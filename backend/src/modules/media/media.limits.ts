import type { MediaKind } from '@prisma/client';

/**
 * Media rules in one place. The database repeats them as CHECK constraints and triggers (migration 20261124000200_media_items), so a bug here
 * can never store a file that breaks a rule; keep both in step (tests/media-constraints.test.ts compares them).
 */
export const MEDIA_LIMITS = {
  photoBytes: 10 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  videoMs: 60_000,
  perPlayer: 30,
  perTeam: 50,
  captionChars: 300,
} as const;

/** Declared (client-chosen) type -> kind and the file formats Cloudinary may report for it. The ORIGINAL type is kept: HEIC stays image/heic. */
export const SUPPORTED_MIME = {
  'image/jpeg': { kind: 'PHOTO', formats: ['jpg', 'jpeg'] },
  'image/png': { kind: 'PHOTO', formats: ['png'] },
  'image/webp': { kind: 'PHOTO', formats: ['webp'] },
  'image/heic': { kind: 'PHOTO', formats: ['heic'] },
  'video/mp4': { kind: 'VIDEO', formats: ['mp4'] },
  'video/quicktime': { kind: 'VIDEO', formats: ['mov'] },
} as const satisfies Record<string, { kind: MediaKind; formats: readonly string[] }>;

export type SupportedMime = keyof typeof SUPPORTED_MIME;
export const SUPPORTED_MIME_TYPES = Object.keys(SUPPORTED_MIME) as [SupportedMime, ...SupportedMime[]];

/** The file format the PROVIDER reports -> the MIME type we store (and the kind it must belong to). */
export function mimeForFormat(format: string): { mime: SupportedMime; kind: MediaKind } | null {
  const f = format.toLowerCase();
  for (const mime of SUPPORTED_MIME_TYPES) {
    const entry = SUPPORTED_MIME[mime];
    if ((entry.formats as readonly string[]).includes(f)) return { mime, kind: entry.kind };
  }
  return null;
}

/** Formats a signed upload may use for one kind (sent to Cloudinary as allowed_formats and signed, so the client cannot change them). */
export function allowedFormats(kind: MediaKind): string[] {
  return SUPPORTED_MIME_TYPES.filter((m) => SUPPORTED_MIME[m].kind === kind).flatMap((m) => [...SUPPORTED_MIME[m].formats]);
}

export const maxBytes = (kind: MediaKind): number => (kind === 'PHOTO' ? MEDIA_LIMITS.photoBytes : MEDIA_LIMITS.videoBytes);

/** Where the file must be stored at the provider: a photo is an "image" resource, a video a "video" resource. */
export const resourceTypeFor = (kind: MediaKind): 'image' | 'video' => (kind === 'PHOTO' ? 'image' : 'video');
