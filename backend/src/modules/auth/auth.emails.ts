import { env } from '../../config/env';
import { fillLinkTemplate } from '../../lib/links';
import type { MailKind } from '@prisma/client';
import type { Email } from '../../lib/mailer';

type Locale = 'ar' | 'en';

/** The link in the verification e-mail (configurable with VERIFY_EMAIL_URL, see lib/links.ts). */
export function verifyEmailLink(token: string): string {
  return fillLinkTemplate(env.VERIFY_EMAIL_URL ?? `${env.APP_URL}/verify-email?token={token}`, token);
}

/** The link in the password-reset e-mail (configurable with RESET_PASSWORD_URL). */
export function resetPasswordLink(token: string): string {
  return fillLinkTemplate(env.RESET_PASSWORD_URL ?? `${env.APP_URL}/reset-password?token={token}`, token);
}

export function verifyEmailMessage(to: string, locale: Locale, link: string): Email {
  return locale === 'ar'
    ? { to, subject: 'تأكيد بريدك الإلكتروني - Find Your Match', text: `مرحباً!\n\nاضغط على الرابط لتأكيد بريدك الإلكتروني (صالح لمدة 24 ساعة):\n${link}\n\nإذا لم تنشئ حساباً فتجاهل هذه الرسالة.` }
    : { to, subject: 'Confirm your e-mail - Find Your Match', text: `Welcome!\n\nOpen this link to confirm your e-mail (valid for 24 hours):\n${link}\n\nIf you did not create an account, ignore this message.` };
}

export function resetPasswordMessage(to: string, locale: Locale, link: string): Email {
  return locale === 'ar'
    ? { to, subject: 'إعادة تعيين كلمة المرور - Find Your Match', text: `اضغط على الرابط لتعيين كلمة مرور جديدة (صالح لمدة ساعة):\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة.` }
    : { to, subject: 'Reset your password - Find Your Match', text: `Open this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not ask for this, ignore this message.` };
}

/** Renders a queued message at SEND time, so the current templates and link targets (VERIFY_EMAIL_URL / RESET_PASSWORD_URL) apply. */
export function renderMail(kind: MailKind, to: string, locale: Locale, rawToken: string): Email {
  return kind === 'EMAIL_VERIFY'
    ? verifyEmailMessage(to, locale, verifyEmailLink(rawToken))
    : resetPasswordMessage(to, locale, resetPasswordLink(rawToken));
}
