import net from 'node:net';
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { classifySmtpError, createSmtpTransport, deliver, MailDeliveryError, messageIdFor, SMTP_TIMEOUTS } from '../src/lib/mailer';

const email = { to: 'a@example.com', subject: 'Verify', text: 'link' };

describe('mailer', () => {
  it('sends through the transport with the configured sender and the given Message-ID', async () => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    const sent: { from: string; to: string; messageId?: string }[] = [];
    t.on('error', () => {});
    const original = t.sendMail.bind(t);
    t.sendMail = (async (m: never) => {
      sent.push(m);
      return original(m);
    }) as typeof t.sendMail;
    await deliver(t, email, 'FYM <no-reply@fym.test>', '<abc@fym.test>');
    expect(sent[0]).toMatchObject({ from: 'FYM <no-reply@fym.test>', to: 'a@example.com', messageId: '<abc@fym.test>' });
  });

  it('throws a classified MailDeliveryError when delivery fails (it never swallows the failure)', async () => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    t.sendMail = (async () => {
      throw new Error('smtp down');
    }) as typeof t.sendMail;
    await expect(deliver(t, email, 'x@y.z')).rejects.toBeInstanceOf(MailDeliveryError);
  });

  it('classifies: a refused recipient or message is permanent, everything else is transient', () => {
    expect(classifySmtpError({ responseCode: 550 })).toMatchObject({ permanent: true, code: 'SMTP_550' });
    expect(classifySmtpError({ responseCode: 554 })).toMatchObject({ permanent: true });
    expect(classifySmtpError({ code: 'EENVELOPE' })).toMatchObject({ permanent: true, code: 'EENVELOPE' });
    expect(classifySmtpError({ responseCode: 421 })).toMatchObject({ permanent: false, code: 'SMTP_421' });
    expect(classifySmtpError({ responseCode: 535, code: 'EAUTH' })).toMatchObject({ permanent: false }); // bad credentials are our configuration, not the user's fault
    expect(classifySmtpError({ code: 'ETIMEDOUT' })).toMatchObject({ permanent: false, code: 'ETIMEDOUT' });
    expect(classifySmtpError(new Error('boom'))).toMatchObject({ permanent: false, code: 'UNKNOWN' });
  });

  it('the error code and message never contain the recipient or message text', () => {
    const e = classifySmtpError({ responseCode: 550, message: '550 <victim@example.com> user unknown, body: secret-token-123' });
    expect(`${e.code} ${e.message}`).not.toMatch(/victim|secret-token/);
  });

  it('has explicit SMTP time limits', () => {
    expect(SMTP_TIMEOUTS.connectionTimeout).toBeGreaterThan(0);
    expect(SMTP_TIMEOUTS.greetingTimeout).toBeGreaterThan(0);
    expect(SMTP_TIMEOUTS.socketTimeout).toBeGreaterThan(0);
    expect(SMTP_TIMEOUTS.dnsTimeout).toBeGreaterThan(0);
  });

  it('a mail server that accepts the connection and then says nothing does not hang the send: it times out as a transient error', async () => {
    const silent = net.createServer(() => {}); // accepts, never sends the SMTP greeting
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as net.AddressInfo;
    const t = createSmtpTransport(`smtp://127.0.0.1:${port}`, { dnsTimeout: 300, connectionTimeout: 300, greetingTimeout: 300, socketTimeout: 300 });
    const started = Date.now();
    try {
      await deliver(t, email, 'x@y.z');
      expect.unreachable('the send should have timed out');
    } catch (err) {
      expect(err).toBeInstanceOf(MailDeliveryError);
      expect((err as MailDeliveryError).permanent).toBe(false);
    } finally {
      t.close();
      await new Promise((resolve) => silent.close(resolve));
    }
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('the Message-ID is derived from the outbox row id and is stable across retries', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(messageIdFor(id)).toBe(messageIdFor(id));
    expect(messageIdFor(id)).toMatch(/^<11111111-2222-4333-8444-555555555555@[^>\s]+>$/);
  });
});
