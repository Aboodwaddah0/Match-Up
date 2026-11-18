import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from './helpers/client';
import { addDevice, addNotification, authError as _auth, deliveries, deliveryOf, fakeExpo, makeDue, makeReceiptsDue, prismaP, pushUser, pushWorker, sql, transientError } from './helpers/push';

void _auth;

beforeAll(async () => {
  // no HTTP server needed: the worker is driven directly
});
afterAll(async () => {
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

const run = async (fake: ReturnType<typeof fakeExpo>, over: Record<string, unknown> = {}) => (await pushWorker()).runPushWorkerOnce({ client: fake.client, ...over });

/** One user, one device, one pushable notification, fanned out and ready. */
async function oneDelivery(over: { locale?: 'ar' | 'en'; type?: string; params?: Record<string, unknown> } = {}) {
  const u = await pushUser(`u${Math.random().toString(36).slice(2, 8)}@example.com`, { locale: over.locale });
  const n = await addNotification(u.userId, over.type ?? 'MATCH_REQUEST_RECEIVED', over.params ?? { matchId: 'm1', title: 'Friday 7v7' });
  return { u, n, device: u.tokens[0]! };
}

describe('sending', () => {
  it('fans out, sends in the user\'s language, records the TICKET (not a delivery) and does not send again', async () => {
    const { n, device } = await oneDelivery();
    const fake = fakeExpo();
    const r = await run(fake);
    expect(r).toMatchObject({ notificationsFannedOut: 1, deliveriesCreated: 1, accepted: 1 });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ to: device.token, title: 'New join request', body: 'A player asked to join "Friday 7v7"', collapseId: n.id, tag: n.id, ttl: 86_400, priority: 'high' });
    const [d] = await deliveries();
    expect(d).toMatchObject({ status: 'ACCEPTED', attempts: 1, receipt_attempts: 0 });
    expect(d!.ticket_id).toBeTruthy();
    expect(d!.expo_token).toBe(device.token); // still needed to act on the receipt
    const wait = d!.next_receipt_at!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(14 * 60_000);
    expect(wait).toBeLessThan(16 * 60_000); // first receipt check after 15 minutes, as Expo recommends

    await run(fake);
    expect(fake.sent).toHaveLength(1); // nothing is sent twice
  });

  it('an Arabic-speaking user gets the Arabic text', async () => {
    await oneDelivery({ locale: 'ar' });
    const fake = fakeExpo();
    await run(fake);
    expect(fake.sent[0]!.title).toBe('طلب انضمام جديد');
    expect(fake.sent[0]!.body).toContain('Friday 7v7');
  });

  it('sends in batches of at most 100 messages', async () => {
    const u = await pushUser('bulk@example.com', { devices: 1 });
    for (let i = 0; i < 250; i++) await addNotification(u.userId, 'MATCH_CANCELLED', { title: `Game ${i}` });
    const fake = fakeExpo();
    await run(fake, { rate: { perSecond: 1000, capacity: 1000 } });
    expect(fake.sendCalls.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(await deliveries(`WHERE status = 'ACCEPTED'`)).toHaveLength(250);
  });

  it('a ticket error DeviceNotRegistered fails the delivery, deletes that device token and cancels its other waiting pushes', async () => {
    const prisma = await prismaP();
    const u = await pushUser('gone@example.com', { devices: 1 });
    const device = u.tokens[0]!;
    await addNotification(u.userId, 'MATCH_CANCELLED', { title: 'A' });
    const waiting = await addNotification(u.userId, 'MATCH_INVITATION', { title: 'B' });
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 }); // fan-out only: two deliveries for the same device
    await sql(`UPDATE push_delivery SET next_attempt_at = now() + interval '1 hour' WHERE notification_id = '${waiting.id}'`); // B is not due yet
    fake.state.ticketErrors.set(device.token, 'DeviceNotRegistered');
    await run(fake);
    const rows = await deliveries();
    expect(rows.map((d) => d.status).sort()).toEqual(['CANCELLED', 'FAILED']);
    expect(rows.find((d) => d.status === 'FAILED')!.last_error).toBe('DeviceNotRegistered');
    expect(rows.find((d) => d.status === 'CANCELLED')!.last_error).toBe('DEVICE_REMOVED');
    expect(await prisma.deviceToken.count({ where: { id: device.id } })).toBe(0);
    expect(rows.every((d) => d.expo_token === null)).toBe(true);
  });

  it.each(['MessageTooBig', 'MismatchSenderId', 'InvalidCredentials'])('a ticket error %s is a terminal, visible failure with its code (no retry)', async (code) => {
    const { device } = await oneDelivery();
    const fake = fakeExpo();
    fake.state.ticketErrors.set(device.token, code);
    const r = await run(fake);
    expect(r).toMatchObject({ failed: 1, retried: 0 });
    expect(await deliveries()).toMatchObject([{ status: 'FAILED', last_error: code, expo_token: null }]);
  });

  it('an unknown ticket error is retried (limited), not treated as terminal at once', async () => {
    const { device } = await oneDelivery();
    const fake = fakeExpo();
    fake.state.ticketErrors.set(device.token, 'SomethingNew');
    expect(await run(fake)).toMatchObject({ retried: 1, failed: 0 });
    expect(await deliveries()).toMatchObject([{ status: 'PENDING', attempts: 1, last_error: 'TICKET_SomethingNew' }]);
  });

  it('a transient failure is retried with backoff up to the attempt limit, then ends FAILED with the secrets wiped', async () => {
    await oneDelivery();
    const fake = fakeExpo();
    fake.state.sendError = transientError('HTTP_503');
    const { MAX_ATTEMPTS } = await pushWorker();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await run(fake);
      expect(r).toMatchObject({ retried: 1, failed: 0 });
      const d = (await deliveries())[0]!;
      expect(d).toMatchObject({ status: 'PENDING', attempts: attempt, last_error: 'HTTP_503', claim_id: null, locked_until: null });
      expect(d.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 5_000); // backed off
      expect(await run(fake)).toMatchObject({ retried: 0, accepted: 0 }); // not due yet: not claimed
      await makeDue();
    }
    expect(await run(fake)).toMatchObject({ failed: 1 });
    expect(await deliveries()).toMatchObject([{ status: 'FAILED', attempts: MAX_ATTEMPTS, last_error: 'HTTP_503', expo_token: null }]);
    expect(await run(fake)).toMatchObject({ retried: 0, failed: 0 }); // terminal: never picked up again
  });

  it('backoff grows, is jittered within +-20 % and repeats its last step', async () => {
    const { sendBackoffMs, SEND_BACKOFF_MS } = await pushWorker();
    for (let attempt = 1; attempt <= SEND_BACKOFF_MS.length + 2; attempt++) {
      const base = SEND_BACKOFF_MS[Math.min(attempt, SEND_BACKOFF_MS.length) - 1]!;
      expect(sendBackoffMs(attempt, () => 0)).toBe(Math.round(base * 0.8));
      expect(sendBackoffMs(attempt, () => 1)).toBe(Math.round(base * 1.2));
    }
    expect(SEND_BACKOFF_MS).toEqual([...SEND_BACKOFF_MS].sort((a, b) => a - b));
  });
});

