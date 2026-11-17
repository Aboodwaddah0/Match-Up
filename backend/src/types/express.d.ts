import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware. */
      auth?: { userId: string; role: 'USER' | 'ADMIN'; emailVerified: boolean };
    }
  }
}
