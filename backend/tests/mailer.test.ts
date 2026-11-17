import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { deliver } from '../src/lib/mailer';

const email = { to: 'a@example.com', subject: 'Verify', text: 'link' };

describe('mailer', () => {
  it('sends through the transport with the configured sender', async () => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    const sent: { from: string; to: string }[] = [];
    t.on('error', () => {});
    const original = t.sendMail.bind(t);
    t.sendMail = (async (m: never) => {
      sent.push(m);
      return original(m);
    }) as typeof t.sendMail;
    expect(await deliver(t, email, 'FYM <no-reply@fym.test>')).toBe(true);
    expect(sent[0]).toMatchObject({ from: 'FYM <no-reply@fym.test>', to: 'a@example.com' });
  });

  it('never throws when delivery fails', async () => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    t.sendMail = (async () => {
      throw new Error('smtp down');
    }) as typeof t.sendMail;
    expect(await deliver(t, email, 'x@y.z')).toBe(false);
  });
});