describe('concurrency and crashes', () => {
  it('concurrent workers send every delivery exactly once', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => pushUser(`cw${i}@example.com`, { devices: 2 })));
    for (let i = 0; i < 30; i++) await addNotification(users[i % 6]!.userId, 'MATCH_CANCELLED', { title: `G${i}` });
    const fake = fakeExpo();
    fake.state.sendDelayMs = 20;
    const results = await Promise.all([1, 2, 3, 4].map(() => run(fake, { rate: { perSecond: 5000, capacity: 5000 } })));
    expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(60);
    const counts = new Map<string, number>();
    for (const m of fake.sent) counts.set(`${m.to}|${m.collapseId}`, (counts.get(`${m.to}|${m.collapseId}`) ?? 0) + 1);
    expect(counts.size).toBe(60);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    expect((await deliveries()).every((d) => d.status === 'ACCEPTED' && d.attempts === 1)).toBe(true);
  });

  it('a delivery left SENDING by a dead worker is untouched while its lease lives and claimed again when it has expired', async () => {
    const { device } = await oneDelivery();
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 }); // fan-out only
    const [d] = await deliveries();
    await sql(`UPDATE push_delivery SET status = 'SENDING', claim_id = gen_random_uuid(), locked_until = now() + interval '1 minute', attempts = 1 WHERE id = '${d!.id}'`);
    expect(await run(fake)).toMatchObject({ accepted: 0 });
    expect(fake.sent).toHaveLength(0);
    await sql(`UPDATE push_delivery SET locked_until = now() - interval '1 second' WHERE id = '${d!.id}'`);
    expect(await run(fake)).toMatchObject({ accepted: 1 });
    expect(fake.sent[0]!.to).toBe(device.token);
    expect(await deliveryOf(d!.id)).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
  });

  it('a delivery that keeps killing its worker ends FAILED (WORKER_CRASHED) after the attempt limit', async () => {
    await oneDelivery();
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 });
    const [d] = await deliveries();
    const { MAX_ATTEMPTS } = await pushWorker();
    await sql(`UPDATE push_delivery SET status = 'SENDING', claim_id = gen_random_uuid(), locked_until = now() - interval '1 second', attempts = ${MAX_ATTEMPTS} WHERE id = '${d!.id}'`);
    expect(await run(fake)).toMatchObject({ failed: 1, accepted: 0 });
    expect(fake.sent).toHaveLength(0);
    expect(await deliveryOf(d!.id)).toMatchObject({ status: 'FAILED', last_error: 'WORKER_CRASHED', expo_token: null });
  });

  it('a worker whose lease expired mid-send cannot overwrite the worker that took over (the possible duplicate is the documented at-least-once case)', async () => {
    await oneDelivery();
    const slow = fakeExpo();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    slow.state.beforeSend = async () => {
      await gate; // the slow worker is stuck inside the HTTP call
    };
    const slowRun = run(slow);
    for (let i = 0; i < 100 && (await deliveries(`WHERE status = 'SENDING'`)).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const [d] = await deliveries();
    expect(d!.status).toBe('SENDING');
    await sql(`UPDATE push_delivery SET locked_until = now() - interval '1 second' WHERE id = '${d!.id}'`); // its lease runs out

    const fast = fakeExpo();
    expect(await run(fast)).toMatchObject({ accepted: 1 });
    const ticketOfFast = (await deliveryOf(d!.id)).ticket_id;
    expect(ticketOfFast).toBeTruthy();

    release();
    const late = await slowRun;
    expect(late).toMatchObject({ accepted: 0, lostClaim: 1 }); // its ticket was NOT recorded
    expect(await deliveryOf(d!.id)).toMatchObject({ status: 'ACCEPTED', attempts: 2, ticket_id: ticketOfFast });
    expect(slow.sent[0]!.collapseId).toBe(fast.sent[0]!.collapseId); // both copies carry the same collapse id: the device can merge them
  });
});

