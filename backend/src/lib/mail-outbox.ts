import { randomUUID } from 'node:crypto';
import type { MailKind, Prisma } from '@prisma/client';
import { env } from '../config/env';
import { decryptSecret, encryptSecret } from './crypto';
import { decodeMailKey } from './mail-key';

/*
 * E-mail outbox, producer side (MAIL-01). The consumer is src/jobs/mail-worker.ts.
 *
 * The one-time token goes into the outbox ENCRYPTED (AES-256-GCM), with the row id as associated data. The key is the dedicated
 * MAIL_OUTBOX_ENCRYPTION_KEY (lib/mail-key.ts): nothing else uses it and it is NOT derived from JWT_ACCESS_SECRET, so rotating
 * the JWT signing secret does not touch queued mail. Rotating the mail key does: messages still queued under the old key
 * cannot be decrypted; the worker ends them as FAILED (DECRYPT_FAILED) and affected users request a new link. There is no key
 * versioning on purpose: to rotate without losing anything, let the queue drain first (README, "E-mail outbox").
 */

const key = () => decodeMailKey(env.MAIL_OUTBOX_ENCRYPTION_KEY);

export function encryptOutboxToken(rawToken: string, outboxId: string): string {
  return encryptSecret(rawToken, key(), outboxId);
}

export function decryptOutboxToken(blob: string, outboxId: string): string {
  return decryptSecret(blob, key(), outboxId);
}

export interface QueuedMail {
  userId: string;
  /** Recipient address at the time of the request. */
  email: string;
  locale: 'ar' | 'en';
  kind: MailKind;
  /** The raw one-time token that goes into the link. It is encrypted before it is stored. */
  rawToken: string;
  /** When the token stops working: a message that is still queued after this moment is cancelled instead of sent. */
  expiresAt: Date;
}

/**
 * Queues one message INSIDE the caller's transaction, so it exists if and only if the business operation commits
 * (the token and the outbox row are written together or not at all). Older still-queued messages of the same kind for the
 * same user are cancelled: only the newest link works, so sending an older one would only deliver a dead link.
 * Call `kickMailWorker()` after the transaction commits to send without waiting for the next poll.
 */
export async function enqueueMail(tx: Prisma.TransactionClient, mail: QueuedMail): Promise<string> {
  const id = randomUUID();
  await tx.mailOutbox.updateMany({
    where: { userId: mail.userId, kind: mail.kind, status: 'PENDING' },
    data: { status: 'CANCELLED', tokenEnc: null, finishedAt: new Date(), lastError: 'SUPERSEDED' },
  });
  await tx.mailOutbox.create({
    data: {
      id,
      userId: mail.userId,
      kind: mail.kind,
      toEmail: mail.email,
      locale: mail.locale,
      tokenEnc: encryptOutboxToken(mail.rawToken, id),
      expiresAt: mail.expiresAt,
    },
  });
  return id;
}
