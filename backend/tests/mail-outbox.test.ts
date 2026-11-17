import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, PASSWORD, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;

const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const worker = () => import('../src/jobs/mail-worker');
const outboxLib = () => import('../src/lib/mail-outbox');
const mailer = () => import('../src/lib/mailer');

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  (await mailer()).testOutbox.length = 0;
});

/** A trigger that makes writes to one table fail, to prove that the business operation and its outbox row succeed or fail together. */
async function failWritesOn(table: string, event: 'INSERT' | 'UPDATE', fn: () => Promise<void>) {
  const prisma = await prismaP();
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION mail_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_mail_test_fail BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION mail_test_fail()`);
  try {
    await fn();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_mail_test_fail ON "${table}"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS mail_test_fail()`);
  }
}

const register = (email: string, locale: 'ar' | 'en' = 'en') =>
  api.call('POST', '/api/v1/auth/register', { email, password: PASSWORD, fullName: 'New Player', locale });
const rowsFor = async (email: string) => (await prismaP()).mailOutbox.findMany({ where: { toEmail: email }, orderBy: { createdAt: 'asc' } });

/** Inserts an outbox row directly (the producer is tested through the API elsewhere), with a real encrypted token. */
async function seedRow(userId: string, over: Record<string, unknown> = {}) {
  const prisma = await prismaP();
  const { encryptOutboxToken } = await outboxLib();
  const id = randomUUID();
  const token = `tok-${id}`;
  await prisma.mailOutbox.create({
    data: {
      id,
      userId,
      kind: 'PASSWORD_RESET',
      toEmail: `${id.slice(0, 8)}@example.com`,
      locale: 'en',
      tokenEnc: encryptOutboxToken(token, id),
      expiresAt: new Date(Date.now() + 3_600_000),
      ...over,
    } as never,
  });
  return { id, token };
}

/** A fake transport that records what was "sent". */
function recorder(delayMs = 0) {
  const sent: { to: string; text: string; messageId: string }[] = [];
  const send = async (email: { to: string; text: string }, messageId: string) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    sent.push({ to: email.to, text: email.text, messageId });
  };
  return { sent, send };
}
const makeAccounts = async (n: number): Promise<TestUser[]> => {
  const users: TestUser[] = [];
  for (let i = 0; i < n; i++) users.push(await makeUser(api, `mailuser${i}@example.com`, { verified: false, profile: false }));
  await (await prismaP()).mailOutbox.deleteMany({}); // registering queued a verification e-mail per account: these tests start from an empty queue
  (await mailer()).testOutbox.length = 0;
  return users;
};
const statusOf = async (id: string) => (await (await prismaP()).mailOutbox.findUniqueOrThrow({ where: { id } }));

// ───────────────────────────── producer: atomic with the business operation ─────────────────────────────

