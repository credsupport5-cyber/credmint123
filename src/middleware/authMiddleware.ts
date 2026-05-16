import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/auth';
import { AppError } from '../lib/errors';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new AppError('UNAUTHORIZED', 'Missing authorization header', 401));
    return;
  }

  const token = header.slice(7);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
}
