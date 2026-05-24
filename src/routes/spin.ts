import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { getSpinStatus, performSpin, batchPerformSpins } from '../services/spinService';
import { getCache, setCache, delCache } from '../utils/cache';

const router = Router();

router.use(authMiddleware);

// GET /spin/status
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const CACHE_KEY = `spin:status:${userId}`;
    const cached = await getCache<object>(CACHE_KEY);
    if (cached) { res.set('x-cache', 'HIT'); return res.json(cached); }

    const status = await getSpinStatus(prisma, userId);
    await setCache(CACHE_KEY, status, 60);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// POST /spin
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const result = await performSpin(prisma, userId);
    await delCache(`spin:status:${userId}`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /spin/batch
router.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { count } = z.object({ count: z.number().int().min(1).max(50) }).parse(req.body);
    const userId = req.user!.userId;
    const result = await batchPerformSpins(prisma, userId, count);
    await delCache(`spin:status:${userId}`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
