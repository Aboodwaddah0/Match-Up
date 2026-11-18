import { inspect } from 'node:util';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from './helpers/client';
import { addNotification, authError, channelState, coordination, deliveries, deliveryOf, fakeExpo, makeDue, makeReceiptsDue, prismaP, pushUser, pushWorker, rateLimitError, sql, transientError } from './helpers/push';

afterAll(async () => {
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

const run = async (fake: ReturnType<typeof fakeExpo>, over: Record<string, unknown> = {}) => (await pushWorker()).runPushWorkerOnce({ client: fake.client, ...over });
const endPause = (channel: 'SEND' | 'RECEIPT') => sql(`UPDATE push_provider_state SET paused_until = now() - interval '1 second' WHERE channel = '${channel}'`);
const minutesFromNow = (d: Date | null) => Math.round(((d?.getTime() ?? 0) - Date.now()) / 60_000);

/** One user and device with `n` waiting pushable notifications. */
async function pending(n: number, email = 'p@example.com') {
  const u = await pushUser(email);
  for (let i = 0; i < n; i++) await addNotification(u.userId, 'MATCH_CANCELLED', { title: `Game ${i}` });
  return u;
}

describe('SEND channel: authentication failure while sending', () => {
  it('pauses the channel, hands every attempt back, keeps the work PENDING, logs ONE error without secrets, and fan-out keeps going', async () => {
    const { logger } = await import('../src/lib/logger');
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      const u = await pending(3);
      const fake = fakeExpo();
      fake.state.sendError = authError();
      const r = await run(fake);
      expect(r.paused).toEqual(['SEND']);

      const state = await channelState('SEND');
      expect(state).toMatchObject({ status: 'AUTH_FAILED', consecutiveFailures: 1, lastErrorCode: 'UNAUTHORIZED' });
      expect(minutesFromNow(state.pausedUntil)).toBe(5);

      const rows = await deliveries();
      expect(rows).toHaveLength(3);
      for (const d of rows) {
        expect(d).toMatchObject({ status: 'PENDING', attempts: 0, last_error: 'AUTH_PAUSED', claim_id: null, locked_until: null });
        expect(Math.abs(d.next_attempt_at.getTime() - state.pausedUntil!.getTime())).toBeLessThan(2_000);
        expect(d.expo_token).not.toBeNull(); // the work is preserved, not lost
      }

      // one error log for the whole pause (not one per delivery), no secret in it
      const logged = errorSpy.mock.calls.filter((c) => inspect(c).includes('rejected the credentials'));
      expect(logged).toHaveLength(1);
      expect(inspect(errorSpy.mock.calls, { depth: 6 })).not.toContain(rows[0]!.expo_token!);

      // while paused: no request is made, but notifications still turn into pending deliveries
      const attemptsBefore = fake.sendAttempts.length;
      await addNotification(u.userId, 'MATCH_INVITATION', { title: 'New one' });
      const second = await run(fake);
      expect(fake.sendAttempts.length).toBe(attemptsBefore);
      expect(second).toMatchObject({ notificationsFannedOut: 1, deliveriesCreated: 1, paused: ['SEND'] });
      expect(await deliveries()).toHaveLength(4);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('after the pause ONE instance probes with ONE pending delivery; success resumes everything, and each push is sent exactly once', async () => {
    await pending(5);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken);

    await endPause('SEND');
    await makeDue();
    const fixed = fakeExpo();
    await Promise.all([1, 2, 3, 4].map(() => run(fixed, { rate: { perSecond: 5000, capacity: 5000 } })));

    expect(fixed.sendAttempts[0]!.size).toBe(1); // the probe: a single delivery
    const counts = new Map<string, number>();
    for (const m of fixed.sent) counts.set(m.collapseId, (counts.get(m.collapseId) ?? 0) + 1);
    expect(counts.size).toBe(5);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    expect((await deliveries()).every((d) => d.status === 'ACCEPTED' && d.attempts === 1)).toBe(true); // the refunded attempts were not lost or doubled
    expect(await channelState('SEND')).toMatchObject({ status: 'OK', pausedUntil: null, consecutiveFailures: 0, probeClaimId: null, probeUntil: null });
  });

  it('exactly one of many simultaneous instances wins the probe', async () => {
    const { enterChannel } = await coordination();
    await pending(1);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken);
    await endPause('SEND');
    const gates = await Promise.all(Array.from({ length: 12 }, () => enterChannel('SEND')));
    expect(gates.filter((g) => g.run && g.probe)).toHaveLength(1);
    expect(gates.filter((g) => g.run && !g.probe)).toHaveLength(0);
    expect(gates.filter((g) => !g.run)).toHaveLength(11);
  });

  it('the pause is respected while it lasts: nobody probes before paused_until', async () => {
    const { enterChannel } = await coordination();
    await pending(1);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken);
    const gates = await Promise.all(Array.from({ length: 5 }, () => enterChannel('SEND')));
    expect(gates.every((g) => !g.run)).toBe(true);
  });

  it('a probe that fails again lengthens the pause (5, 15, 30, then 60 minutes) and still consumes nothing', async () => {
    await pending(2);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken); // 5 minutes
    const expected = [15, 30, 60, 60];
    for (const [i, minutes] of expected.entries()) {
      await endPause('SEND');
      await makeDue();
      await run(broken);
      const state = await channelState('SEND');
      expect(state).toMatchObject({ status: 'AUTH_FAILED', consecutiveFailures: i + 2, probeClaimId: null, probeUntil: null });
      expect(minutesFromNow(state.pausedUntil)).toBe(minutes);
      expect((await deliveries()).every((d) => d.status === 'PENDING' && d.attempts === 0)).toBe(true);
    }
    expect(broken.sendAttempts.slice(1).every((a) => a.size === 1)).toBe(true); // every probe was a single delivery
  });

  it('a probe that learns nothing about the credentials (network error) is released and tried again soon; the channel stays paused', async () => {
    await pending(2);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken);
    await endPause('SEND');
    await makeDue();
    const flaky = fakeExpo();
    flaky.state.sendError = transientError('NETWORK');
    await run(flaky);
    const state = await channelState('SEND');
    expect(state).toMatchObject({ status: 'AUTH_FAILED', probeClaimId: null, probeUntil: null });
    expect(minutesFromNow(state.pausedUntil)).toBeLessThanOrEqual(1);
    expect(flaky.sendAttempts).toHaveLength(1);
    expect(flaky.sendAttempts[0]!.size).toBe(1);
  });

  it('a probe that gets any other answer from Expo (a ticket error) proves the credentials work and resumes the channel', async () => {
    const u = await pending(1);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken);
    await endPause('SEND');
    await makeDue();
    const answering = fakeExpo();
    answering.state.ticketErrors.set((await deliveries())[0]!.expo_token!, 'MessageTooBig');
    await run(answering);
    expect(await channelState('SEND')).toMatchObject({ status: 'OK' });
    expect(u.userId).toBeTruthy();
  });

  it('a prober that crashed loses its lease and another instance takes over; a live probe is not stolen', async () => {
    const { enterChannel } = await coordination();
    await pending(1);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken);
    await endPause('SEND');
    await sql(`UPDATE push_provider_state SET probe_claim_id = gen_random_uuid(), probe_until = now() + interval '1 minute' WHERE channel = 'SEND'`);
    expect((await enterChannel('SEND')).run).toBe(false); // somebody is probing right now
    await sql(`UPDATE push_provider_state SET probe_until = now() - interval '1 second' WHERE channel = 'SEND'`);
    expect(await enterChannel('SEND')).toMatchObject({ run: true, probe: true }); // its lease ran out
  });

  it('with nothing pending to probe with, the probe is released and the channel waits', async () => {
    const broken = fakeExpo();
    await pending(1);
    broken.state.sendError = authError();
    await run(broken);
    await sql(`UPDATE push_delivery SET status = 'CANCELLED', finished_at = now(), expo_token = NULL`);
    await endPause('SEND');
    await run(fakeExpo());
    expect(await channelState('SEND')).toMatchObject({ status: 'AUTH_FAILED', probeClaimId: null });
  });

  it('an outage longer than 24 hours cancels the oldest pushes as STALE (counted, visible); nothing else is lost', async () => {
    const u = await pending(2);
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await run(broken);
    await sql(`UPDATE notification SET created_at = now() - interval '25 hours' WHERE id = (SELECT notification_id FROM push_delivery ORDER BY created_at LIMIT 1)`);
    const r = await run(broken);
    expect(r.staleNotifications).toBe(1);
    expect((await deliveries()).map((d) => [d.status, d.last_error]).sort()).toEqual([['CANCELLED', 'STALE'], ['PENDING', 'AUTH_PAUSED']]);
    expect(u.userId).toBeTruthy();
  });
});

