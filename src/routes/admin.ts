import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { adminMiddleware } from '../middleware/adminMiddleware';
import { AppError } from '../lib/errors';
import { creditWallet } from '../services/walletService';
import { updateWithdrawalStatus } from '../services/sheetsService';
import { runDailyEarnings, resetDailyStats, resetWeeklyStats } from '../services/cronService';
import { fetchUsdtInrRate, applyPlatformFee } from '../services/rateService';
import { TxnType } from '@prisma/client';
import { getCache, setCache, delCache } from '../utils/cache';

const router = Router();

router.use(authMiddleware, adminMiddleware);

// POST /admin/payment/method
router.post('/payment/method', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        type: z.enum(['upi', 'bank', 'usdt']),
        details: z.record(z.string()),
      })
      .parse(req.body);

    // Deactivate all existing methods
    await prisma.paymentMethod.updateMany({ data: { isActive: false } });
    await delCache('global:payment_method');

    const method = await prisma.paymentMethod.create({
      data: {
        type: body.type.toUpperCase() as 'UPI' | 'BANK' | 'USDT',
        details: body.details,
        isActive: true,
      },
    });

    res.status(201).json({
      id: method.id,
      type: method.type.toLowerCase(),
      isActive: method.isActive,
      createdAt: method.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/payment/submissions
router.get('/payment/submissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status.toUpperCase();

    const [total, submissions] = await Promise.all([
      prisma.paymentSubmission.count({ where }),
      prisma.paymentSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          user: { select: { name: true, phone: true } },
        },
      }),
    ]);

    res.json({
      total,
      submissions: submissions.map((s) => ({
        id: s.id,
        userId: s.userId,
        userName: s.user.name,
        userPhone: s.user.phone,
        amount: s.amount,
        txnId: s.txnId,
        screenshotUrl: s.screenshotUrl,
        status: s.status.toLowerCase(),
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/rate
router.get('/rate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const CACHE_KEY = 'global:usdt_rate';
    const cached = await getCache<{ rate: number; timestamp: string }>(CACHE_KEY);
    if (cached) { res.set('x-cache', 'HIT'); return res.json(cached); }

    const rate = await fetchUsdtInrRate();
    const body = { rate, timestamp: new Date().toISOString() };
    await setCache(CACHE_KEY, body, 60 * 15);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /admin/payment/:id/verify
router.post('/payment/:id/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = z
      .object({
        action: z.enum(['approve', 'reject']),
        inrAmount: z.number().positive().optional(),
      })
      .parse(req.body);

    const submission = await prisma.paymentSubmission.findUnique({ where: { id } });
    if (!submission) throw new AppError('NOT_FOUND', 'Submission not found', 404);
    if (submission.status !== 'PENDING') {
      throw new AppError('ALREADY_PROCESSED', 'Submission already processed', 400);
    }

    if (body.action === 'approve') {
      const usdtRate = await fetchUsdtInrRate();
      const inrAmount = body.inrAmount ?? applyPlatformFee(submission.amount, usdtRate);

      await prisma.$transaction(async (tx) => {
        await tx.paymentSubmission.update({
          where: { id },
          data: { status: 'APPROVED', verifiedAt: new Date(), inrAmount, usdtRate },
        });

        await tx.wallet.update({
          where: { userId: submission.userId },
          data: {
            balance: { increment: inrAmount },
            available: { increment: inrAmount },
          },
        });

        await tx.transaction.create({
          data: {
            userId: submission.userId,
            type: TxnType.CREDIT,
            amount: inrAmount,
            label: 'Deposit',
            description: `${submission.amount} USDT @ ₹${usdtRate.toFixed(2)} (5% fee applied)`,
          },
        });
      });

      const updatedWallet = await prisma.wallet.findUnique({
        where: { userId: submission.userId },
      });

      res.json({
        submission: { id, status: 'approved' },
        walletCredited: {
          userId: submission.userId,
          usdtAmount: submission.amount,
          usdtRate,
          inrAmount,
          newBalance: updatedWallet?.balance,
        },
      });
    } else {
      await prisma.paymentSubmission.update({
        where: { id },
        data: { status: 'REJECTED', verifiedAt: new Date() },
      });

      res.json({ submission: { id, status: 'rejected' } });
    }
  } catch (err) {
    next(err);
  }
});

// GET /admin/withdrawal/requests
router.get('/withdrawal/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        status: z.enum(['pending', 'completed']).optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status.toUpperCase();

    const [total, withdrawals] = await Promise.all([
      prisma.withdrawalRequest.count({ where }),
      prisma.withdrawalRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          user: { select: { name: true, phone: true } },
        },
      }),
    ]);

    res.json({
      total,
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        userId: w.userId,
        userName: w.user.name,
        userPhone: w.user.phone,
        amount: w.amount,
        method: w.method,
        accountNumber: w.accountNumber ? 'XXXX' + w.accountNumber.slice(-7) : null,
        ifsc: w.ifsc,
        accountName: w.accountName,
        usdtAddress: w.usdtAddress,
        status: w.status.toLowerCase(),
        createdAt: w.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/withdrawal/:id/complete
router.post('/withdrawal/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!withdrawal) throw new AppError('NOT_FOUND', 'Withdrawal request not found', 404);
    if (withdrawal.status !== 'PENDING') {
      throw new AppError('ALREADY_PROCESSED', 'Withdrawal already processed', 400);
    }

    const completedAt = new Date();
    await prisma.withdrawalRequest.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt },
    });

    updateWithdrawalStatus(id, 'COMPLETED', completedAt).catch(console.error);

    res.json({ id, status: 'completed', completedAt });
  } catch (err) {
    next(err);
  }
});

