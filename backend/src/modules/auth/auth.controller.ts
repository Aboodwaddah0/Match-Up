import type { Request, Response } from 'express';
import { valid } from '../../middleware/validate';
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

export const register = async (req: Request, res: Response) => {
  res.status(201).json({ user: await auth.register(valid(req, 'body', registerSchema)) });
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = valid(req, 'body', loginSchema);
  res.json(await auth.login(email, password));
};

export const refresh = async (req: Request, res: Response) => {
  res.json(await auth.refresh(valid(req, 'body', refreshSchema).refreshToken));
};

export const logout = async (req: Request, res: Response) => {
  await auth.logout(valid(req, 'body', refreshSchema).refreshToken);
  res.status(204).end();
};

export const logoutAll = async (req: Request, res: Response) => {
  await auth.logoutAll(req.auth!.userId);
  res.status(204).end();
};

export const verifyEmail = async (req: Request, res: Response) => {
  await auth.verifyEmail(valid(req, 'body', verifyEmailSchema).token);
  res.json({ verified: true });
};

export const resendVerification = async (req: Request, res: Response) => {
  await auth.resendVerification(req.auth!.userId);
  res.status(202).json({ sent: true });
};

export const forgotPassword = async (req: Request, res: Response) => {
  await auth.forgotPassword(valid(req, 'body', forgotPasswordSchema).email);
  // Same answer whether or not the account exists, so the endpoint cannot be used to discover accounts.
  res.status(202).json({ message: 'If that account exists, a reset link has been sent' });
};

export const resetPassword = async (req: Request, res: Response) => {
  const { token, newPassword } = valid(req, 'body', resetPasswordSchema);
  await auth.resetPassword(token, newPassword);
  res.json({ reset: true });
};

export const changePassword = async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = valid(req, 'body', changePasswordSchema);
  res.json(await auth.changePassword(req.auth!.userId, currentPassword, newPassword));
};
