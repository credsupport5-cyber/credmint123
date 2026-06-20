import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { TxnType } from '@prisma/client';

const router = Router();

router.use(authMiddleware);

// GET /wallet
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.user!.userId },
      select: {
        balance: true,
        locked: true,
        available: true,
        withdrawable: true,
        earnedToday: true,
        earnedThisWeek: true,
        totalEarned: true,
      },
    });

    res.json(wallet);
  } catch (err) {
    next(err);
  }
});

// GET /wallet/transactions
router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        type: z.enum(['credit', 'debit']).optional(),
        limit: z.coerce.number().min(1).max(100).default(20),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const where: { userId: string; type?: TxnType } = { userId: req.user!.userId };
    if (query.type) {
      where.type = query.type.toUpperCase() as TxnType;
    }

    const [total, transactions] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          type: true,
          amount: true,
          label: true,
          description: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({ total, limit: query.limit, offset: query.offset, transactions });
  } catch (err) {
    next(err);
  }
});

export default router;
