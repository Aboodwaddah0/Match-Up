import type { AddressInfo } from 'node:net';

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function startApp() {
  const { createApp } = await import('../../src/app');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  return { base, server, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function resetDb(): Promise<void> {
  const { prisma } = await import('../../src/lib/prisma');
  // admin_audit_log refuses TRUNCATE (AUD-01); a test reset must empty everything, so the guard is off for this one transaction only.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE admin_audit_log DISABLE TRIGGER trg_admin_audit_no_truncate'),
    prisma.$executeRawUnsafe('TRUNCATE "user", city CASCADE'),
    prisma.$executeRawUnsafe('ALTER TABLE admin_audit_log ENABLE TRIGGER trg_admin_audit_no_truncate'),
  ]);
}

/** Runs the outbox worker until the queue is empty, so queued e-mails are "sent" into the test inbox. */
export async function flushMail(): Promise<void> {
  const { runMailWorkerOnce } = await import('../../src/jobs/mail-worker');
  await runMailWorkerOnce();
}

/** Pulls the `token=` value out of the last e-mail sent to `to` (after the outbox worker has run). */
export async function lastEmailToken(to: string): Promise<string> {
  await flushMail();
  const { testOutbox } = await import('../../src/lib/mailer');
  const mail = [...testOutbox].reverse().find((m) => m.to === to);
  const match = mail?.text.match(/token=([\w-]+)/);
  if (!match?.[1]) throw new Error(`no e-mail with a token sent to ${to}`);
  return match[1];
}
