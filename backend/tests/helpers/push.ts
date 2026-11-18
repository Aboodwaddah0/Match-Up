import { randomBytes, randomUUID } from 'node:crypto';
import type { ExpoMessage, ExpoReceipt, ExpoTicket, PushClient } from '../../src/lib/expo-push';
import { ExpoRequestError } from '../../src/lib/expo-push';

export const prismaP = async () => (await import('../../src/lib/prisma')).prisma;
export const pushWorker = () => import('../../src/jobs/push-worker');
export const coordination = () => import('../../src/jobs/push-coordination');

/** A syntactically valid Expo push token, unique per call. */
export const expoToken = () => `ExponentPushToken[${randomBytes(12).toString('base64url')}]`;

/** A user with a locale and (optionally) devices. Created directly: registration through the API is not what these tests are about. */
export async function pushUser(email: string, opts: { locale?: 'ar' | 'en'; devices?: number; status?: 'ACTIVE' | 'SUSPENDED' | 'DELETED' } = {}) {
  const prisma = await prismaP();
  const user = await prisma.user.create({
    data: { email, passwordHash: 'x', fullName: `Player ${email.split('@')[0]}`, locale: opts.locale ?? 'en', status: opts.status ?? 'ACTIVE' },
  });
  const tokens: { id: string; token: string }[] = [];
  for (let i = 0; i < (opts.devices ?? 1); i++) tokens.push(await addDevice(user.id));
  return { userId: user.id, tokens };
}

export async function addDevice(userId: string, token = expoToken(), platform = 'android') {
  const d = await (await prismaP()).deviceToken.create({ data: { userId, token, platform } });
  return { id: d.id, token: d.token };
}

/** A notification that has NOT been fanned out yet (what notify() writes). */
export async function addNotification(userId: string, type: string, params: Record<string, unknown> = { matchId: randomUUID(), title: 'Friday 7v7' }, over: { createdAgoHours?: number } = {}) {
  const prisma = await prismaP();
  const n = await prisma.notification.create({ data: { userId, type, params: params as never, resourceType: 'match', resourceId: randomUUID() } });
  if (over.createdAgoHours) {
    await prisma.$executeRawUnsafe(`UPDATE notification SET created_at = now() - interval '${over.createdAgoHours} hours' WHERE id = '${n.id}'`);
  }
  return n;
}

export async function deliveries(where = '') {
  const prisma = await prismaP();
  return prisma.$queryRawUnsafe<
    { id: string; notification_id: string; user_id: string; device_token_id: string | null; expo_token: string | null; status: string; attempts: number; next_attempt_at: Date; ticket_id: string | null; ticket_at: Date | null; next_receipt_at: Date | null; receipt_attempts: number; last_error: string | null; claim_id: string | null; locked_until: Date | null; receipt_claim_id: string | null; receipt_locked_until: Date | null }[]
  >(`SELECT * FROM push_delivery ${where} ORDER BY created_at, id`);
}

export const deliveryOf = async (id: string) => (await deliveries(`WHERE id = '${id}'`))[0]!;

export async function sql(statement: string) {
  return (await prismaP()).$executeRawUnsafe(statement);
}

/** What a fake Expo does. Programmable per test. */
export function fakeExpo() {
  const sent: ExpoMessage[] = [];
  /** Every send REQUEST, including the ones that failed: its size and the time it arrived. */
  const sendAttempts: { size: number; at: number }[] = [];
  const sendCalls: ExpoMessage[][] = [];
  const receiptCalls: string[][] = [];
  const ticketOwner = new Map<string, ExpoMessage>();
  let counter = 0;
  const state = {
    sendError: null as ExpoRequestError | null,
    receiptError: null as ExpoRequestError | null,
    ticketErrors: new Map<string, string>(), // device token -> ticket error code
    receipts: new Map<string, ExpoReceipt | undefined>(), // ticket id -> receipt (undefined = not available)
    receiptsAvailable: true, // false: no receipts at all yet
    sendDelayMs: 0,
    beforeSend: null as null | ((messages: ExpoMessage[]) => Promise<void>),
    beforeReceipts: null as null | ((ids: string[]) => Promise<void>),
  };
  const client: PushClient = {
    async send(messages) {
      sendAttempts.push({ size: messages.length, at: performance.now() });
      if (state.beforeSend) await state.beforeSend(messages);
      if (state.sendDelayMs) await new Promise((r) => setTimeout(r, state.sendDelayMs));
      if (state.sendError) throw state.sendError;
      sendCalls.push(messages);
      return messages.map((m): ExpoTicket => {
        sent.push(m);
        const error = state.ticketErrors.get(m.to);
        if (error) return { status: 'error', message: 'secret details that must never be stored', details: { error } };
        const id = `ticket-${++counter}-${randomUUID().slice(0, 8)}`;
        ticketOwner.set(id, m);
        return { status: 'ok', id };
      });
    },
    async getReceipts(ids) {
      receiptCalls.push(ids);
      if (state.beforeReceipts) await state.beforeReceipts(ids);
      if (state.receiptError) throw state.receiptError;
      const out: Record<string, ExpoReceipt> = {};
      for (const id of ids) {
        if (state.receipts.has(id)) {
          const r = state.receipts.get(id);
          if (r) out[id] = r;
        } else if (state.receiptsAvailable) out[id] = { status: 'ok' };
      }
      return out;
    },
  };
  return { client, sent, sendAttempts, sendCalls, receiptCalls, ticketOwner, state };
}

export const authError = () => new ExpoRequestError('AUTH', 'UNAUTHORIZED', 401);
export const transientError = (code = 'HTTP_503') => new ExpoRequestError('TRANSIENT', code, 503);
export const rateLimitError = () => new ExpoRequestError('RATE_LIMIT', 'TOO_MANY_REQUESTS', 429);

/** Makes every waiting delivery due now (backoff and pauses are in the past). */
export const makeDue = () => sql(`UPDATE push_delivery SET next_attempt_at = now() - interval '1 second' WHERE status = 'PENDING'`);
export const makeReceiptsDue = () => sql(`UPDATE push_delivery SET next_receipt_at = now() - interval '1 second' WHERE status = 'ACCEPTED'`);

export async function channelState(channel: 'SEND' | 'RECEIPT') {
  const prisma = await prismaP();
  return (await prisma.pushProviderState.findUniqueOrThrow({ where: { channel } }));
}
