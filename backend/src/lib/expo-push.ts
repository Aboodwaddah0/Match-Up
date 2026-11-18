import { env } from '../config/env';

/*
 * Minimal client for the Expo Push Service (NOTIF-01), on Node's built-in fetch (no SDK).
 *   send:        POST {base}/--/api/v2/push/send        up to 100 messages, answer: one ticket per message, in order
 *   getReceipts: POST {base}/--/api/v2/push/getReceipts up to 1000 ticket ids, answer: receipts by id (missing = not available)
 * A ticket means "Expo received it", a receipt means "Expo handed it to Apple / Google". Only a receipt tells more.
 *
 * Secrets: the access token is sent only as the Authorization header (when configured) and is never part of an error,
 * a log line or a message. Errors carry a short code and the HTTP status, never a body.
 */

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  ttl: number;
  priority: 'high';
  sound: 'default';
  /** Duplicate REDUCTION on the device (maps to FCM collapse_key / apns-collapse-id). Not an idempotency guarantee. */
  collapseId: string;
  /** Android: replaces an already displayed notification with the same tag. */
  tag: string;
}

export type ExpoTicket = { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } };
export type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

/**
 *  AUTH        Expo rejected our credentials (error code UNAUTHORIZED, or HTTP 401 / 403: the status for this is not documented).
 *  RATE_LIMIT  too many requests (code TOO_MANY_REQUESTS or HTTP 429).
 *  TRANSIENT   anything else that may work later: timeouts, network errors, HTTP 5xx and other failures, an unusable answer.
 */
export type ExpoFailureKind = 'AUTH' | 'RATE_LIMIT' | 'TRANSIENT';

export class ExpoRequestError extends Error {
  constructor(
    readonly kind: ExpoFailureKind,
    /** Short, content-free code (e.g. UNAUTHORIZED, HTTP_503, TIMEOUT). */
    readonly code: string,
    readonly httpStatus?: number,
  ) {
    super(`expo request failed: ${code}`);
    this.name = 'ExpoRequestError';
  }
}

export interface PushClient {
  send(messages: ExpoMessage[]): Promise<ExpoTicket[]>;
  getReceipts(ids: string[]): Promise<Record<string, ExpoReceipt>>;
}

/** Per request. An object so a test can shorten it. */
export const expoTimeouts = { requestMs: 20_000 };

async function post(path: 'send' | 'getReceipts', body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;

  let res: Response;
  try {
    res = await fetch(`${env.EXPO_API_BASE_URL}/--/api/v2/push/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(expoTimeouts.requestMs),
    });
  } catch (err) {
    throw new ExpoRequestError('TRANSIENT', (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
  }

  const json = await res.json().then(
    (v: unknown) => v as { data?: unknown; errors?: { code?: unknown }[] } | null,
    () => null,
  );
  const codes = Array.isArray(json?.errors) ? json.errors.map((e) => e?.code).filter((c): c is string => typeof c === 'string') : [];

  if (codes.includes('UNAUTHORIZED') || res.status === 401 || res.status === 403) {
    throw new ExpoRequestError('AUTH', codes.includes('UNAUTHORIZED') ? 'UNAUTHORIZED' : `HTTP_${res.status}`, res.status);
  }
  if (codes.includes('TOO_MANY_REQUESTS') || res.status === 429) throw new ExpoRequestError('RATE_LIMIT', 'TOO_MANY_REQUESTS', res.status);
  if (!res.ok) throw new ExpoRequestError('TRANSIENT', `HTTP_${res.status}`, res.status);
  if (codes.length > 0) throw new ExpoRequestError('TRANSIENT', `EXPO_${codes[0]!.slice(0, 40)}`, res.status);
  return json?.data;
}

export const expoClient: PushClient = {
  async send(messages) {
    const data = await post('send', messages);
    // One ticket per message, in order. Anything else is unusable: do not guess which message got which ticket.
    if (!Array.isArray(data) || data.length !== messages.length || data.some((t) => typeof t?.status !== 'string')) {
      throw new ExpoRequestError('TRANSIENT', 'BAD_RESPONSE');
    }
    return data as ExpoTicket[];
  },

  async getReceipts(ids) {
    const data = await post('getReceipts', { ids });
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ExpoRequestError('TRANSIENT', 'BAD_RESPONSE');
    return data as Record<string, ExpoReceipt>;
  },
};
