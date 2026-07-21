import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { isTransientDatabaseError } from '../lib/prisma';
import { ZodError } from 'zod';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      statusCode: 400,
    });
    return;
  }

  // Writes are deliberately not retried automatically. A connection can die
  // after Postgres commits, and replaying a financial mutation could duplicate it.
  if (isTransientDatabaseError(err)) {
    console.warn('[DB_UNAVAILABLE]', { method: req.method, path: req.path });
    res.set('Retry-After', '1').status(503).json({
      error: 'DATABASE_UNAVAILABLE',
      message: 'Database is reconnecting. Retry this request shortly.',
      statusCode: 503,
    });
    return;
  }

  console.error('[ERROR]', err);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500,
  });
}
