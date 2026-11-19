import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto';
import { resetDb, startApp } from './helpers/client';
import { makeUser, PASSWORD, type TestUser } from './helpers/users';

/*
 * PRIV-01 review fix: nothing is e-mailed to a DELETED (anonymized) account. Such rows are never claimed (they are finished as FAILED with
 * ACCOUNT_DELETED), a row claimed just before the deletion is re-checked immediately before the send, and what cannot be prevented, a deletion
 * that commits while the SMTP exchange is already under way, is pinned down as the documented in-flight case.
 */

let api: Awaited<ReturnType<typeof startApp>>;
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const worker = () => import('../src/jobs/mail-worker');
const outboxLib = () => import('../src/lib/mail-outbox');

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

/** An account (registering queued a verification mail: the queue is emptied so each test starts clean). */
async function account(email: string, status: 'ACTIVE' | 'SUSPENDED' | 'DELETED' = 'ACTIVE'): Promise<TestUser> {
  const user = await makeUser(api, email, { verified: false, profile: false });
  const prisma = await prismaP();
  await prisma.mailOutbox.deleteMany({});
  if (status !== 'ACTIVE') await prisma.user.update({ where: { id: user.userId }, data: { status } });
  return user;
}

async function seedRow(userId: string, over: Record<string, unknown> = {}) {
  const prisma = await prismaP();
  const { encryptOutboxToken } = await outboxLib();
  const id = randomUUID();
  await prisma.mailOutbox.create({
    data: { id, userId, kind: 'PASSWORD_RESET', toEmail: `${id.slice(0, 8)}@example.com`, locale: 'en', tokenEnc: encryptOutboxToken(`tok-${id}`, id), expiresAt: new Date(Date.now() + 3_600_000), ...over } as never,
  });
  return id;
}
const row = async (id: string) => (await prismaP()).mailOutbox.findUnique({ where: { id } });

function recorder() {
  const sent: { to: string; messageId: string }[] = [];
  return { sent, send: async (email: { to: string }, messageId: string) => void sent.push({ to: email.to, messageId }) };
}

