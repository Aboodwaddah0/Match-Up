import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import {
  changePasswordLimiter,
  forgotAccountLimiter,
  forgotIpLimiter,
  loginAccountLimiter,
  loginIpLimiter,
  refreshLimiter,
  registerLimiter,
  resendLimiter,
  tokenLimiter,
} from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as auth from './auth.controller';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schemas';

export const authRouter = Router();

// Order matters: the per-IP limiter runs BEFORE validation (so malformed floods are throttled too); the per-account
// limiter runs AFTER validation because it keys on the validated e-mail. See middleware/rate-limit.ts for the numbers.
authRouter.post('/register', registerLimiter, validate({ body: registerSchema }), auth.register);
authRouter.post('/login', loginIpLimiter, validate({ body: loginSchema }), loginAccountLimiter, auth.login);
authRouter.post('/refresh', refreshLimiter, validate({ body: refreshSchema }), auth.refresh);
authRouter.post('/logout', validate({ body: refreshSchema }), auth.logout);
authRouter.post('/logout-all', authenticate, auth.logoutAll);

authRouter.post('/verify-email', tokenLimiter, validate({ body: verifyEmailSchema }), auth.verifyEmail);
authRouter.post('/resend-verification', authenticate, resendLimiter, auth.resendVerification);

authRouter.post('/forgot-password', forgotIpLimiter, validate({ body: forgotPasswordSchema }), forgotAccountLimiter, auth.forgotPassword);
authRouter.post('/reset-password', tokenLimiter, validate({ body: resetPasswordSchema }), auth.resetPassword);
authRouter.post('/change-password', authenticate, changePasswordLimiter, validate({ body: changePasswordSchema }), auth.changePassword);
