import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { adminMiddleware } from '../middleware/adminMiddleware';
import { AppError } from '../lib/errors';
import { creditWallet } from '../services/walletService';
import { updateWithdrawalStatus, updateDepositStatus, appendKycRow, backfillWithdrawalSheet, backfillDepositSheet } from '../services/sheetsService';
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

    const type = body.type.toUpperCase() as 'UPI' | 'BANK' | 'USDT';

    // Deactivate only same-type methods so UPI + Bank can coexist
    await prisma.paymentMethod.updateMany({ where: { type }, data: { isActive: false } });
    await delCache('global:payment_method');
    await delCache('global:payment_methods');

    const method = await prisma.paymentMethod.create({
      data: { type, details: body.details, isActive: true },
    });

    res.status(201).json({
      id: method.id,
      type: method.type.toLowerCase(),
      details: method.details,
      isActive: method.isActive,
      createdAt: method.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/payment/methods — list all methods
router.get('/payment/methods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const methods = await prisma.paymentMethod.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({
      methods: methods.map((m) => ({
        id: m.id,
        type: m.type.toLowerCase(),
        details: m.details,
        isActive: m.isActive,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/payment/method/:id — edit details / toggle active in place
router.patch('/payment/method/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = z
      .object({
        details: z.record(z.string()).optional(),
        isActive: z.boolean().optional(),
      })
      .refine((b) => b.details !== undefined || b.isActive !== undefined, 'Nothing to update')
      .parse(req.body);

    const existing = await prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Payment method not found', 404);

    const method = await prisma.paymentMethod.update({
      where: { id },
      data: {
        ...(body.details !== undefined ? { details: body.details } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    await delCache('global:payment_method');
    await delCache('global:payment_methods');

    res.json({
      id: method.id,
      type: method.type.toLowerCase(),
      details: method.details,
      isActive: method.isActive,
      createdAt: method.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/payment/method/:id — deactivate
router.delete('/payment/method/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const existing = await prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Payment method not found', 404);

    await prisma.paymentMethod.update({ where: { id }, data: { isActive: false } });
    await delCache('global:payment_method');
    await delCache('global:payment_methods');

    res.json({ id, isActive: false });
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

    const submissionMethod = await prisma.paymentMethod.findUnique({ where: { id: submission.methodId } });
    const isInrMethod = submissionMethod?.type === 'UPI' || submissionMethod?.type === 'BANK';

    if (body.action === 'approve') {
      // INR methods (UPI/Bank): amount already in INR, no rate/fee.
      // USDT: convert at live rate with platform fee.
      const usdtRate = isInrMethod ? null : await fetchUsdtInrRate();
      const inrAmount = isInrMethod
        ? body.inrAmount ?? submission.amount
        : body.inrAmount ?? applyPlatformFee(submission.amount, usdtRate!);
      const description = isInrMethod
        ? `₹${inrAmount} via ${submissionMethod!.type} (ref ${submission.txnId})`
        : `${submission.amount} USDT @ ₹${usdtRate!.toFixed(2)} (5% fee applied)`;
      const verifiedAt = new Date();

      await prisma.$transaction(async (tx) => {
        // Fix #2: atomic status guard — prevents double-credit on concurrent admin approvals
        const updated = await tx.paymentSubmission.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'APPROVED', verifiedAt, inrAmount, usdtRate },
        });
        if (updated.count === 0) throw new AppError('ALREADY_PROCESSED', 'Submission already processed', 400);

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
            description,
          },
        });
      });

      const updatedWallet = await prisma.wallet.findUnique({
        where: { userId: submission.userId },
      });

      const submissionUser = await prisma.user.findUnique({
        where: { id: submission.userId },
        select: { name: true, phone: true },
      });
      const method = await prisma.paymentMethod.findUnique({ where: { id: submission.methodId } });
      updateDepositStatus(id, 'APPROVED', new Date(), {
        userName: submissionUser?.name ?? '',
        userPhone: submissionUser?.phone ?? '',
        amount: inrAmount,
        txnHash: submission.txnId,
        methodType: method?.type ?? 'UPI',
      }).catch(console.error);

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
      const rejResult = await prisma.paymentSubmission.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED', verifiedAt: new Date() },
      });
      if (rejResult.count === 0) throw new AppError('ALREADY_PROCESSED', 'Submission already processed', 400);

      const rejSubmissionUser = await prisma.user.findUnique({
        where: { id: submission.userId },
        select: { name: true, phone: true },
      });
      const rejMethod = await prisma.paymentMethod.findUnique({ where: { id: submission.methodId } });
      updateDepositStatus(id, 'REJECTED', new Date(), {
        userName: rejSubmissionUser?.name ?? '',
        userPhone: rejSubmissionUser?.phone ?? '',
        amount: submission.amount,
        txnHash: submission.txnId,
        methodType: rejMethod?.type ?? 'UPI',
      }).catch(console.error);

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

// PATCH /admin/withdrawal/:id — edit bank/USDT details before completing
router.patch('/withdrawal/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = z
      .object({
        accountName: z.string().min(1).optional(),
        accountNumber: z.string().min(9).max(18).optional(),
        ifsc: z.string().length(11).optional(),
        usdtAddress: z.string().min(20).optional(),
        amount: z.number().positive().optional(),
      })
      .parse(req.body);

    const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!withdrawal) throw new AppError('NOT_FOUND', 'Withdrawal request not found', 404);
    if (withdrawal.status !== 'PENDING') {
      throw new AppError('ALREADY_PROCESSED', 'Cannot edit a processed withdrawal', 400);
    }

    const updated = await prisma.withdrawalRequest.update({
      where: { id },
      data: {
        ...(body.accountName && { accountName: body.accountName }),
        ...(body.accountNumber && { accountNumber: body.accountNumber }),
        ...(body.ifsc && { ifsc: body.ifsc }),
        ...(body.usdtAddress && { usdtAddress: body.usdtAddress }),
        ...(body.amount && { amount: body.amount }),
      },
    });

    res.json({
      id: updated.id,
      amount: updated.amount,
      accountName: updated.accountName,
      accountNumber: updated.accountNumber ? 'XXXX' + updated.accountNumber.slice(-7) : null,
      ifsc: updated.ifsc,
      status: updated.status.toLowerCase(),
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
    // Fix #3: atomic status guard on complete
    await prisma.$transaction(async (tx) => {
      const updated = await tx.withdrawalRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'COMPLETED', completedAt },
      });
      if (updated.count === 0) throw new AppError('ALREADY_PROCESSED', 'Withdrawal already processed', 400);
    });

    const wUser = await prisma.user.findUnique({ where: { id: withdrawal.userId }, select: { name: true, phone: true } });
    const sheetAccountNumber = withdrawal.usdtAddress ?? withdrawal.accountNumber ?? 'CASH';
    const sheetIfsc = withdrawal.ifsc ?? '';
    const sheetAccountName = withdrawal.accountName ?? (withdrawal.usdtAddress ? 'USDT' : 'CASH');
    updateWithdrawalStatus(id, 'COMPLETED', completedAt, {
      userName: wUser?.name ?? '',
      userPhone: wUser?.phone ?? '',
      amount: withdrawal.amount,
      accountNumber: sheetAccountNumber,
      ifsc: sheetIfsc,
      accountName: sheetAccountName,
    }).catch(console.error);

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

    const rejectedAt = new Date();
    await prisma.$transaction(async (tx) => {
      // Fix #3: atomic status guard — prevents double-refund on concurrent admin rejects
      const updated = await tx.withdrawalRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });
      if (updated.count === 0) throw new AppError('ALREADY_PROCESSED', 'Withdrawal already processed', 400);

      // Refund back to withdrawable (that's where it was debited from).
      await tx.wallet.update({
        where: { userId: withdrawal.userId },
        data: {
          balance: { increment: withdrawal.amount },
          withdrawable: { increment: withdrawal.amount },
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

    const rejWUser = await prisma.user.findUnique({ where: { id: withdrawal.userId }, select: { name: true, phone: true } });
    const rejSheetAccNum = withdrawal.usdtAddress ?? withdrawal.accountNumber ?? 'CASH';
    const rejSheetIfsc = withdrawal.ifsc ?? '';
    const rejSheetAccName = withdrawal.accountName ?? (withdrawal.usdtAddress ? 'USDT' : 'CASH');
    updateWithdrawalStatus(id, 'REJECTED', rejectedAt, {
      userName: rejWUser?.name ?? '',
      userPhone: rejWUser?.phone ?? '',
      amount: withdrawal.amount,
      accountNumber: rejSheetAccNum,
      ifsc: rejSheetIfsc,
      accountName: rejSheetAccName,
    }).catch(console.error);

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
      // Spin bonus is income -> withdrawable.
      await tx.wallet.update({
        where: { userId: body.userId },
        data: {
          balance: { increment: body.amount },
          withdrawable: { increment: body.amount },
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

// POST /admin/sheets/backfill
router.post('/sheets/backfill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type } = z.object({ type: z.enum(['withdrawals', 'deposits', 'all']) }).parse(req.body);

    if (type === 'withdrawals' || type === 'all') {
      const rows = await prisma.withdrawalRequest.findMany({
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { name: true, phone: true } } },
      });
      await backfillWithdrawalSheet(rows.map((w) => ({
        id: w.id,
        userName: w.user.name,
        userPhone: w.user.phone,
        amount: w.amount,
        accountNumber: w.usdtAddress ?? w.accountNumber ?? 'CASH',
        ifsc: w.ifsc ?? '',
        accountName: w.accountName ?? (w.usdtAddress ? 'USDT' : 'CASH'),
        status: w.status,
        createdAt: w.createdAt,
        completedAt: w.completedAt,
      })));
    }

    if (type === 'deposits' || type === 'all') {
      const rows = await prisma.paymentSubmission.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          user: { select: { name: true, phone: true } },
          method: { select: { type: true } },
        },
      });
      await backfillDepositSheet(rows.map((d) => ({
        id: d.id,
        userName: d.user.name,
        userPhone: d.user.phone,
        amount: d.inrAmount ?? d.amount,
        txnHash: d.txnId,
        methodType: d.method.type,
        status: d.status,
        createdAt: d.createdAt,
        verifiedAt: d.verifiedAt,
      })));
    }

    res.json({ success: true, type });
  } catch (err) {
    next(err);
  }
});

// POST /admin/run/daily-earnings
// Pass { "force": true } in body to bypass day lock (e.g. after partial failure)
router.post('/run/daily-earnings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body);
    const result = await runDailyEarnings(force ?? false);
    res.json({ success: true, message: `Daily earnings done. Credited ${result.credited}/${result.total} plans.` });
  } catch (err: unknown) {
    const e = err as { code?: string; statusCode?: number; message?: string };
    if (e?.code === 'ALREADY_RAN') {
      res.status(409).json({ error: 'ALREADY_RAN', message: e.message ?? 'Already ran today. Pass force:true to override.' });
      return;
    }
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

    appendKycRow({
      userId,
      name: user.name,
      phone: user.phone,
      action: kycStatus,
      createdAt: new Date(),
    }).catch(console.error);

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

// DELETE /admin/users/phone/:phone — hard delete all data for a user by phone number
router.delete('/users/phone/:phone', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone } = z.object({ phone: z.string().min(1) }).parse(req.params);

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

    const userId = user.id;

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

    res.json({ message: 'User deleted', userId, phone });
  } catch (err) {
    next(err);
  }
});

export default router;