describe('a delivery is cancelled, never sent, when it should not go out any more', () => {
  const cancelledWith = async (reason: string) => expect((await deliveries()).map((d) => [d.status, d.last_error])).toEqual([['CANCELLED', reason]]);

  it('the device was removed before the send', async () => {
    const { device } = await oneDelivery();
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 });
    await sql(`DELETE FROM device_token WHERE id = '${device.id}'`); // SET NULL on the delivery
    expect(await run(fake)).toMatchObject({ cancelled: 1, accepted: 0 });
    expect(fake.sent).toHaveLength(0);
    await cancelledWith('DEVICE_REMOVED');
    expect((await deliveries())[0]!.expo_token).toBeNull();
  });

  it('the device token now belongs to someone else', async () => {
    const { device } = await oneDelivery();
    const other = await pushUser('newowner@example.com', { devices: 0 });
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 });
    await sql(`UPDATE device_token SET user_id = '${other.userId}' WHERE id = '${device.id}'`);
    await run(fake);
    expect(fake.sent).toHaveLength(0); // never delivered to the new owner
    await cancelledWith('DEVICE_CHANGED');
  });

  it('the device token string changed under the same device row', async () => {
    const { device } = await oneDelivery();
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 });
    await sql(`UPDATE device_token SET token = 'ExponentPushToken[replacedtoken123]' WHERE id = '${device.id}'`);
    await run(fake);
    expect(fake.sent).toHaveLength(0);
    await cancelledWith('DEVICE_CHANGED');
  });

  it('the user was suspended after fan-out', async () => {
    const { u } = await oneDelivery();
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 });
    await sql(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = '${u.userId}'`);
    await run(fake);
    expect(fake.sent).toHaveLength(0);
    await cancelledWith('USER_INELIGIBLE');
  });

  it('the notification is older than 24 hours when it comes to be sent', async () => {
    const { n } = await oneDelivery();
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 });
    await sql(`UPDATE notification SET created_at = now() - interval '25 hours' WHERE id = '${n.id}'`);
    const r = await run(fake);
    expect(r).toMatchObject({ cancelled: 1, staleNotifications: 1 });
    expect(fake.sent).toHaveLength(0);
    await cancelledWith('STALE');
  });

  it('a delivery for a type that is not pushed is cancelled (defense in depth)', async () => {
    const u = await pushUser('np@example.com');
    const n = await addNotification(u.userId, 'REVIEW_RECEIVED');
    await sql(`UPDATE notification SET push_fanout_at = now() WHERE id = '${n.id}'`);
    await sql(`INSERT INTO push_delivery (notification_id, user_id, device_token_id, expo_token) VALUES ('${n.id}', '${u.userId}', '${u.tokens[0]!.id}', '${u.tokens[0]!.token}')`);
    const fake = fakeExpo();
    await run(fake);
    expect(fake.sent).toHaveLength(0);
    await cancelledWith('NOT_PUSHABLE');
  });

  it('a device removed WHILE the push is being sent does not break anything: the ticket is recorded and the receipt cleans up', async () => {
    const prisma = await prismaP();
    const { device } = await oneDelivery();
    const fake = fakeExpo();
    fake.state.beforeSend = async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM device_token WHERE id = '${device.id}'`);
    };
    expect(await run(fake)).toMatchObject({ accepted: 1, failed: 0 });
    const [d] = await deliveries();
    expect(d).toMatchObject({ status: 'ACCEPTED', device_token_id: null });
    fake.state.receipts.set(d!.ticket_id!, { status: 'error', details: { error: 'DeviceNotRegistered' } });
    await makeReceiptsDue();
    expect(await run(fake)).toMatchObject({ failed: 1 });
    expect(await deliveryOf(d!.id)).toMatchObject({ status: 'FAILED', last_error: 'DeviceNotRegistered', expo_token: null });
  });
});