describe('RECEIPT channel: authentication failure while reading receipts must never cause a resend', () => {
  async function acceptedPush() {
    await pending(1);
    const fake = fakeExpo();
    await run(fake);
    const [d] = await deliveries();
    expect(d!.status).toBe('ACCEPTED');
    return { fake, d: d! };
  }

  it('the delivery stays ACCEPTED with its ticket, only the next receipt check moves, nothing is consumed, and nothing is sent again', async () => {
    const { fake, d } = await acceptedPush();
    fake.state.receiptError = authError();
    await makeReceiptsDue();
    const r = await run(fake);
    expect(r.paused).toEqual(['RECEIPT']);

    const state = await channelState('RECEIPT');
    expect(state).toMatchObject({ status: 'AUTH_FAILED', consecutiveFailures: 1, lastErrorCode: 'UNAUTHORIZED' });
    const row = await deliveryOf(d.id);
    expect(row).toMatchObject({ status: 'ACCEPTED', ticket_id: d.ticket_id, receipt_attempts: d.receipt_attempts, attempts: 1, claim_id: null, locked_until: null });
    expect(Math.abs(row.next_receipt_at!.getTime() - state.pausedUntil!.getTime())).toBeLessThan(2_000);
    expect(fake.sent).toHaveLength(1); // never sent a second time
    expect(await channelState('SEND')).toMatchObject({ status: 'OK' }); // the channels are independent
  });

  it('sending keeps working while receipts are paused, and receipts keep working while sending is paused', async () => {
    const { fake, d } = await acceptedPush();
    fake.state.receiptError = authError();
    await makeReceiptsDue();
    await run(fake);
    const u = await pushUser('another@example.com');
    await addNotification(u.userId, 'MATCH_INVITATION', { title: 'During the receipt outage' });
    await run(fake);
    expect(fake.sent).toHaveLength(2); // the new push went out
    expect((await deliveryOf(d.id)).status).toBe('ACCEPTED');

    // and the other way round
    const second = fakeExpo();
    await sql(`UPDATE push_provider_state SET status = 'OK', paused_until = NULL, consecutive_failures = 0 WHERE channel = 'RECEIPT'`);
    second.state.sendError = authError();
    await addNotification(u.userId, 'MATCH_INVITATION', { title: 'During the send outage' });
    await makeReceiptsDue();
    const r = await run(second);
    expect(r.paused).toEqual(['SEND']);
    expect(r.delivered).toBeGreaterThanOrEqual(1);
  });

  it('after the credentials are fixed, a RECEIPT request (one ticket) is the probe, the delivery completes, and the push was sent exactly once in total', async () => {
    const { fake, d } = await acceptedPush();
    fake.state.receiptError = authError();
    await makeReceiptsDue();
    await run(fake);
    const sendsBefore = fake.sendAttempts.length;

    await endPause('RECEIPT');
    await makeReceiptsDue();
    fake.state.receiptError = null;
    const attemptsBeforeProbe = fake.receiptCalls.length;
    await Promise.all([1, 2, 3].map(() => run(fake)));
    expect(fake.receiptCalls[attemptsBeforeProbe]).toEqual([d.ticket_id]); // the probe asked for exactly one receipt
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'DELIVERED', attempts: 1 });
    expect(fake.sendAttempts.length).toBe(sendsBefore); // sending was not involved at all
    expect(fake.sent).toHaveLength(1);
    expect(await channelState('RECEIPT')).toMatchObject({ status: 'OK', pausedUntil: null, probeClaimId: null });
  });

  it('exactly one instance wins the receipt probe, and a probe that fails again lengthens the pause without touching the delivery', async () => {
    const { enterChannel } = await coordination();
    const { fake, d } = await acceptedPush();
    fake.state.receiptError = authError();
    await makeReceiptsDue();
    await run(fake);
    await endPause('RECEIPT');
    const gates = await Promise.all(Array.from({ length: 10 }, () => enterChannel('RECEIPT')));
    expect(gates.filter((g) => g.run && g.probe)).toHaveLength(1);

    // the winner (released again) probes with a still-broken credential: pause grows, delivery untouched
    await sql(`UPDATE push_provider_state SET probe_claim_id = NULL, probe_until = NULL WHERE channel = 'RECEIPT'`);
    await makeReceiptsDue();
    await run(fake);
    const state = await channelState('RECEIPT');
    expect(state).toMatchObject({ status: 'AUTH_FAILED', consecutiveFailures: 2 });
    expect(minutesFromNow(state.pausedUntil)).toBe(15);
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'ACCEPTED', ticket_id: d.ticket_id, attempts: 1 });
    expect(fake.sent).toHaveLength(1);
  });

  it('with no receipt due there is nothing to probe with; the channel just waits (and never resends)', async () => {
    const { fake } = await acceptedPush();
    fake.state.receiptError = authError();
    await makeReceiptsDue();
    await run(fake);
    await sql(`UPDATE push_delivery SET next_receipt_at = now() + interval '1 hour'`);
    await endPause('RECEIPT');
    fake.state.receiptError = null;
    await run(fake);
    expect(await channelState('RECEIPT')).toMatchObject({ status: 'AUTH_FAILED', probeClaimId: null });
    expect(fake.sent).toHaveLength(1);
  });

  it('a receipt outage that outlasts Expo\'s 24 hour retention ends UNCONFIRMED (never FAILED, never DELIVERED, never resent)', async () => {
    const { fake, d } = await acceptedPush();
    fake.state.receiptError = authError();
    await makeReceiptsDue();
    await run(fake);
    await sql(`UPDATE push_delivery SET ticket_at = now() - interval '25 hours' WHERE id = '${d.id}'`);
    const r = await run(fake);
    expect(r.unconfirmed).toBe(1);
    expect(await deliveryOf(d.id)).toMatchObject({ status: 'UNCONFIRMED', last_error: 'RECEIPT_WINDOW_CLOSED', expo_token: null });
    expect(fake.sent).toHaveLength(1);
  });

  it('the database itself refuses to put an accepted push back to PENDING without clearing its ticket', async () => {
    const { d } = await acceptedPush();
    await expect(sql(`UPDATE push_delivery SET status = 'PENDING', claim_id = NULL, locked_until = NULL WHERE id = '${d.id}'`)).rejects.toThrow(/chk_push_ticket_phase/);
    await expect(sql(`UPDATE push_delivery SET status = 'SENDING', claim_id = gen_random_uuid(), locked_until = now() WHERE id = '${d.id}'`)).rejects.toThrow(/chk_push_ticket_phase/);
    expect((await deliveryOf(d.id)).status).toBe('ACCEPTED');
  });

  it('other receipt-request failures (5xx, rate limit) only postpone the check', async () => {
    const { fake, d } = await acceptedPush();
    for (const err of [transientError('HTTP_502'), rateLimitError()]) {
      fake.state.receiptError = err;
      await makeReceiptsDue();
      await run(fake);
      const row = await deliveryOf(d.id);
      expect(row).toMatchObject({ status: 'ACCEPTED', ticket_id: d.ticket_id, receipt_attempts: 0 });
      expect(row.next_receipt_at!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    }
    expect(await channelState('RECEIPT')).toMatchObject({ status: 'OK' });
    expect(fake.sent).toHaveLength(1);
  });
});

