import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';
import { AppError } from '../lib/errors';
import { TxnType } from '@prisma/client';

const router = Router();

router.use(authMiddleware);

// GET /plans
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await prisma.plan.findMany({ orderBy: { price: 'asc' } });
    res.json({
      plans: plans.map((p) => ({
        ...p,
        totalReturn: p.dailyEarning * p.duration,
      })),
    });
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

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new AppError('PLAN_NOT_FOUND', 'Plan not found', 404);
    if (plan.upcoming) throw new AppError('PLAN_UPCOMING', 'This plan is not yet available', 400);

    const existingPlan = await prisma.userPlan.findFirst({
      where: { userId, status: 'ACTIVE' },
    });
    if (existingPlan) {
      throw new AppError('ALREADY_HAS_ACTIVE_PLAN', 'Complete your current plan before buying another', 400);
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || wallet.available < plan.price) {
      throw new AppError(
        'INSUFFICIENT_BALANCE',
        `Available balance ₹${wallet?.available ?? 0} is less than plan price ₹${plan.price}`,
        400
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.wallet.update({
        where: { userId },
        data: {
          balance: { decrement: plan.price },
          available: { decrement: plan.price },
          locked: { increment: plan.price },
        },
      });

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

      // 3-level referral walk
      const buyer = await tx.user.findUnique({ where: { id: userId }, select: { name: true, referredById: true } });
      const REFERRAL_RATES = [0.25, 0.10, 0.05];
      let walkId = userId;

      for (let level = 1; level <= 3; level++) {
        const current = await tx.user.findUnique({ where: { id: walkId }, select: { referredById: true } });
        if (!current?.referredById) break;

        const referrerId = current.referredById;
        const earning = Math.floor(plan.price * REFERRAL_RATES[level - 1]);

        await tx.wallet.update({
          where: { userId: referrerId },
          data: {
            balance: { increment: earning },
            available: { increment: earning },
            totalEarned: { increment: earning },
            earnedToday: { increment: earning },
            earnedThisWeek: { increment: earning },
          },
        });
        await tx.transaction.create({
          data: {
            userId: referrerId,
            type: TxnType.CREDIT,
            amount: earning,
            label: `Level ${level} Referral`,
            description: `${buyer?.name ?? 'Someone'} joined ${plan.name}`,
          },
        });
        await tx.referral.create({
          data: { referrerId, refereeId: userId, planId: plan.id, earningAmount: earning, level },
        });

        walkId = referrerId;
      }

      return { userPlan, txn };
    });

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
