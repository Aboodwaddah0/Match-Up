import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authLimiter, emailLimiter } from '../../middleware/rate-limit';
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

// Rate limiters run before validation so that malformed floods are throttled too.
authRouter.post('/register', authLimiter, validate({ body: registerSchema }), auth.register);
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), auth.login);
authRouter.post('/refresh', authLimiter, validate({ body: refreshSchema }), auth.refresh);
authRouter.post('/logout', validate({ body: refreshSchema }), auth.logout);
authRouter.post('/logout-all', authenticate, auth.logoutAll);

authRouter.post('/verify-email', authLimiter, validate({ body: verifyEmailSchema }), auth.verifyEmail);
authRouter.post('/resend-verification', authenticate, emailLimiter, auth.resendVerification);

authRouter.post('/forgot-password', emailLimiter, validate({ body: forgotPasswordSchema }), auth.forgotPassword);
authRouter.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), auth.resetPassword);
authRouter.post('/change-password', authenticate, authLimiter, validate({ body: changePasswordSchema }), auth.changePassword);
