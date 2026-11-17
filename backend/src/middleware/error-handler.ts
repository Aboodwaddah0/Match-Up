import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { toAppError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

/** The id of this request (set by the request-id middleware in app.ts), so an error report can be matched to the log lines. */
function requestIdOf(req: Request): string | undefined {
  return typeof req.id === 'string' || typeof req.id === 'number' ? String(req.id) : undefined;
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, requestId: requestIdOf(req) } });
}

/**
 * Errors raised by Express / body-parser for a bad REQUEST (too large, unsupported encoding or charset, corrupt body, aborted
 * upload). They carry a 4xx `status`; before this mapping they fell through to the 500 branch, so a client mistake looked like
 * an outage in monitoring and filled the log with stack traces.
 */
function clientError(err: unknown): { status: number; code: string; message: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown; code?: unknown };

  // zlib failures while decoding a compressed request body (corrupt gzip / deflate)
  if (typeof e.code === 'string' && e.code.startsWith('Z_')) {
    return { status: 400, code: 'INVALID_BODY_ENCODING', message: 'The request body could not be decoded' };
  }

  const status = Number(e.status ?? e.statusCode);
  if (!Number.isInteger(status) || status < 400 || status >= 500) return null;
  if (e.type === 'entity.parse.failed') return { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  if (status === 413) return { status, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' };
  if (status === 415) return { status, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported content type, charset or encoding' };
  return { status, code: 'BAD_REQUEST', message: 'The request could not be processed' };
}

// Express 5 forwards rejected async handlers here automatically.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = requestIdOf(req);

  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      },
    });
    return;
  }

  const bad = clientError(err);
  if (bad) {
    res.status(bad.status).json({ error: { code: bad.code, message: bad.message, requestId } });
    return;
  }

  const dbError = toAppError(err);
  if (dbError) {
    res.status(dbError.status).json({ error: { code: dbError.code, message: dbError.message, requestId } });
    return;
  }

  (req.log ?? logger).error({ err }, 'Unhandled error'); // req.log already carries the request id
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId } });
}
