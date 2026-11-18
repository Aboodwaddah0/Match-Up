import { z } from 'zod';

export const listSchema = z.object({
  unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const idParams = z.object({ id: z.uuid() });

/** What the Expo app gets from getExpoPushTokenAsync: ExponentPushToken[...] (also written ExpoPushToken[...]). */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,100}\]$/;

/**
 * Registers a PUSH token (this table holds push tokens only; sessions are refresh tokens, so refusing other kinds of tokens here
 * cannot affect any login). The format check only filters junk: the real registration is the app asking Expo for a token with the
 * project id (see README). Expo push is for Android and iOS; web push tokens are not accepted.
 */
export const deviceSchema = z.object({
  token: z.string().trim().regex(EXPO_PUSH_TOKEN, 'must be an Expo push token, e.g. ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'),
  platform: z.enum(['ios', 'android'], { error: 'push notifications are supported on iOS and Android only' }),
});
