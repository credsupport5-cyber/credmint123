import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { getSpinStatus, performSpin } from '../services/spinService';

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

export default router;
