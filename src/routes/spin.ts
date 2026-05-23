import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { getSpinStatus, performSpin, batchPerformSpins } from '../services/spinService';

const router = Router();

router.use(authMiddleware);

// GET /spin/status
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getSpinStatus(prisma, req.user!.userId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// POST /spin
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await performSpin(prisma, req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /spin/batch
router.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { count } = z.object({ count: z.number().int().min(1).max(50) }).parse(req.body);
    const result = await batchPerformSpins(prisma, req.user!.userId, count);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
