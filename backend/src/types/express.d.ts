import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware. */
      auth?: { userId: string; role: 'USER' | 'ADMIN'; emailVerified: boolean };
      /** Set by the `validate` middleware: the parsed params / query / body. Read it with `valid()`. */
      valid?: { params?: unknown; query?: unknown; body?: unknown };
    }
  }
}
