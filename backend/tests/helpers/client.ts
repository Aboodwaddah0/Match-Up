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
  await prisma.$executeRawUnsafe('TRUNCATE "user", city CASCADE');
}

/** Pulls the `token=` value out of the last e-mail sent to `to`. */
export async function lastEmailToken(to: string): Promise<string> {
  const { testOutbox } = await import('../../src/lib/mailer');
  const mail = [...testOutbox].reverse().find((m) => m.to === to);
  const match = mail?.text.match(/token=([\w-]+)/);
  if (!match?.[1]) throw new Error(`no e-mail with a token sent to ${to}`);
  return match[1];
}
