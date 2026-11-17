import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authLimiter, emailLimiter } from '../../middleware/rate-limit';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schemas';
import * as auth from './auth.service';

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const user = await auth.register(registerSchema.parse(req.body));
  res.status(201).json({ user });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  res.json(await auth.login(email, password));
});

authRouter.post('/refresh', authLimiter, async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  res.json(await auth.refresh(refreshToken));
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  await auth.logout(refreshToken);
  res.status(204).end();
});

authRouter.post('/logout-all', authenticate, async (req, res) => {
  await auth.logoutAll(req.auth!.userId);
  res.status(204).end();
});

authRouter.post('/verify-email', authLimiter, async (req, res) => {
  await auth.verifyEmail(verifyEmailSchema.parse(req.body).token);
  res.json({ verified: true });
});

authRouter.post('/resend-verification', authenticate, emailLimiter, async (req, res) => {
  await auth.resendVerification(req.auth!.userId);
  res.status(202).json({ sent: true });
});

authRouter.post('/forgot-password', emailLimiter, async (req, res) => {
  await auth.forgotPassword(forgotPasswordSchema.parse(req.body).email);
  // same answer whether or not the account exists
  res.status(202).json({ message: 'If that account exists, a reset link has been sent' });
});

authRouter.post('/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = resetPasswordSchema.parse(req.body);
  await auth.resetPassword(token, newPassword);
  res.json({ reset: true });
});

authRouter.post('/change-password', authenticate, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  res.json(await auth.changePassword(req.auth!.userId, currentPassword, newPassword));
});
