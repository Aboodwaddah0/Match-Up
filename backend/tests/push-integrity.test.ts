import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from './helpers/client';
import { addNotification, coordination, deliveries, deliveryOf, fakeExpo, makeDue, makeReceiptsDue, prismaP, pushUser, pushWorker, sql, authError } from './helpers/push';

afterAll(async () => {
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

const run = async (fake: ReturnType<typeof fakeExpo>, over: Record<string, unknown> = {}) => (await pushWorker()).runPushWorkerOnce({ client: fake.client, ...over });

/** One delivery row in the given state, inserted directly, to probe the constraints. */
async function seed(status = 'PENDING') {
  const u = await pushUser(`i${Math.random().toString(36).slice(2, 8)}@example.com`);
  const n = await addNotification(u.userId, 'MATCH_CANCELLED');
  await sql(`UPDATE notification SET push_fanout_at = now() WHERE id = '${n.id}'`);
  const d = u.tokens[0]!;
  const ids = `'${n.id}', '${u.userId}', '${d.id}'`;
  const insert = (cols: string, vals: string) => sql(`INSERT INTO push_delivery (notification_id, user_id, device_token_id, ${cols}) VALUES (${ids}, ${vals})`);
  void status;
  return { u, n, d, insert };
}

const refused = async (p: Promise<unknown>, constraint: string) => expect(p).rejects.toThrow(new RegExp(constraint));

describe('chk_push_claim: the send lease exists exactly while a delivery is SENDING', () => {
  it('SENDING needs BOTH claim_id and locked_until', async () => {
    const { d, insert } = await seed();
    await refused(insert('expo_token, status', `'${d.token}', 'SENDING'`), 'chk_push_claim');
    await refused(insert('expo_token, status, claim_id', `'${d.token}', 'SENDING', gen_random_uuid()`), 'chk_push_claim');
    await refused(insert('expo_token, status, locked_until', `'${d.token}', 'SENDING', now()`), 'chk_push_claim');
    await insert('expo_token, status, claim_id, locked_until', `'${d.token}', 'SENDING', gen_random_uuid(), now() + interval '1 minute'`); // both: fine
    expect(await deliveries(`WHERE status = 'SENDING'`)).toHaveLength(1);
  });

  it.each([
    ['PENDING', "expo_token, status", (t: string) => `'${t}', 'PENDING'`],
    ['ACCEPTED', "expo_token, status, ticket_id, ticket_at, next_receipt_at", (t: string) => `'${t}', 'ACCEPTED', 'T-1', now(), now()`],
    ['DELIVERED', 'status, finished_at', () => `'DELIVERED', now()`],
    ['FAILED', 'status, finished_at', () => `'FAILED', now()`],
    ['CANCELLED', 'status, finished_at', () => `'CANCELLED', now()`],
    ['UNCONFIRMED', 'status, finished_at', () => `'UNCONFIRMED', now()`],
  ])('a %s delivery must carry NEITHER claim_id NOR locked_until', async (_status, cols, vals) => {
    const { d, insert } = await seed();
    await insert(cols, vals(d.token)); // without a lease: fine
    await sql(`DELETE FROM push_delivery`);
    await refused(insert(`${cols}, claim_id`, `${vals(d.token)}, gen_random_uuid()`), 'chk_push_claim');
    await refused(insert(`${cols}, locked_until`, `${vals(d.token)}, now()`), 'chk_push_claim');
    await refused(insert(`${cols}, claim_id, locked_until`, `${vals(d.token)}, gen_random_uuid(), now()`), 'chk_push_claim');
  });

  it('a SENDING delivery cannot leave that state with its lease still in place (every exit must clear both columns)', async () => {
    const { d, insert } = await seed();
    await insert('expo_token, status, claim_id, locked_until', `'${d.token}', 'SENDING', gen_random_uuid(), now() + interval '1 minute'`);
    const [row] = await deliveries();
    await refused(sql(`UPDATE push_delivery SET status = 'PENDING' WHERE id = '${row!.id}'`), 'chk_push_claim');
    await refused(sql(`UPDATE push_delivery SET status = 'PENDING', claim_id = NULL WHERE id = '${row!.id}'`), 'chk_push_claim'); // half cleared
    await refused(sql(`UPDATE push_delivery SET status = 'PENDING', locked_until = NULL WHERE id = '${row!.id}'`), 'chk_push_claim');
    await sql(`UPDATE push_delivery SET status = 'PENDING', claim_id = NULL, locked_until = NULL WHERE id = '${row!.id}'`); // both cleared: fine
    expect((await deliveryOf(row!.id)).status).toBe('PENDING');
  });
});

describe('chk_push_receipt_lease: a receipt check has its own lease, only on an ACCEPTED delivery', () => {
  const accepted = "expo_token, status, ticket_id, ticket_at, next_receipt_at";
  const acceptedVals = (t: string) => `'${t}', 'ACCEPTED', 'T-1', now(), now()`;

  it('ACCEPTED may carry both receipt lease columns, or neither, never one', async () => {
    const { d, insert } = await seed();
    await insert(`${accepted}, receipt_claim_id, receipt_locked_until`, `${acceptedVals(d.token)}, gen_random_uuid(), now() + interval '1 minute'`);
    await sql('DELETE FROM push_delivery');
    await refused(insert(`${accepted}, receipt_claim_id`, `${acceptedVals(d.token)}, gen_random_uuid()`), 'chk_push_receipt_lease');
    await refused(insert(`${accepted}, receipt_locked_until`, `${acceptedVals(d.token)}, now()`), 'chk_push_receipt_lease');
  });

  it.each([
    ['PENDING', 'expo_token, status', (t: string) => `'${t}', 'PENDING'`],
    ['SENDING', 'expo_token, status, claim_id, locked_until', (t: string) => `'${t}', 'SENDING', gen_random_uuid(), now()`],
    ['DELIVERED', 'status, finished_at', () => `'DELIVERED', now()`],
    ['FAILED', 'status, finished_at', () => `'FAILED', now()`],
    ['CANCELLED', 'status, finished_at', () => `'CANCELLED', now()`],
    ['UNCONFIRMED', 'status, finished_at', () => `'UNCONFIRMED', now()`],
  ])('a %s delivery can never carry a receipt lease', async (_status, cols, vals) => {
    const { d, insert } = await seed();
    await refused(insert(`${cols}, receipt_claim_id, receipt_locked_until`, `${vals(d.token)}, gen_random_uuid(), now()`), 'chk_push_receipt_lease');
  });

  it('an ACCEPTED delivery cannot leave that state with its receipt lease still in place', async () => {
    const { d, insert } = await seed();
    await insert(`${accepted}, receipt_claim_id, receipt_locked_until`, `${acceptedVals(d.token)}, gen_random_uuid(), now() + interval '1 minute'`);
    const [row] = await deliveries();
    await refused(sql(`UPDATE push_delivery SET status = 'DELIVERED', finished_at = now(), expo_token = NULL WHERE id = '${row!.id}'`), 'chk_push_receipt_lease');
    await sql(`UPDATE push_delivery SET status = 'DELIVERED', finished_at = now(), expo_token = NULL, receipt_claim_id = NULL, receipt_locked_until = NULL WHERE id = '${row!.id}'`);
    expect((await deliveryOf(row!.id)).status).toBe('DELIVERED');
  });
});

describe('chk_push_state_probe: a probe election is held (claim AND lease) or not (neither)', () => {
  it('refuses a claim without a lease and a lease without a claim, accepts both and neither', async () => {
    await refused(sql(`UPDATE push_provider_state SET probe_claim_id = gen_random_uuid() WHERE channel = 'SEND'`), 'chk_push_state_probe');
    await refused(sql(`UPDATE push_provider_state SET probe_until = now() WHERE channel = 'SEND'`), 'chk_push_state_probe');
    await refused(sql(`UPDATE push_provider_state SET probe_claim_id = gen_random_uuid() WHERE channel = 'RECEIPT'`), 'chk_push_state_probe');
    await sql(`UPDATE push_provider_state SET probe_claim_id = gen_random_uuid(), probe_until = now() + interval '1 minute' WHERE channel = 'SEND'`);
    await sql(`UPDATE push_provider_state SET probe_claim_id = NULL, probe_until = NULL WHERE channel = 'SEND'`);
  });

  it('every coordination function leaves the two probe columns consistent', async () => {
    const { enterChannel, authFailed, channelOk, releaseProbe } = await coordination();
    const probeColumns = async (channel: 'SEND' | 'RECEIPT') => {
      const [r] = await (await prismaP()).$queryRawUnsafe<{ c: string | null; u: Date | null }[]>(`SELECT probe_claim_id AS c, probe_until AS u FROM push_provider_state WHERE channel = '${channel}'`);
      return { claim: r!.c, until: r!.u };
    };
    for (const channel of ['SEND', 'RECEIPT'] as const) {
      await authFailed(channel, 'UNAUTHORIZED', null); // opens the pause
      expect(await probeColumns(channel)).toEqual({ claim: null, until: null });

      await sql(`UPDATE push_provider_state SET paused_until = now() - interval '1 second' WHERE channel = '${channel}'`);
      const gate = await enterChannel(channel); // wins the election
      expect(gate).toMatchObject({ run: true, probe: true });
      const held = await probeColumns(channel);
      expect(held.claim).not.toBeNull();
      expect(held.until).not.toBeNull();

      await releaseProbe(channel, (gate as { probeClaim: string }).probeClaim, 0); // gives it up
      expect(await probeColumns(channel)).toEqual({ claim: null, until: null });

      const second = await enterChannel(channel); // wins again, then fails again
      expect(second).toMatchObject({ probe: true });
      await authFailed(channel, 'UNAUTHORIZED', (second as { probeClaim: string }).probeClaim);
      expect(await probeColumns(channel)).toEqual({ claim: null, until: null });

      await sql(`UPDATE push_provider_state SET paused_until = now() - interval '1 second' WHERE channel = '${channel}'`);
      const third = await enterChannel(channel); // wins, and succeeds
      await channelOk(channel, (third as { probeClaim: string }).probeClaim);
      expect(await probeColumns(channel)).toEqual({ claim: null, until: null });
    }
  });
});

describe('every worker transition satisfies the lease constraints', () => {
  it('walks a delivery through SENDING and the receipt check and looks at the lease columns while each call is in flight', async () => {
    const u = await pushUser('walk@example.com');
    await addNotification(u.userId, 'MATCH_INVITATION', { title: 'Walk' });
    const fake = fakeExpo();
    const seen: Record<string, unknown> = {};
    fake.state.beforeSend = async () => {
      seen.send = (await deliveries())[0];
    };
    fake.state.beforeReceipts = async () => {
      seen.receipt = (await deliveries())[0];
    };

    await run(fake);
    const during = seen.send as Awaited<ReturnType<typeof deliveries>>[number];
    expect(during).toMatchObject({ status: 'SENDING', receipt_claim_id: null, receipt_locked_until: null });
    expect(during.claim_id).not.toBeNull(); // the SEND lease, while sending
    expect(during.locked_until).not.toBeNull();
    expect(await deliveries()).toMatchObject([{ status: 'ACCEPTED', claim_id: null, locked_until: null, receipt_claim_id: null, receipt_locked_until: null }]);

    await makeReceiptsDue();
    await run(fake);
    const checking = seen.receipt as Awaited<ReturnType<typeof deliveries>>[number];
    expect(checking).toMatchObject({ status: 'ACCEPTED', claim_id: null, locked_until: null }); // the send lease stays empty
    expect(checking.receipt_claim_id).not.toBeNull(); // the RECEIPT lease, while checking
    expect(checking.receipt_locked_until).not.toBeNull();
    expect(await deliveries()).toMatchObject([{ status: 'DELIVERED', claim_id: null, locked_until: null, receipt_claim_id: null, receipt_locked_until: null }]);
  });

  it('every exit from a lease clears it: failures, retries, cancellations, auth pauses and requeues', async () => {
    const prisma = await prismaP();
    const mk = async (type = 'MATCH_CANCELLED') => {
      const u = await pushUser(`x${Math.random().toString(36).slice(2, 8)}@example.com`);
      await addNotification(u.userId, type, { title: 'T' });
      return u.tokens[0]!;
    };
    const everyLeaseIsClear = async () => {
      const bad = await prisma.$queryRawUnsafe<{ n: number }[]>(`
        SELECT count(*)::int AS n FROM push_delivery
         WHERE (status = 'SENDING') <> (claim_id IS NOT NULL AND locked_until IS NOT NULL)
            OR (claim_id IS NULL) <> (locked_until IS NULL)
            OR ((receipt_claim_id IS NULL) <> (receipt_locked_until IS NULL))
            OR (receipt_claim_id IS NOT NULL AND status <> 'ACCEPTED')`);
      expect(bad[0]!.n).toBe(0);
    };

    // 1. send-side exits: ticket error (failed), transient error (retry), device removed (cancelled)
    const failing = await mk();
    const retrying = await mk();
    const removed = await mk();
    const fake = fakeExpo();
    await run(fake, { maxSendBatches: 0 });
    await sql(`DELETE FROM device_token WHERE id = '${removed.id}'`);
    fake.state.ticketErrors.set(failing.token, 'MessageTooBig');
    fake.state.ticketErrors.set(retrying.token, 'SomethingNew');
    await run(fake);
    await everyLeaseIsClear();
    expect((await deliveries()).map((d) => d.status).sort()).toEqual(['CANCELLED', 'FAILED', 'PENDING']);

    // 2. send authentication failure (back to PENDING without a lease)
    const broken = fakeExpo();
    broken.state.sendError = authError();
    await makeDue();
    await run(broken);
    await everyLeaseIsClear();

    // 3. receipt-side exits: ok, error, missing, rate-exceeded (requeue), authentication failure
    await sql(`DELETE FROM push_delivery`);
    await sql(`UPDATE push_provider_state SET status = 'OK', paused_until = NULL, consecutive_failures = 0`);
    await sql('DELETE FROM notification');
    for (let i = 0; i < 5; i++) await mk('MATCH_INVITATION');
    const ok = fakeExpo();
    await run(ok);
    const accepted = await deliveries(`WHERE status = 'ACCEPTED'`);
    expect(accepted).toHaveLength(5);
    const tickets = accepted.map((d) => d.ticket_id!);
    ok.state.receipts.set(tickets[0]!, { status: 'ok' });
    ok.state.receipts.set(tickets[1]!, { status: 'error', details: { error: 'MessageTooBig' } });
    ok.state.receipts.set(tickets[2]!, undefined); // missing
    ok.state.receipts.set(tickets[3]!, { status: 'error', details: { error: 'MessageRateExceeded' } });
    ok.state.receipts.set(tickets[4]!, { status: 'error', details: { error: 'DeviceNotRegistered' } });
    await makeReceiptsDue();
    await run(ok);
    await everyLeaseIsClear();
    expect((await deliveries()).map((d) => d.status).sort()).toEqual(['ACCEPTED', 'DELIVERED', 'FAILED', 'FAILED', 'PENDING']);

    const authFail = fakeExpo();
    authFail.state.receiptError = authError();
    await makeReceiptsDue();
    await run(authFail);
    await everyLeaseIsClear();
    expect(await deliveries(`WHERE status = 'ACCEPTED'`)).toMatchObject([{ receipt_claim_id: null, receipt_locked_until: null, claim_id: null, locked_until: null }]);
  });

  it('a receipt check left behind by a crashed worker is untouched while its lease lives and picked up again when it has expired', async () => {
    const u = await pushUser('crashrecv@example.com');
    await addNotification(u.userId, 'MATCH_INVITATION', { title: 'Crash' });
    const fake = fakeExpo();
    await run(fake);
    const [d] = await deliveries();
    await sql(`UPDATE push_delivery SET next_receipt_at = now() - interval '1 second', receipt_claim_id = gen_random_uuid(), receipt_locked_until = now() + interval '1 minute' WHERE id = '${d!.id}'`);
    await run(fake);
    expect(fake.receiptCalls).toHaveLength(0); // somebody is checking it right now
    await sql(`UPDATE push_delivery SET receipt_locked_until = now() - interval '1 second' WHERE id = '${d!.id}'`);
    await run(fake);
    expect(fake.receiptCalls).toEqual([[d!.ticket_id]]); // its lease ran out: checked again
    expect(await deliveryOf(d!.id)).toMatchObject({ status: 'DELIVERED', receipt_claim_id: null, receipt_locked_until: null });
    expect(fake.sent).toHaveLength(1); // never sent again
  });

  it('concurrent receipt checks ask for every ticket exactly once', async () => {
    const u = await pushUser('manyrecv@example.com');
    for (let i = 0; i < 40; i++) await addNotification(u.userId, 'MATCH_CANCELLED', { title: `G${i}` });
    const fake = fakeExpo();
    await run(fake, { rate: { perSecond: 5000, capacity: 5000 } });
    await makeReceiptsDue();
    await Promise.all([1, 2, 3, 4].map(() => run(fake)));
    const asked = fake.receiptCalls.flat();
    expect(asked).toHaveLength(40);
    expect(new Set(asked).size).toBe(40);
    expect((await deliveries()).every((d) => d.status === 'DELIVERED')).toBe(true);
  });
});

void makeDue;