// POST /admin/withdrawal/:id/reject
router.post('/withdrawal/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!withdrawal) throw new AppError('NOT_FOUND', 'Withdrawal request not found', 404);
    if (withdrawal.status !== 'PENDING') {
      throw new AppError('ALREADY_PROCESSED', 'Withdrawal already processed', 400);
    }

    await prisma.$transaction(async (tx) => {
      await tx.withdrawalRequest.update({
        where: { id },
        data: { status: 'REJECTED' },
      });

      await tx.wallet.update({
        where: { userId: withdrawal.userId },
        data: {
          balance: { increment: withdrawal.amount },
          available: { increment: withdrawal.amount },
        },
      });

      await tx.transaction.create({
        data: {
          userId: withdrawal.userId,
          type: TxnType.CREDIT,
          amount: withdrawal.amount,
          label: 'Withdrawal Refund',
          description: 'Withdrawal rejected by admin',
        },
      });
    });

    res.json({ id, status: 'rejected' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/addDiscountsToUser — manually credit spin winnings
router.post('/addDiscountsToUser', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        userId: z.string().uuid(),
        amount: z.number().positive('Amount must be positive'),
      })
      .parse(req.body);

    const wallet = await prisma.wallet.findUnique({ where: { userId: body.userId } });
    if (!wallet) throw new AppError('USER_NOT_FOUND', 'User wallet not found', 404);

    await prisma.$transaction(async (tx) => {
      await tx.wallet.update({
        where: { userId: body.userId },
        data: {
          balance: { increment: body.amount },
          available: { increment: body.amount },
          totalEarned: { increment: body.amount },
          earnedToday: { increment: body.amount },
          earnedThisWeek: { increment: body.amount },
        },
      });
      await tx.transaction.create({
        data: {
          userId: body.userId,
          type: TxnType.CREDIT,
          amount: body.amount,
          label: 'Spin Bonus',
          description: 'Credited by admin',
        },
      });
    });

    const updated = await prisma.wallet.findUnique({ where: { userId: body.userId } });

    res.json({
      userId: body.userId,
      amountCredited: body.amount,
      newBalance: updated?.balance,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users
router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(100).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const [total, users] = await Promise.all([
      prisma.user.count(),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          wallet: { select: { balance: true, locked: true } },
          userPlans: {
            where: { status: 'ACTIVE' },
            include: { plan: { select: { name: true } } },
            take: 1,
          },
        },
      }),
    ]);

    res.json({
      total,
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        phone: u.phone,
        kycStatus: u.kycStatus,
        wallet: u.wallet,
        activePlan: u.userPlans[0]?.plan.name ?? null,
        joinDate: u.createdAt.toISOString().split('T')[0],
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/run/daily-earnings
router.post('/run/daily-earnings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await runDailyEarnings();
    res.json({ success: true, message: 'Daily earnings credited to all active plans' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/run/reset-daily
router.post('/run/reset-daily', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resetDailyStats();
    res.json({ success: true, message: 'earnedToday reset for all wallets' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/run/reset-weekly
router.post('/run/reset-weekly', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resetWeeklyStats();
    res.json({ success: true, message: 'earnedThisWeek reset for all wallets' });
  } catch (err) {
    next(err);
  }
});

// GET /admin/kyc/users
router.get('/kyc/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        status: z.enum(['pending', 'verified', 'rejected']).default('pending'),
        limit: z.coerce.number().min(1).max(100).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const kycStatus = query.status.toUpperCase() as 'PENDING' | 'VERIFIED' | 'REJECTED';

    const [total, users] = await Promise.all([
      prisma.user.count({ where: { kycStatus } }),
      prisma.user.findMany({
        where: { kycStatus },
        orderBy: { createdAt: 'asc' },
        skip: query.offset,
        take: query.limit,
        select: { id: true, name: true, phone: true, kycStatus: true, createdAt: true },
      }),
    ]);

    res.json({ total, users });
  } catch (err) {
    next(err);
  }
});

// POST /admin/kyc/:userId/verify
router.post('/kyc/:userId/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { action } = z.object({ action: z.enum(['approve', 'reject']) }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

    const kycStatus = action === 'approve' ? 'VERIFIED' : 'REJECTED';
    await prisma.user.update({ where: { id: userId }, data: { kycStatus } });

    res.json({ userId, kycStatus: kycStatus.toLowerCase() });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/users/:userId — hard delete all data for a user
router.delete('/users/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

    await prisma.$transaction([
      prisma.refreshToken.deleteMany({ where: { userId } }),
      prisma.paymentSubmission.deleteMany({ where: { userId } }),
      prisma.withdrawalRequest.deleteMany({ where: { userId } }),
      prisma.transaction.deleteMany({ where: { userId } }),
      prisma.spinLog.deleteMany({ where: { userId } }),
      prisma.supportTicket.deleteMany({ where: { userId } }),
      prisma.userPlan.deleteMany({ where: { userId } }),
      prisma.wallet.deleteMany({ where: { userId } }),
      prisma.referral.deleteMany({ where: { OR: [{ referrerId: userId }, { refereeId: userId }] } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);

    await delCache(`team:${userId}`);
    await delCache(`spin:status:${userId}`);

    res.json({ message: 'User deleted', userId });
  } catch (err) {
    next(err);
  }
});

export default router;
