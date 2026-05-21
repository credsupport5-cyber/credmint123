import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { AppError } from '../lib/errors';
import { appendDepositRow } from '../services/sheetsService';

const router = Router();

router.use(authMiddleware);

// GET /payment/method
router.get('/method', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const method = await prisma.paymentMethod.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!method) {
      throw new AppError('NO_PAYMENT_METHOD_SET', 'No payment method available at this time', 404);
    }

    res.json({
      id: method.id,
      type: method.type.toLowerCase(),
      details: method.details,
      updatedAt: method.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// POST /payment/addFunds — USDT deposit proof submission
router.post('/addFunds', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        amount: z.number().min(1, 'Minimum amount is 1 USDT'),
        txnHash: z.string().min(1, 'Transaction hash is required'),
      })
      .parse(req.body);

    const activeMethod = await prisma.paymentMethod.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!activeMethod) {
      throw new AppError('NO_PAYMENT_METHOD_SET', 'No active payment method', 404);
    }

    const existing = await prisma.paymentSubmission.findUnique({ where: { txnId: body.txnHash } });
    if (existing) {
      throw new AppError('TXN_ALREADY_SUBMITTED', 'Transaction hash already submitted', 409);
    }

    const submission = await prisma.paymentSubmission.create({
      data: {
        userId: req.user!.userId,
        methodId: activeMethod.id,
        amount: body.amount,
        txnId: body.txnHash,
        txnHash: body.txnHash,
      },
      include: { user: { select: { name: true, phone: true } } },
    });

    appendDepositRow({
      id: submission.id,
      userName: submission.user.name,
      userPhone: submission.user.phone,
      amount: submission.amount,
      txnHash: submission.txnHash ?? submission.txnId,
      methodType: activeMethod.type,
      status: submission.status,
      createdAt: submission.createdAt,
    }).catch(console.error);

    res.status(201).json({
      id: submission.id,
      amount: submission.amount,
      txnHash: submission.txnHash,
      status: submission.status.toLowerCase(),
      createdAt: submission.createdAt,
      message: 'Deposit submitted. Funds will be credited within 2 hours after verification.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /payment/submissions
router.get('/submissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(50).default(10),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const [total, submissions] = await Promise.all([
      prisma.paymentSubmission.count({ where: { userId: req.user!.userId } }),
      prisma.paymentSubmission.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          amount: true,
          txnId: true,
          txnHash: true,
          status: true,
          createdAt: true,
          verifiedAt: true,
        },
      }),
    ]);

    res.json({ total, submissions });
  } catch (err) {
    next(err);
  }
});

export default router;