describe('the send rate is shared by ALL instances', () => {
  it('the bucket grants what is there, never more, tells a caller when to come back, and takes refunds', async () => {
    const { acquireTokens, refundTokens } = await coordination();
    const cfg = { perSecond: 1, capacity: 10 };
    await sql(`UPDATE push_rate_bucket SET tokens = 10, refilled_at = now(), blocked_until = NULL`);
    expect((await acquireTokens(100, cfg)).granted).toBe(10);
    const empty = await acquireTokens(5, cfg);
    expect(empty.granted).toBe(0);
    expect(empty.waitMs).toBeGreaterThan(800);
    expect(empty.waitMs).toBeLessThanOrEqual(1100);
    await refundTokens(4, cfg);
    expect((await acquireTokens(100, cfg)).granted).toBe(4);
    await refundTokens(1000, cfg); // a refund can never push the bucket above its capacity
    expect((await acquireTokens(1000, cfg)).granted).toBeLessThanOrEqual(10);
    const rows = await (await prismaP()).$queryRawUnsafe<{ tokens: number }[]>('SELECT tokens FROM push_rate_bucket');
    expect(rows[0]!.tokens).toBeGreaterThanOrEqual(0);
  });

  it('refills with the DATABASE clock', async () => {
    const { acquireTokens } = await coordination();
    const cfg = { perSecond: 100, capacity: 100 };
    await sql(`UPDATE push_rate_bucket SET tokens = 0, refilled_at = now() - interval '500 milliseconds', blocked_until = NULL`);
    const g = (await acquireTokens(1000, cfg)).granted;
    expect(g).toBeGreaterThanOrEqual(49);
    expect(g).toBeLessThanOrEqual(60);
  });

  it('concurrent callers can never be granted more than the bucket holds', async () => {
    const { acquireTokens } = await coordination();
    const cfg = { perSecond: 1, capacity: 50 };
    await sql(`UPDATE push_rate_bucket SET tokens = 50, refilled_at = now(), blocked_until = NULL`);
    const started = performance.now();
    const grants = await Promise.all(Array.from({ length: 20 }, () => acquireTokens(10, cfg)));
    const seconds = (performance.now() - started) / 1000;
    const total = grants.reduce((n, g) => n + g.granted, 0);
    expect(total).toBeGreaterThanOrEqual(50);
    expect(total).toBeLessThanOrEqual(50 + cfg.perSecond * seconds + 1); // what was in the bucket, plus only what refilled while the callers ran
  });

  it('four workers together stay inside capacity + rate x time in EVERY window, and still send every push exactly once', async () => {
    const rate = { perSecond: 100, capacity: 50 };
    await pending(300);
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 }); // fan-out first: 300 pending deliveries
    expect(await deliveries()).toHaveLength(300);
    await sql(`UPDATE push_rate_bucket SET tokens = ${rate.capacity}, refilled_at = now(), blocked_until = NULL`);
    const started = performance.now();
    for (let pass = 0; pass < 4 && (await deliveries(`WHERE status IN ('PENDING', 'SENDING')`)).length > 0; pass++) {
      await Promise.all([1, 2, 3, 4].map(() => run(fake, { rate, maxSendBatches: 100, maxTokenWaitMs: 3_000 })));
    }
    const elapsed = performance.now() - started;
    expect((await deliveries()).filter((d) => d.status === 'ACCEPTED')).toHaveLength(300);
    expect(fake.sent).toHaveLength(300);
    expect(new Set(fake.sent.map((m) => m.collapseId)).size).toBe(300);

    // The bound: in any window of T seconds at most capacity + rate*T messages are sent (a little slack for the time between taking tokens and sending).
    const events = [...fake.sendAttempts].sort((a, b) => a.at - b.at);
    for (let i = 0; i < events.length; i++) {
      let sum = 0;
      for (let j = i; j < events.length; j++) {
        sum += events[j]!.size;
        const windowS = (events[j]!.at - events[i]!.at) / 1000;
        expect(sum, `window of ${windowS.toFixed(2)} s`).toBeLessThanOrEqual(rate.capacity + rate.perSecond * windowS + 30);
      }
    }
    expect(elapsed).toBeGreaterThan(1_800); // (300 - 50 burst) / 100 per second: it really was limited
  }, 60_000);

  it('Expo saying "too many requests" slows ALL instances: the rows keep their attempts, the shared bucket is blocked, the credentials are not blamed', async () => {
    const { acquireTokens } = await coordination();
    await pending(3);
    const fake = fakeExpo();
    fake.state.sendError = rateLimitError();
    await run(fake);
    expect((await deliveries()).every((d) => d.status === 'PENDING' && d.attempts === 0 && d.last_error === 'RATE_LIMITED')).toBe(true);
    const blocked = await acquireTokens(10);
    expect(blocked.granted).toBe(0);
    expect(blocked.waitMs).toBeGreaterThan(10_000);
    expect(await channelState('SEND')).toMatchObject({ status: 'OK' });

    const other = fakeExpo(); // another instance
    await run(other, { maxTokenWaitMs: 50 });
    expect(other.sendAttempts).toHaveLength(0); // it honours the shared block
  });
});