describe('mail for a deleted recipient (PRIV-01)', () => {
  it('a queued message for a DELETED account is never sent: it is finished as FAILED / ACCOUNT_DELETED with its token wiped; other recipients are unaffected', async () => {
    const gone = await account('gone@example.com', 'DELETED');
    const live = await account('live@example.com');
    const queued = await seedRow(gone.userId);
    const abandoned = await seedRow(gone.userId, { status: 'SENDING', claimId: randomUUID(), lockedUntil: new Date(Date.now() - 60_000), attempts: 1 }); // a dead worker's lease
    const control = await seedRow(live.userId);
    const rec = recorder();

    const result = await (await worker()).runMailWorkerOnce({ send: rec.send });

    expect(rec.sent).toHaveLength(1); // only the live account's message
    expect(result).toMatchObject({ sent: 1, failed: 2 });
    for (const id of [queued, abandoned]) {
      expect(await row(id)).toMatchObject({ status: 'FAILED', lastError: 'ACCOUNT_DELETED', tokenEnc: null, claimId: null, lockedUntil: null });
      expect((await row(id))!.finishedAt).not.toBeNull();
    }
    expect((await row(control))!.status).toBe('SENT');
    // idempotent
    expect(await (await worker()).runMailWorkerOnce({ send: rec.send })).toMatchObject({ sent: 0, failed: 0 });
  });

  it('a message claimed just before the account was deleted is not sent: the check right before the send sees the deletion and finishes it as FAILED', async () => {
    const user = await account('claimed@example.com');
    const id = await seedRow(user.userId);
    const prisma = await prismaP();
    // the claim itself deletes the account, in the same statement: after it the row is OUR claim and its recipient is DELETED
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION mail_priv01_delete_on_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'SENDING' AND OLD.status = 'PENDING' THEN UPDATE "user" SET status = 'DELETED' WHERE id = NEW.user_id; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_mail_priv01_delete_on_claim BEFORE UPDATE ON mail_outbox FOR EACH ROW EXECUTE FUNCTION mail_priv01_delete_on_claim()`);
    const rec = recorder();
    try {
      const result = await (await worker()).runMailWorkerOnce({ send: rec.send });
      expect(result).toMatchObject({ sent: 0, failed: 1, lostClaim: 0 });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_mail_priv01_delete_on_claim ON mail_outbox`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS mail_priv01_delete_on_claim()`);
    }
    expect(rec.sent).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: 'FAILED', lastError: 'ACCOUNT_DELETED', tokenEnc: null });
  });

  it('IN-FLIGHT (documented, unavoidable): a deletion that commits while the message is already being handed to the mail server does not stop that one message, and nothing is sent twice or left behind', async () => {
    const prisma = await prismaP();
    const user = await makeUser(api, 'inflight@example.com', { verified: false, profile: false });
    await prisma.mailOutbox.deleteMany({});
    const id = await seedRow(user.userId);
    const sent: string[] = [];
    const send = async (email: { to: string }) => {
      sent.push(email.to);
      // the account is deleted for real (cleanup, anonymization, outbox rows erased) while the SMTP exchange is under way
      expect((await api.call('POST', '/api/v1/users/me/delete', { password: PASSWORD }, user.token)).status).toBe(204);
    };

    const result = await (await worker()).runMailWorkerOnce({ send });

    expect(sent).toHaveLength(1); // the message that was already on its way still went out, once
    expect(result).toMatchObject({ sent: 0, lostClaim: 1 }); // its row was erased by the deletion, so the result could not be recorded
    expect(await row(id)).toBeNull();
    expect(await prisma.mailOutbox.count({ where: { userId: user.userId } })).toBe(0);
    expect(await prisma.userToken.count({ where: { userId: user.userId } })).toBe(0); // the link in that message is dead
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).status).toBe('DELETED');
    // and the next pass has nothing to send
    expect(await (await worker()).runMailWorkerOnce({ send })).toMatchObject({ sent: 0, retried: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('an ACTIVE or SUSPENDED recipient is unaffected: the message is sent exactly as before, and a transient failure is still retried', async () => {
    const live = await account('retry@example.com');
    const suspended = await account('suspended@example.com', 'SUSPENDED');
    const a = await seedRow(live.userId);
    const b = await seedRow(suspended.userId);
    const rec = recorder();
    expect(await (await worker()).runMailWorkerOnce({ send: rec.send })).toMatchObject({ sent: 2, failed: 0 });
    expect(rec.sent).toHaveLength(2);
    expect((await row(a))!.status).toBe('SENT');
    expect((await row(b))!.status).toBe('SENT');

    const c = await seedRow(live.userId);
    const { MailDeliveryError } = await import('../src/lib/mailer');
    const failing = async () => {
      throw new MailDeliveryError('temporary', 'SMTP_TEMP', false);
    };
    expect(await (await worker()).runMailWorkerOnce({ send: failing })).toMatchObject({ sent: 0, retried: 1 });
    expect(await row(c)).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'SMTP_TEMP' });
  });
});

describe('verify e-mail (PRIV-01)', () => {
  const tokenFor = async (userId: string, type: 'EMAIL_VERIFY' | 'PASSWORD_RESET' = 'EMAIL_VERIFY') => {
    const raw = `${type}-${randomUUID()}-${randomUUID()}`.slice(0, 60);
    await (await prismaP()).userToken.create({ data: { userId, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 3_600_000) } });
    return raw;
  };

  it('a verification link never acts on an account that is not ACTIVE (and is not consumed); an ACTIVE account still verifies', async () => {
    const prisma = await prismaP();
    const live = await account('verify-live@example.com');
    const suspended = await account('verify-suspended@example.com', 'SUSPENDED');
    const deleted = await account('verify-deleted@example.com', 'DELETED');

    for (const user of [suspended, deleted]) {
      const raw = await tokenFor(user.userId);
      const res = await api.call('POST', '/api/v1/auth/verify-email', { token: raw });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).emailVerifiedAt).toBeNull();
      expect((await prisma.userToken.findFirstOrThrow({ where: { tokenHash: sha256(raw) } })).usedAt).toBeNull(); // rolled back, not consumed
    }

    const ok = await api.call('POST', '/api/v1/auth/verify-email', { token: await tokenFor(live.userId) });
    expect(ok.status).toBeLessThan(300);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: live.userId } })).emailVerifiedAt).not.toBeNull();
  });
});
