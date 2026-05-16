import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'ADMIN') {
    next(new AppError('FORBIDDEN', 'Admin access required', 403));
    return;
  }
  next();
}
