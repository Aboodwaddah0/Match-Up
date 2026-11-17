import { z } from 'zod';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
// Length is what matters (NIST); no composition rules. Upper bound stops hashing-DoS.
const newPassword = z.string().min(8, 'At least 8 characters').max(128);
const token = z.string().min(20).max(200);

export const registerSchema = z.object({
  email,
  password: newPassword,
  fullName: z.string().trim().min(2).max(100),
  locale: z.enum(['ar', 'en']).default('ar'),
});

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const refreshSchema = z.object({ refreshToken: token });
export const verifyEmailSchema = z.object({ token });
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token, newPassword });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword });
