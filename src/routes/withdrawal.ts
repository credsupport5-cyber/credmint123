import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { AppError } from '../lib/errors';
import { appendWithdrawalRow } from '../services/sheetsService';

const router = Router();

router.use(authMiddleware);

// POST /withdrawal/request
router.post('/request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        amount: z.number().min(100, 'Minimum withdrawal is ₹100'),
        accountName: z.string().min(1, 'Account holder name required'),
        accountNumber: z.string().min(9).max(18),
        confirmAccountNumber: z.string().min(9).max(18),
        ifsc: z.string().length(11, 'IFSC must be 11 characters'),
      })
      .parse(req.body);

    if (body.accountNumber !== body.confirmAccountNumber) {
      throw new AppError('ACCOUNT_NUMBER_MISMATCH', 'Account numbers do not match', 400);
    }

    const userId = req.user!.userId;
    const wallet = await prisma.wallet.findUnique({ where: { userId } });

    if (!wallet || wallet.available < body.amount) {
      throw new AppError(
        'INSUFFICIENT_BALANCE',
        `Available balance ₹${wallet?.available ?? 0} is less than requested ₹${body.amount}`,
        400
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, phone: true },
    });

    await prisma.wallet.update({
      where: { userId },
      data: {
        balance: { decrement: body.amount },
        available: { decrement: body.amount },
      },
    });

    const withdrawal = await prisma.withdrawalRequest.create({
      data: {
        userId,
        amount: body.amount,
        accountNumber: body.accountNumber,
        ifsc: body.ifsc,
        accountName: body.accountName,
      },
    });

    appendWithdrawalRow({
      id: withdrawal.id,
      userName: user?.name ?? '',
      userPhone: user?.phone ?? '',
      amount: body.amount,
      accountNumber: body.accountNumber,
      ifsc: body.ifsc,
      accountName: body.accountName,
      status: 'PENDING',
      createdAt: withdrawal.createdAt,
    }).catch(console.error);

    const maskedAccount = 'XXXX' + body.accountNumber.slice(-7);

    res.status(201).json({
      id: withdrawal.id,
      amount: withdrawal.amount,
      accountNumber: maskedAccount,
      ifsc: withdrawal.ifsc,
      accountName: withdrawal.accountName,
      status: withdrawal.status.toLowerCase(),
      createdAt: withdrawal.createdAt,
      message: 'Withdrawal requested. Will be processed within 1-2 business days.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /withdrawal/history
router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(50).default(10),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const [total, withdrawals] = await Promise.all([
      prisma.withdrawalRequest.count({ where: { userId: req.user!.userId } }),
      prisma.withdrawalRequest.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          amount: true,
          accountNumber: true,
          ifsc: true,
          status: true,
          createdAt: true,
          completedAt: true,
        },
      }),
    ]);

    res.json({
      total,
      withdrawals: withdrawals.map((w) => ({
        ...w,
        accountNumber: 'XXXX' + w.accountNumber.slice(-7),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
