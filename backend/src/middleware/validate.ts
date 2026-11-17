import type { NextFunction, Request, Response } from 'express';
import type { z, ZodType } from 'zod';

interface Schemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  /** Treat a missing body as `{}` (routes whose body is entirely optional, e.g. a cancel reason). */
  optionalBody?: boolean;
}

/**
 * Validates the request with Zod BEFORE the controller runs. Order is params, then query, then body.
 * A failure throws a ZodError, which the error handler turns into a 400 VALIDATION_ERROR.
 * Controllers read the parsed values with `valid()`; they never see unvalidated input.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed: NonNullable<Request['valid']> = {};
    if (schemas.params) parsed.params = schemas.params.parse(req.params);
    if (schemas.query) parsed.query = schemas.query.parse(req.query);
    if (schemas.body) parsed.body = schemas.body.parse(schemas.optionalBody ? (req.body ?? {}) : req.body);
    req.valid = parsed;
    next();
  };
}

/**
 * Returns the validated params / query / body, typed from the schema. Pass the same schema the route
 * uses; it is only needed so TypeScript can infer the type (nothing is parsed again).
 */
export function valid<S extends ZodType>(req: Request, part: 'params' | 'query' | 'body', _schema: S): z.infer<S> {
  return req.valid?.[part] as z.infer<S>;
}