describe('registration, resend and forgot-password queue their e-mail atomically', () => {
  it('registration: the response does not wait for any sending; token and queued message exist together; the worker then delivers the normal template', async () => {
    const prisma = await prismaP();
    const res = await register('newbie@example.com', 'en');
    expect(res.status).toBe(201);
    expect((await mailer()).testOutbox).toHaveLength(0); // nothing was sent inline

    const rows = await rowsFor('newbie@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'EMAIL_VERIFY', status: 'PENDING', locale: 'en', attempts: 0 });
    expect(await prisma.userToken.count({ where: { userId: rows[0]!.userId, type: 'EMAIL_VERIFY', usedAt: null } })).toBe(1);

    expect((await (await worker()).runMailWorkerOnce()).sent).toBe(1);
    const sent = (await mailer()).testOutbox;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'newbie@example.com', subject: 'Confirm your e-mail - Find Your Match' });
    expect(sent[0]!.text).toMatch(/token=[\w-]+/);
    expect(await statusOf(rows[0]!.id)).toMatchObject({ status: 'SENT', tokenEnc: null });
  });

  it('the Arabic template is used for an Arabic account', async () => {
    await register('arabic@example.com', 'ar');
    await (await worker()).runMailWorkerOnce();
    expect((await mailer()).testOutbox[0]!.subject).toContain('تأكيد بريدك الإلكتروني');
  });

  it('registration: if queueing fails, NO account, token or message is left behind', async () => {
    const prisma = await prismaP();
    await failWritesOn('mail_outbox', 'INSERT', async () => {
      expect((await register('rollback@example.com')).status).toBe(500);
    });
    expect(await prisma.user.count({ where: { email: 'rollback@example.com' } })).toBe(0);
    expect(await prisma.userToken.count()).toBe(0);
    expect(await prisma.mailOutbox.count()).toBe(0);
    expect((await register('rollback@example.com')).status).toBe(201); // and the address can still be registered
  });

  it('registration: an e-mail that is already taken queues nothing', async () => {
    await register('taken@example.com');
    expect((await register('TAKEN@example.com')).status).toBe(409);
    expect(await (await prismaP()).mailOutbox.count()).toBe(1);
  });

  it('resend: replaces the queued message (older one is superseded) and the token; on failure the previous token and message are untouched', async () => {
    const prisma = await prismaP();
    await register('resend@example.com');
    const [first] = await rowsFor('resend@example.com');
    const login = await api.call('POST', '/api/v1/auth/login', { email: 'resend@example.com', password: PASSWORD });
    const token = login.body.accessToken as string;
    const oldTokenId = (await prisma.userToken.findFirstOrThrow({ where: { userId: first!.userId, type: 'EMAIL_VERIFY', usedAt: null } })).id;

    await failWritesOn('mail_outbox', 'INSERT', async () => {
      expect((await api.call('POST', '/api/v1/auth/resend-verification', {}, token)).status).toBe(500);
    });
    expect(await prisma.userToken.findUnique({ where: { id: oldTokenId } })).not.toBeNull(); // rolled back with it
    expect((await statusOf(first!.id)).status).toBe('PENDING');

    expect((await api.call('POST', '/api/v1/auth/resend-verification', {}, token)).status).toBeLessThan(300);
    const rows = await rowsFor('resend@example.com');
    expect(rows.map((r) => r.status)).toEqual(['CANCELLED', 'PENDING']);
    expect(rows[0]).toMatchObject({ lastError: 'SUPERSEDED', tokenEnc: null });
    expect(await prisma.userToken.count({ where: { userId: first!.userId, type: 'EMAIL_VERIFY', usedAt: null } })).toBe(1);
    await (await worker()).runMailWorkerOnce();
    expect((await mailer()).testOutbox).toHaveLength(1); // only the newest link is delivered
  });

  it('resend: an already verified address is refused and queues nothing', async () => {
    const u = await makeUser(api, 'verified@example.com'); // verified
    const before = await (await prismaP()).mailOutbox.count();
    expect((await api.call('POST', '/api/v1/auth/resend-verification', {}, u.token)).status).toBe(409);
    expect(await (await prismaP()).mailOutbox.count()).toBe(before);
  });

  it('forgot-password: the reset token and its message are created together, or neither (a queueing failure is not reported to the caller)', async () => {
    const prisma = await prismaP();
    const u = await makeUser(api, 'forgot@example.com');
    await prisma.mailOutbox.deleteMany({});
    await failWritesOn('mail_outbox', 'INSERT', async () => {
      const res = await api.call('POST', '/api/v1/auth/forgot-password', { email: 'forgot@example.com' });
      expect(res.status).toBe(202);
    });
    expect(await prisma.userToken.count({ where: { userId: u.userId, type: 'PASSWORD_RESET' } })).toBe(0);
    expect(await prisma.mailOutbox.count()).toBe(0);

    expect((await api.call('POST', '/api/v1/auth/forgot-password', { email: 'forgot@example.com' })).status).toBe(202);
    expect(await prisma.userToken.count({ where: { userId: u.userId, type: 'PASSWORD_RESET', usedAt: null } })).toBe(1);
    expect(await prisma.mailOutbox.count({ where: { userId: u.userId, kind: 'PASSWORD_RESET', status: 'PENDING' } })).toBe(1);
  });
});

