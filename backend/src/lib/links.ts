/*
 * Links sent in e-mails (verify address, reset password). Where they point is a deployment decision: a mobile app
 * deep link (e.g. fym://verify-email?token={token}) or a page of a web app (https://app.example.com/verify-email?token={token}).
 * The target is configured with a template that contains the placeholder `{token}`.
 */

const PLACEHOLDER = '{token}';

/** True when the template contains `{token}` and is a valid URL (any scheme, so app deep links are allowed). */
export function isLinkTemplate(template: string): boolean {
  if (!template.includes(PLACEHOLDER)) return false;
  try {
    new URL(template.replace(PLACEHOLDER, 'token'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts the token into the template, URL-encoded, at EVERY `{token}` placeholder.
 * A replacer function is used on purpose: with a plain replacement string, patterns such as `$&` inside the value would be
 * interpreted by String.replace. (encodeURIComponent already turns `$` into %24, so this is defence in depth.)
 */
export function fillLinkTemplate(template: string, token: string): string {
  const encoded = encodeURIComponent(token);
  return template.replaceAll(PLACEHOLDER, () => encoded);
}
