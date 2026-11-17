import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { fillLinkTemplate, isLinkTemplate } from '../src/lib/links';
import { resetPasswordLink, verifyEmailLink } from '../src/modules/auth/auth.emails';

describe('e-mail link templates', () => {
  it('accepts web and app deep-link templates that contain {token}, and nothing else', () => {
    expect(isLinkTemplate('https://app.example.com/verify-email?token={token}')).toBe(true);
    expect(isLinkTemplate('fym://verify-email?token={token}')).toBe(true);
    expect(isLinkTemplate('https://app.example.com/verify-email')).toBe(false); // no placeholder
    expect(isLinkTemplate('not a url {token}')).toBe(false);
    expect(isLinkTemplate('')).toBe(false);
  });

  it('puts the token into the template, URL-encoded', () => {
    expect(fillLinkTemplate('fym://reset?token={token}', 'abc-DEF_123')).toBe('fym://reset?token=abc-DEF_123');
    expect(fillLinkTemplate('https://x.test/r?t={token}', 'a b&c')).toBe('https://x.test/r?t=a%20b%26c');
  });

  it('cannot be tricked by the token content: special characters are encoded and replacement patterns are inert', () => {
    // characters that could break out of a query string, an HTML attribute, or a String.replace replacement pattern
    const nasty = 'a&b=c#d?e/f"g<h>i$&j$1k$$l m';
    const link = fillLinkTemplate('https://x.test/verify?token={token}', nasty);

    expect(link).toBe('https://x.test/verify?token=' + encodeURIComponent(nasty));
    // the whole value comes back exactly from the token parameter: nothing leaked into the path, other parameters or the fragment
    const url = new URL(link);
    expect(url.searchParams.get('token')).toBe(nasty);
    expect([...url.searchParams.keys()]).toEqual(['token']);
    expect(url.hash).toBe('');
    // no raw quote, angle bracket, space or replacement pattern survives in the link
    expect(link).not.toMatch(/[<>" ]/);
    expect(link).not.toContain('$&');
  });

  it('fills every placeholder', () => {
    expect(fillLinkTemplate('fym://a?t={token}&again={token}', 'abc')).toBe('fym://a?t=abc&again=abc');
  });

  it('defaults to APP_URL when no template is configured', () => {
    expect(env.VERIFY_EMAIL_URL).toBeUndefined();
    expect(verifyEmailLink('tok')).toBe(`${env.APP_URL}/verify-email?token=tok`);
    expect(resetPasswordLink('tok')).toBe(`${env.APP_URL}/reset-password?token=tok`);
  });
});