describe('receipts: a ticket is not a delivery', () => {
  async function accepted(fake: ReturnType<typeof fakeExpo>) {
    await oneDelivery();
    await run(fake);
    return (await deliveries())[0]!;
  }

  it('a receipt that says ok makes it DELIVERED, wipes the token, and nothing is sent again', async () => {
    const fake = fakeExpo();
    const d = await accepted(fake);
    expect(await run(fake)).toMatchObject({ delivered: 0 }); // not due yet: no receipt request
    expect(fake.receiptCalls).toHaveLength(0);
    await makeReceiptsDue();
    expect(await run(fake)).toMatchObject({ delivered: 1 });
    expect(fake.receiptCalls).toEqual([[d.ticket_id]]);
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'DELIVERED', expo_token: null, last_error: null });
    expect(fake.sent).toHaveLength(1);
  });

  it('an unavailable receipt is asked for again on a widening schedule, and ends UNCONFIRMED: not delivered, not failed', async () => {
    const fake = fakeExpo();
    fake.state.receiptsAvailable = false;
    const d = await accepted(fake);
    const { RECEIPT_OFFSETS_MIN } = await pushWorker();
    for (let k = 1; k < RECEIPT_OFFSETS_MIN.length; k++) {
      await makeReceiptsDue();
      await run(fake);
      const row = await deliveryOf(d.id);
      expect(row).toMatchObject({ status: 'ACCEPTED', receipt_attempts: k, ticket_id: d.ticket_id });
      const expected = d.ticket_at!.getTime() + RECEIPT_OFFSETS_MIN[k]! * 60_000;
      expect(Math.abs(row.next_receipt_at!.getTime() - expected)).toBeLessThan(2_000);
    }
    await makeReceiptsDue();
    expect(await run(fake)).toMatchObject({ unconfirmed: 1, delivered: 0, failed: 0 });
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'UNCONFIRMED', last_error: 'NO_RECEIPT', expo_token: null });
    expect(fake.sent).toHaveLength(1); // it was never sent a second time
  });

  it('a receipt that is still missing after Expo has cleared receipts (24 h) is UNCONFIRMED without asking', async () => {
    const fake = fakeExpo();
    const d = await accepted(fake);
    await sql(`UPDATE push_delivery SET ticket_at = now() - interval '25 hours', next_receipt_at = now() - interval '1 hour' WHERE id = '${d.id}'`);
    expect(await run(fake)).toMatchObject({ unconfirmed: 1 });
    expect(fake.receiptCalls).toHaveLength(0);
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'UNCONFIRMED', last_error: 'RECEIPT_WINDOW_CLOSED' });
  });

  it.each([
    ['DeviceNotRegistered', 'DeviceNotRegistered'],
    ['MessageTooBig', 'MessageTooBig'],
    ['InvalidCredentials', 'InvalidCredentials'],
    ['MismatchSenderId', 'MismatchSenderId'],
    ['SomethingNew', 'RECEIPT_SomethingNew'],
  ])('a receipt error %s ends FAILED as %s', async (code, stored) => {
    const fake = fakeExpo();
    const d = await accepted(fake);
    fake.state.receipts.set(d.ticket_id!, { status: 'error', message: 'details', details: { error: code } });
    await makeReceiptsDue();
    expect(await run(fake)).toMatchObject({ failed: 1 });
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'FAILED', last_error: stored, expo_token: null });
    if (code === 'DeviceNotRegistered') expect(await (await prismaP()).deviceToken.count()).toBe(0);
  });

  it('MessageRateExceeded is the ONE case that sends again: the ticket is cleared on purpose and the push goes out a second time', async () => {
    const fake = fakeExpo();
    const d = await accepted(fake);
    fake.state.receipts.set(d.ticket_id!, { status: 'error', details: { error: 'MessageRateExceeded' } });
    await makeReceiptsDue();
    expect(await run(fake)).toMatchObject({ requeued: 1 });
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'PENDING', ticket_id: null, ticket_at: null, next_receipt_at: null, last_error: 'MessageRateExceeded' });
    await makeDue();
    expect(await run(fake)).toMatchObject({ accepted: 1 });
    expect(fake.sent).toHaveLength(2);
    expect((await deliveryOf(d.id)).status).toBe('ACCEPTED');
  });

  it('receipts are requested in batches of at most 1000 ids', async () => {
    const prisma = await prismaP();
    const u = await pushUser('many@example.com');
    const device = u.tokens[0]!;
    await prisma.$executeRawUnsafe(`
      INSERT INTO notification (id, user_id, type, params, push_fanout_at)
      SELECT gen_random_uuid(), '${u.userId}', 'MATCH_CANCELLED', '{}', now() FROM generate_series(1, 1200)`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO push_delivery (notification_id, user_id, device_token_id, expo_token, status, attempts, ticket_id, ticket_at, next_receipt_at)
      SELECT id, '${u.userId}', '${device.id}', '${device.token}', 'ACCEPTED', 1, 'T-' || id, now(), now() - interval '1 second' FROM notification WHERE user_id = '${u.userId}'`);
    const fake = fakeExpo();
    expect(await run(fake)).toMatchObject({ delivered: 1200 });
    expect(fake.receiptCalls.map((c) => c.length)).toEqual([1000, 200]);
  });
});

describe('the documented manual requeue after a credential problem', () => {
  it('the SQL in the README requeues FAILED credential errors (young notifications only) and the push then goes out', async () => {
    const readme = readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8');
    const block = /```sql\r?\n(-- requeue-credential-failures[\s\S]*?)```/.exec(readme)?.[1];
    expect(block, 'the README must contain the requeue statement').toBeTruthy();

    const young = await oneDelivery({ params: { title: 'Young one' } });
    const old = await oneDelivery({ params: { title: 'Old one' } });
    const other = await oneDelivery({ params: { title: 'Not a credential problem' } });
    const fake = fakeExpo();
    fake.state.ticketErrors.set(young.device.token, 'InvalidCredentials');
    fake.state.ticketErrors.set(old.device.token, 'MismatchSenderId');
    fake.state.ticketErrors.set(other.device.token, 'MessageTooBig');
    await run(fake);
    expect((await deliveries()).map((d) => d.status)).toEqual(['FAILED', 'FAILED', 'FAILED']);
    await sql(`UPDATE notification SET created_at = now() - interval '25 hours' WHERE id = '${old.n.id}'`);

    expect(await sql(block!)).toBe(1); // only the young credential failure
    const rows = await deliveries();
    expect(rows.filter((d) => d.status === 'PENDING')).toHaveLength(1);
    expect(rows.find((d) => d.status === 'PENDING')!).toMatchObject({ attempts: 0, last_error: null, expo_token: young.device.token });

    fake.state.ticketErrors.clear(); // credentials fixed
    expect(await run(fake)).toMatchObject({ accepted: 1 });
    expect((await deliveries()).map((d) => d.status).sort()).toEqual(['ACCEPTED', 'FAILED', 'FAILED']);
  });
});

describe('retention only ever removes FINISHED deliveries', () => {
  it('purges old terminal rows and never touches pending, retrying, leased or receipt-pending ones', async () => {
    const prisma = await prismaP();
    const u = await pushUser('ret@example.com', { devices: 0 });
    const mk = async (status: string, extra: string, ageDays: number) => {
      const dev = await addDevice(u.userId);
      const n = await addNotification(u.userId, 'MATCH_CANCELLED');
      await prisma.$executeRawUnsafe(`UPDATE notification SET push_fanout_at = now() WHERE id = '${n.id}'`);
      const alive = ['PENDING', 'SENDING', 'ACCEPTED'].includes(status);
      await prisma.$executeRawUnsafe(`
        INSERT INTO push_delivery (notification_id, user_id, device_token_id, expo_token, status, finished_at, created_at ${extra ? ', ' + extra.split('|')[0] : ''})
        VALUES ('${n.id}', '${u.userId}', '${dev.id}', ${alive ? `'${dev.token}'` : 'NULL'}, '${status}', ${alive ? 'NULL' : `now() - interval '${ageDays} days'`}, now() - interval '${ageDays} days' ${extra ? ', ' + extra.split('|')[1] : ''})`);
      return status + ageDays;
    };
    const keep = [
      await mk('PENDING', '', 100),
      await mk('SENDING', 'claim_id, locked_until|gen_random_uuid(), now() - interval \'1 day\'', 100),
      await mk('ACCEPTED', 'ticket_id, ticket_at, next_receipt_at|\'T-1\', now() - interval \'100 days\', now() - interval \'100 days\'', 100),
      await mk('DELIVERED', '', 13),
      await mk('CANCELLED', '', 13),
      await mk('FAILED', '', 29),
      await mk('UNCONFIRMED', '', 29),
    ];
    const drop = [await mk('DELIVERED', '', 15), await mk('CANCELLED', '', 15), await mk('FAILED', '', 31), await mk('UNCONFIRMED', '', 31)];
    const { purgePushDeliveries } = await pushWorker();
    expect(await purgePushDeliveries()).toBe(drop.length);
    expect(await deliveries()).toHaveLength(keep.length);
    expect((await deliveries()).map((d) => d.status).sort()).toEqual(['ACCEPTED', 'CANCELLED', 'DELIVERED', 'FAILED', 'PENDING', 'SENDING', 'UNCONFIRMED']);
  });

  it('a notification that still has deliveries cannot be deleted (a future notification purge must remove finished deliveries first)', async () => {
    const { n } = await oneDelivery();
    await run(fakeExpo(), { maxSendBatches: 0 });
    await expect(sql(`DELETE FROM notification WHERE id = '${n.id}'`)).rejects.toThrow(/foreign key|23503/i);
  });
});

describe('nothing sensitive is logged', () => {
  it('no device token, no message text, no ticket details and no access token reach the logs, even when sending fails', async () => {
    const { env } = await import('../src/config/env');
    const { logger } = await import('../src/lib/logger');
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((l) => vi.spyOn(logger, l));
    const secret = 'SECRET-EXPO-ACCESS-TOKEN-4711';
    const original = env.EXPO_ACCESS_TOKEN;
    env.EXPO_ACCESS_TOKEN = secret;
    try {
      const a = await oneDelivery({ params: { title: 'Private Match Title', matchId: 'm1' } });
      const b = await oneDelivery({ params: { title: 'Another Private Title', matchId: 'm2' } });
      const fake = fakeExpo();
      fake.state.ticketErrors.set(a.device.token, 'MessageTooBig');
      fake.state.ticketErrors.set(b.device.token, 'MismatchSenderId');
      await run(fake);
      const logged = inspect(spies.flatMap((s) => s.mock.calls), { depth: 8, breakLength: Infinity });
      expect(logged).toContain('push'); // it did log
      for (const secretText of [a.device.token, b.device.token, 'Private Match Title', 'Another Private Title', 'secret details that must never be stored', secret]) {
        expect(logged).not.toContain(secretText);
      }
    } finally {
      env.EXPO_ACCESS_TOKEN = original;
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('the stored error of a delivery is a short code, never Expo\'s message text', async () => {
    const { device } = await oneDelivery();
    const fake = fakeExpo();
    fake.state.ticketErrors.set(device.token, 'MessageTooBig');
    await run(fake);
    expect((await deliveries())[0]!.last_error).toBe('MessageTooBig');
  });
});
