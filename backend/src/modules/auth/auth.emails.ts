import type { Email } from '../../lib/mailer';

type Locale = 'ar' | 'en';

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
