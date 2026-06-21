import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { AppError } from '../lib/errors';
import { TxnType } from '@prisma/client';
import { getCache, setCache, delCache } from '../utils/cache';

const router = Router();

router.use(authMiddleware);

// GET /plans
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const CACHE_KEY = 'global:plans';
    const cached = await getCache<object>(CACHE_KEY);
    if (cached) { res.set('x-cache', 'HIT'); return res.json(cached); }

    const plans = await prisma.plan.findMany({ orderBy: { price: 'asc' } });
    const body = {
      plans: plans.map((p) => ({
        ...p,
        totalReturn: p.dailyEarning * p.duration,
      })),
    };
    await setCache(CACHE_KEY, body, 60 * 60);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /plans/active
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userPlan = await prisma.userPlan.findFirst({
      where: { userId: req.user!.userId, status: 'ACTIVE' },
      include: { plan: true },
    });

    if (!userPlan) {
      res.json({ active: false, userPlan: null });
      return;
    }

    res.json({
      active: true,
      userPlan: {
        id: userPlan.id,
        planId: userPlan.planId,
        planName: userPlan.plan.name,
        startDate: userPlan.startDate,
        daysCompleted: userPlan.daysCompleted,
        totalDays: userPlan.plan.duration,
        lockedAmount: userPlan.lockedAmount,
        earnedSoFar: userPlan.daysCompleted * userPlan.plan.dailyEarning,
        status: userPlan.status,
        dailyEarning: userPlan.plan.dailyEarning,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /plans/:planId/buy — 3-level referral: L1=25%, L2=10%, L3=5%
router.post('/:planId/buy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { planId } = req.params;
    const userId = req.user!.userId;

    const [plan, user] = await Promise.all([
      prisma.plan.findUnique({ where: { id: planId } }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, referredById: true, referrerId2: true, referrerId3: true },
      }),
    ]);

    if (!plan) throw new AppError('PLAN_NOT_FOUND', 'Plan not found', 404);
    if (plan.upcoming) throw new AppError('PLAN_UPCOMING', 'This plan is not yet available', 400);

    const REFERRAL_RATES = [0.25, 0.10, 0.05];
    const referrers: Array<{ id: string; earning: number; level: number }> = [];
    if (user?.referredById) referrers.push({ id: user.referredById, earning: Math.floor(plan.price * REFERRAL_RATES[0]), level: 1 });
    if (user?.referrerId2)  referrers.push({ id: user.referrerId2,  earning: Math.floor(plan.price * REFERRAL_RATES[1]), level: 2 });
    if (user?.referrerId3)  referrers.push({ id: user.referrerId3,  earning: Math.floor(plan.price * REFERRAL_RATES[2]), level: 3 });

    const result = await prisma.$transaction(async (tx) => {
      // Fix #5: re-check balance atomically inside tx with WHERE guard
      // balance unchanged: principal moves deposits -> locked (locked forever)
      const walletUpdate = await tx.wallet.updateMany({
        where: { userId, deposits: { gte: plan.price } },
        data: {
          deposits: { decrement: plan.price },
          locked: { increment: plan.price },
        },
      });

      if (walletUpdate.count === 0) {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        throw new AppError(
          'INSUFFICIENT_BALANCE',
          `Deposit balance ₹${wallet?.deposits ?? 0} is less than plan price ₹${plan.price}`,
          400
        );
      }

      const txn = await tx.transaction.create({
        data: {
          userId,
          type: TxnType.DEBIT,
          amount: plan.price,
          label: 'Plan Purchase',
          description: `${plan.name} activated`,
        },
      });

      const userPlan = await tx.userPlan.create({
        data: { userId, planId: plan.id, lockedAmount: plan.price },
      });

      for (const ref of referrers) {
        await tx.wallet.update({
          where: { userId: ref.id },
          data: {
            balance: { increment: ref.earning },
            withdrawable: { increment: ref.earning },
            totalEarned: { increment: ref.earning },
            earnedToday: { increment: ref.earning },
            earnedThisWeek: { increment: ref.earning },
          },
        });
        await tx.transaction.create({
          data: {
            userId: ref.id,
            type: TxnType.CREDIT,
            amount: ref.earning,
            label: `Level ${ref.level} Referral`,
            description: `${user?.name ?? 'Someone'} joined ${plan.name}`,
          },
        });
        await tx.referral.create({
          data: { referrerId: ref.id, refereeId: userId, planId: plan.id, earningAmount: ref.earning, level: ref.level },
        });
      }

      return { userPlan, txn };
    }, { timeout: 30000 });

    // Fix #10: invalidate team cache for buyer AND all referrers
    await Promise.all([
      delCache(`team:${userId}`),
      ...referrers.map((ref) => delCache(`team:${ref.id}`)),
    ]);

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });

    res.status(201).json({
      userPlan: {
        id: result.userPlan.id,
        planId: plan.id,
        planName: plan.name,
        startDate: result.userPlan.startDate,
        daysCompleted: 0,
        totalDays: plan.duration,
        lockedAmount: plan.price,
        status: 'ACTIVE',
        dailyEarning: plan.dailyEarning,
      },
      wallet: updatedWallet,
      transaction: result.txn,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