// ───────────────────────────── the secret in the outbox ─────────────────────────────

describe('the one-time token in the outbox', () => {
  it('is stored encrypted, bound to its row, and wiped when the message is finished', async () => {
    const prisma = await prismaP();
    const { encryptOutboxToken, decryptOutboxToken } = await outboxLib();
    const [u] = await makeAccounts(1);
    const { id, token } = await seedRow(u!.userId);
    const row = await statusOf(id);
    expect(row.tokenEnc).not.toBeNull();
    expect(row.tokenEnc).not.toContain(token);
    expect(decryptOutboxToken(row.tokenEnc!, id)).toBe(token);
    expect(() => decryptOutboxToken(row.tokenEnc!, randomUUID())).toThrow(); // cannot be moved to another row
    expect(encryptOutboxToken(token, id)).not.toBe(encryptOutboxToken(token, id)); // fresh IV every time

    const { send } = recorder();
    await (await worker()).runMailWorkerOnce({ send });
    expect(await statusOf(id)).toMatchObject({ status: 'SENT', tokenEnc: null });
    // the database itself refuses a finished row that still holds a secret
    await expect(prisma.$executeRawUnsafe(`UPDATE mail_outbox SET token_enc = 'x' WHERE id = '${id}'`)).rejects.toThrow(/chk_mail_outbox_secret_lifecycle/);
  });

  it('never reaches the logs: not the token, not the address, not the mail text', async () => {
    const { logger } = await import('../src/lib/logger');
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((l) => vi.spyOn(logger, l));
    try {
      const [u] = await makeAccounts(1);
      const failing = await seedRow(u!.userId);
      const permanent = await seedRow(u!.userId);
      await (await worker()).runMailWorkerOnce({
        send: async (email) => {
          throw Object.assign(new Error(`550 rejected ${email.to}: ${email.text}`), { responseCode: email.to === (await statusOf(permanent.id)).toEmail ? 550 : 421 });
        },
      });
      const logged = inspect(spies.flatMap((s) => s.mock.calls), { depth: 6, breakLength: Infinity });
      expect(logged).toContain('mail outbox'); // it did log something
      for (const row of [failing, permanent]) {
        expect(logged).not.toContain(row.token);
        expect(logged).not.toContain((await statusOf(row.id)).toEmail);
      }
      expect(logged).not.toContain('Open this link');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ───────────────────────────── worker: claiming, retries, crashes ─────────────────────────────

describe('the worker', () => {
  it('concurrent workers never send the same message twice, and nothing is skipped', async () => {
    const accounts = await makeAccounts(3);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push((await seedRow(accounts[i % 3]!.userId)).id);
    const { sent, send } = recorder(15);
    const { runMailWorkerOnce } = await worker();
    const results = await Promise.all([1, 2, 3, 4].map(() => runMailWorkerOnce({ send })));

    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(30);
    const counts = new Map<string, number>();
    for (const s of sent) counts.set(s.messageId, (counts.get(s.messageId) ?? 0) + 1);
    expect(counts.size).toBe(30);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    const rows = await (await prismaP()).mailOutbox.findMany();
    expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1 && r.tokenEnc === null)).toBe(true);
  });

  it('claiming skips a row another worker is holding (SKIP LOCKED) instead of waiting for it or taking it too', async () => {
    const prisma = await prismaP();
    const [u] = await makeAccounts(1);
    const first = await seedRow(u!.userId, { nextAttemptAt: new Date(Date.now() - 60_000) }); // the one a worker would take first
    const second = await seedRow(u!.userId, { nextAttemptAt: new Date(Date.now() - 30_000) });
    const { runMailWorkerOnce } = await worker();
    const { sent, send } = recorder();

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM mail_outbox WHERE id = ${first.id}::uuid FOR UPDATE`; // another worker is in the middle of claiming it
      const r = await runMailWorkerOnce({ send, maxMessages: 5 }); // would block here without SKIP LOCKED
      expect(r.sent).toBe(1);
      expect(sent.map((m) => m.messageId)).toEqual([expect.stringContaining(second.id)]);
    });
    expect((await statusOf(first.id)).status).toBe('PENDING'); // untouched, still waiting for whoever holds it
    expect((await statusOf(second.id)).status).toBe('SENT');
  }, 15_000);

  it('a transient failure is retried with backoff, up to the attempt limit, then ends as FAILED with the secret wiped', async () => {
    const prisma = await prismaP();
    const [u] = await makeAccounts(1);
    const { id } = await seedRow(u!.userId);
    const { runMailWorkerOnce, MAX_ATTEMPTS } = await worker();
    const down = async () => {
      throw Object.assign(new Error('connect'), { code: 'ETIMEDOUT' });
    };

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(await runMailWorkerOnce({ send: down })).toMatchObject({ retried: 1, failed: 0 });
      const row = await statusOf(id);
      expect(row).toMatchObject({ status: 'PENDING', attempts: attempt, lastError: 'ETIMEDOUT', claimId: null, lockedUntil: null });
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // backed off, not retried straight away
      expect(await runMailWorkerOnce({ send: down })).toMatchObject({ sent: 0, retried: 0, failed: 0 }); // not due yet
      await prisma.$executeRawUnsafe(`UPDATE mail_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = '${id}'`);
    }
    expect(await runMailWorkerOnce({ send: down })).toMatchObject({ failed: 1 });
    expect(await statusOf(id)).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS, lastError: 'ETIMEDOUT', tokenEnc: null });
    expect(await runMailWorkerOnce({ send: down })).toMatchObject({ sent: 0, retried: 0, failed: 0 }); // terminal: never picked again
  });

  it('a retry that succeeds delivers once and clears the error', async () => {
    const [u] = await makeAccounts(1);
    const { id } = await seedRow(u!.userId);
    const { runMailWorkerOnce } = await worker();
    await runMailWorkerOnce({ send: async () => { throw Object.assign(new Error('x'), { responseCode: 421 }); } });
    await (await prismaP()).$executeRawUnsafe(`UPDATE mail_outbox SET next_attempt_at = now() WHERE id = '${id}'`);
    const { sent, send } = recorder();
    expect(await runMailWorkerOnce({ send })).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(await statusOf(id)).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
  });

  it('a refused recipient (SMTP 550) is terminal at once', async () => {
    const [u] = await makeAccounts(1);
    const { id } = await seedRow(u!.userId);
    const r = await (await worker()).runMailWorkerOnce({ send: async () => { throw Object.assign(new Error('no such user'), { responseCode: 550 }); } });
    expect(r).toMatchObject({ failed: 1, retried: 0 });
    expect(await statusOf(id)).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'SMTP_550', tokenEnc: null });
  });

  it('a send that never finishes is cut off by the deadline and retried', async () => {
    const [u] = await makeAccounts(1);
    const { id } = await seedRow(u!.userId);
    const started = Date.now();
    const r = await (await worker()).runMailWorkerOnce({ send: () => new Promise(() => {}), sendDeadlineMs: 150 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toMatchObject({ retried: 1 });
    expect(await statusOf(id)).toMatchObject({ status: 'PENDING', lastError: 'SEND_TIMEOUT' });
  });

  it('a message whose link has already expired is cancelled instead of sent', async () => {
    const [u] = await makeAccounts(1);
    const { id } = await seedRow(u!.userId, { expiresAt: new Date(Date.now() - 1000) });
    const { sent, send } = recorder();
    expect(await (await worker()).runMailWorkerOnce({ send })).toMatchObject({ cancelled: 1, sent: 0 });
    expect(sent).toHaveLength(0);
    expect(await statusOf(id)).toMatchObject({ status: 'CANCELLED', lastError: 'EXPIRED', tokenEnc: null });
  });

  it('rotating the JWT secret leaves queued mail untouched; rotating the mail key ends old queued mail as DECRYPT_FAILED (documented)', async () => {
    const { env } = await import('../src/config/env');
    const { randomBytes } = await import('node:crypto');
    const [u] = await makeAccounts(1);
    const queued = await seedRow(u!.userId);
    const { runMailWorkerOnce } = await worker();
    const jwt = env.JWT_ACCESS_SECRET;
    const key = env.MAIL_OUTBOX_ENCRYPTION_KEY;
    try {
      env.JWT_ACCESS_SECRET = 'a completely different jwt secret, 40+ characters long';
      const first = recorder();
      expect(await runMailWorkerOnce({ send: first.send })).toMatchObject({ sent: 1, failed: 0 }); // unaffected
      expect(first.sent[0]!.text).toContain(queued.token);

      env.JWT_ACCESS_SECRET = jwt;
      const old = await seedRow(u!.userId); // queued under the current mail key
      env.MAIL_OUTBOX_ENCRYPTION_KEY = randomBytes(32).toString('base64url'); // the key is rotated
      const second = recorder();
      expect(await runMailWorkerOnce({ send: second.send })).toMatchObject({ sent: 0, failed: 1 });
      expect(second.sent).toHaveLength(0);
      expect(await statusOf(old.id)).toMatchObject({ status: 'FAILED', lastError: 'DECRYPT_FAILED', tokenEnc: null });
    } finally {
      env.JWT_ACCESS_SECRET = jwt;
      env.MAIL_OUTBOX_ENCRYPTION_KEY = key;
    }
  });

  it('a token that cannot be decrypted (secret rotated or row tampered with) is a terminal failure, nothing is sent', async () => {
    const [u] = await makeAccounts(1);
    const { id } = await seedRow(u!.userId, { tokenEnc: 'bm90LWEtcmVhbC1jaXBoZXJ0ZXh0LWF0LWFsbC0xMjM0NTY3ODkwMTIzNDU2Nzg5MA' });
    const { sent, send } = recorder();
    expect(await (await worker()).runMailWorkerOnce({ send })).toMatchObject({ failed: 1 });
    expect(sent).toHaveLength(0);
    expect(await statusOf(id)).toMatchObject({ status: 'FAILED', lastError: 'DECRYPT_FAILED', tokenEnc: null });
  });

  describe('a crashed worker loses nothing', () => {
    it('a message left in SENDING is NOT touched while its lease is alive, and is claimed again once the lease has expired', async () => {
      const prisma = await prismaP();
      const [u] = await makeAccounts(1);
      const { id } = await seedRow(u!.userId);
      // what a worker that died right after claiming leaves behind
      await prisma.$executeRawUnsafe(`UPDATE mail_outbox SET status = 'SENDING', claim_id = gen_random_uuid(), locked_until = now() + interval '1 minute', attempts = 1 WHERE id = '${id}'`);
      const { sent, send } = recorder();
      const { runMailWorkerOnce } = await worker();
      expect(await runMailWorkerOnce({ send })).toMatchObject({ sent: 0 });
      expect(sent).toHaveLength(0);

      await prisma.$executeRawUnsafe(`UPDATE mail_outbox SET locked_until = now() - interval '1 second' WHERE id = '${id}'`);
      expect(await runMailWorkerOnce({ send })).toMatchObject({ sent: 1 });
      expect(sent).toHaveLength(1);
      expect(await statusOf(id)).toMatchObject({ status: 'SENT', attempts: 2, tokenEnc: null });
    });

    it('a message that keeps killing its worker still ends as FAILED after the attempt limit (attempts are counted when claiming)', async () => {
      const prisma = await prismaP();
      const [u] = await makeAccounts(1);
      const { id } = await seedRow(u!.userId);
      const { MAX_ATTEMPTS, runMailWorkerOnce } = await worker();
      await prisma.$executeRawUnsafe(`UPDATE mail_outbox SET status = 'SENDING', claim_id = gen_random_uuid(), locked_until = now() - interval '1 second', attempts = ${MAX_ATTEMPTS} WHERE id = '${id}'`);
      const { sent, send } = recorder();
      expect(await runMailWorkerOnce({ send })).toMatchObject({ failed: 1, sent: 0 });
      expect(sent).toHaveLength(0);
      expect(await statusOf(id)).toMatchObject({ status: 'FAILED', lastError: 'WORKER_CRASHED', tokenEnc: null });
    });

    it('a worker whose lease expired mid-send cannot overwrite the result of the worker that took over (and the possible duplicate is the documented at-least-once case)', async () => {
      const prisma = await prismaP();
      const [u] = await makeAccounts(1);
      const { id } = await seedRow(u!.userId);
      const { runMailWorkerOnce } = await worker();

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow = recorder();
      const slowSend = async (e: { to: string; text: string }, m: string) => {
        await gate; // the slow worker is stuck inside SMTP
        await slow.send(e, m);
      };
      const slowRun = runMailWorkerOnce({ send: slowSend });
      for (let i = 0; i < 100 && (await statusOf(id)).status !== 'SENDING'; i++) await new Promise((r) => setTimeout(r, 20));
      expect((await statusOf(id)).status).toBe('SENDING');
      await prisma.$executeRawUnsafe(`UPDATE mail_outbox SET locked_until = now() - interval '1 second' WHERE id = '${id}'`); // its lease runs out

      const fast = recorder();
      expect(await runMailWorkerOnce({ send: fast.send })).toMatchObject({ sent: 1 }); // another worker takes over and sends
      expect((await statusOf(id)).attempts).toBe(2);

      release();
      const late = await slowRun;
      expect(late).toMatchObject({ sent: 0, lostClaim: 1 }); // its result was NOT recorded
      expect(await statusOf(id)).toMatchObject({ status: 'SENT', attempts: 2, tokenEnc: null });
      expect(fast.sent[0]!.messageId).toBe(slow.sent[0]!.messageId); // both copies carry the same Message-ID: a mail system can recognize the duplicate
    });
  });

  it('removes old finished rows but never queued ones', async () => {
    const prisma = await prismaP();
    const [u] = await makeAccounts(1);
    const old = await seedRow(u!.userId);
    const recent = await seedRow(u!.userId);
    const queued = await seedRow(u!.userId);
    await prisma.$executeRawUnsafe(`UPDATE mail_outbox SET status = 'SENT', sent_at = now() - interval '8 days', finished_at = now() - interval '8 days', token_enc = NULL WHERE id = '${old.id}'`);
    await prisma.$executeRawUnsafe(`UPDATE mail_outbox SET status = 'SENT', sent_at = now(), finished_at = now(), token_enc = NULL WHERE id = '${recent.id}'`);
    expect(await (await worker()).purgeFinishedMail()).toBe(1);
    const left = (await prisma.mailOutbox.findMany()).map((r) => r.id).sort();
    expect(left).toEqual([recent.id, queued.id].sort());
  });

  it('backoff grows, is jittered within +-20%, and repeats the last step', async () => {
    const { backoffMs, BACKOFF_MS } = await worker();
    for (let attempt = 1; attempt <= BACKOFF_MS.length + 2; attempt++) {
      const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1]!;
      expect(backoffMs(attempt, () => 0)).toBe(Math.round(base * 0.8));
      expect(backoffMs(attempt, () => 1)).toBe(Math.round(base * 1.2));
    }
    expect(BACKOFF_MS).toEqual([...BACKOFF_MS].sort((a, b) => a - b));
  });
});

// ───────────────────────────── scheduling ─────────────────────────────

describe('the scheduled worker', () => {
  it('sends on its own, a kick makes it look at the queue at once, and stopping waits for the pass in progress', async () => {
    const { scheduleMailWorker, kickMailWorker } = await worker();
    const stop = scheduleMailWorker(60_000); // the poll is far away: only the kick can explain a fast delivery
    try {
      expect((await register('scheduled@example.com')).status).toBe(201); // register kicks the worker
      let sentNow = false;
      for (let i = 0; i < 100 && !sentNow; i++) {
        await new Promise((r) => setTimeout(r, 50));
        sentNow = (await mailer()).testOutbox.some((m) => m.to === 'scheduled@example.com');
      }
      expect(sentNow).toBe(true);
      expect(() => kickMailWorker()).not.toThrow();
    } finally {
      await stop();
    }
    expect(() => kickMailWorker()).not.toThrow(); // a no-op once stopped
  });
});

// ───────────────────────────── forgot-password: no account discovery ─────────────────────────────

describe('forgot-password does not reveal whether an account exists (AUTH-02)', () => {
  const forgot = (email: string) => api.call('POST', '/api/v1/auth/forgot-password', { email });

  it('answers identically for an existing, an unknown and a suspended account, and sends nothing inline', async () => {
    const prisma = await prismaP();
    const real = await makeUser(api, 'real@example.com');
    const suspended = await makeUser(api, 'suspended@example.com');
    await prisma.user.update({ where: { id: suspended.userId }, data: { status: 'SUSPENDED' } });
    await prisma.mailOutbox.deleteMany({});
    (await mailer()).testOutbox.length = 0;

    const a = await forgot('real@example.com');
    const b = await forgot('nobody@example.com');
    const c = await forgot('suspended@example.com');
    const d = await forgot('REAL@example.com'); // case variants are the same account
    for (const res of [a, b, c, d]) {
      expect(res.status).toBe(202);
      expect({ ...res.body, error: undefined }).toEqual({ ...a.body });
      expect(JSON.stringify(res.body)).toBe(JSON.stringify(a.body));
    }
    expect((await mailer()).testOutbox).toHaveLength(0); // no SMTP work inside the request
    expect(await prisma.mailOutbox.count({ where: { userId: real.userId } })).toBe(2); // two requests for `real`: the older message was superseded
    expect(await prisma.mailOutbox.count({ where: { userId: real.userId, status: 'CANCELLED', lastError: 'SUPERSEDED' } })).toBe(1);
    expect(await prisma.mailOutbox.count({ where: { userId: real.userId, status: 'PENDING' } })).toBe(1);
    expect(await prisma.mailOutbox.count({ where: { userId: suspended.userId } })).toBe(0);
    expect(await prisma.mailOutbox.count()).toBe(2); // nothing for the unknown, the suspended or the case-variant duplicate beyond `real`
  });

  it('takes the same time whether or not the account exists (a fixed minimum duration hides the difference)', async () => {
    await makeUser(api, 'timing@example.com');
    const time = async (email: string) => {
      const t0 = performance.now();
      await forgot(email);
      return performance.now() - t0;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 6; i++) {
      known.push(await time('timing@example.com'));
      unknown.push(await time(`ghost${i}@example.com`));
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    expect(Math.min(...known)).toBeGreaterThanOrEqual(240);
    expect(Math.min(...unknown)).toBeGreaterThanOrEqual(240);
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(60);
  });

  it('the queued reset e-mail still works end to end: the link token resets the password once', async () => {
    await makeUser(api, 'reset@example.com');
    await forgot('reset@example.com');
    const { lastEmailToken } = await import('./helpers/client');
    const token = await lastEmailToken('reset@example.com');
    expect((await api.call('POST', '/api/v1/auth/reset-password', { token, newPassword: 'a brand new password 1' })).status).toBe(200);
    expect((await api.call('POST', '/api/v1/auth/reset-password', { token, newPassword: 'another password 2' })).status).toBe(400); // single use
    expect((await api.call('POST', '/api/v1/auth/login', { email: 'reset@example.com', password: 'a brand new password 1' })).status).toBe(200);
  });
});
