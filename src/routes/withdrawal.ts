import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { AppError } from '../lib/errors';
import { appendWithdrawalRow } from '../services/sheetsService';

const router = Router();

router.use(authMiddleware);

const withdrawalBodySchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('BANK'),
    amount: z.number().min(100, 'Minimum withdrawal is ₹100'),
    accountName: z.string().min(1, 'Account holder name required'),
    accountNumber: z.string().min(9).max(18),
    confirmAccountNumber: z.string().min(9).max(18),
    ifsc: z.string().length(11, 'IFSC must be 11 characters'),
  }),
  z.object({
    method: z.literal('USDT'),
    amount: z.number().min(100, 'Minimum withdrawal is ₹100'),
    usdtAddress: z.string().min(20, 'Enter a valid USDT wallet address'),
  }),
  z.object({
    method: z.literal('CASH'),
    amount: z.number().min(200000, 'Minimum cash withdrawal is ₹2,00,000'),
  }),
]);

// POST /withdrawal/request
router.post('/request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = withdrawalBodySchema.parse(req.body);

    if (body.method === 'BANK' && body.accountNumber !== body.confirmAccountNumber) {
      throw new AppError('ACCOUNT_NUMBER_MISMATCH', 'Account numbers do not match', 400);
    }

    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, phone: true },
    });

    // Fix #1: wallet debit + withdrawal create in single atomic transaction
    const withdrawal = await prisma.$transaction(async (tx) => {
      // Withdraw only from `withdrawable` (referral + spin + daily income).
      // Deposits and locked principal are NOT withdrawable.
      const updated = await tx.wallet.updateMany({
        where: { userId, withdrawable: { gte: body.amount } },
        data: {
          balance: { decrement: body.amount },
          withdrawable: { decrement: body.amount },
        },
      });

      if (updated.count === 0) {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        throw new AppError(
          'INSUFFICIENT_BALANCE',
          `Withdrawable balance ₹${wallet?.withdrawable ?? 0} is less than requested ₹${body.amount}`,
          400
        );
      }

      return tx.withdrawalRequest.create({
        data: {
          userId,
          amount: body.amount,
          method: body.method,
          accountNumber: body.method === 'BANK' ? body.accountNumber : null,
          ifsc: body.method === 'BANK' ? body.ifsc : null,
          accountName: body.method === 'BANK' ? body.accountName : null,
          usdtAddress: body.method === 'USDT' ? body.usdtAddress : null,
        },
      });
    });

    const sheetAccountNumber = body.method === 'BANK' ? body.accountNumber : body.method === 'USDT' ? body.usdtAddress : 'CASH';
    const sheetIfsc = body.method === 'BANK' ? body.ifsc : '';
    const sheetAccountName = body.method === 'BANK' ? body.accountName : body.method === 'USDT' ? 'USDT' : 'CASH';

    appendWithdrawalRow({
      id: withdrawal.id,
      userName: user?.name ?? '',
      userPhone: user?.phone ?? '',
      amount: body.amount,
      accountNumber: sheetAccountNumber,
      ifsc: sheetIfsc,
      accountName: sheetAccountName,
      status: 'PENDING',
      createdAt: withdrawal.createdAt,
    }).catch((err) => console.error('[SHEET FAIL — manual backfill needed] withdrawal:', withdrawal.id, err));

    res.status(201).json({
      id: withdrawal.id,
      amount: withdrawal.amount,
      method: withdrawal.method,
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
        accountNumber: w.accountNumber ? 'XXXX' + w.accountNumber.slice(-7) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
