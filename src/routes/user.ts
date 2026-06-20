import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.use(authMiddleware);

// GET /user/me
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        phone: true,
        name: true,
        kycStatus: true,
        referralCode: true,
        role: true,
        createdAt: true,
      },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PATCH /user/me
router.patch('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ name: z.string().min(1).max(100) }).parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { name: body.name },
      select: { id: true, name: true },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// GET /user/getUserDetails — consolidated: user + wallet + activePlan + allPlans
router.get('/getUserDetails', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const [user, wallet, userPlans, plans] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          phone: true,
          name: true,
          kycStatus: true,
          referralCode: true,
          role: true,
          createdAt: true,
        },
      }),
      prisma.wallet.findUnique({ where: { userId } }),
      prisma.userPlan.findMany({
        where: { userId, status: 'ACTIVE' },
        include: { plan: true },
        orderBy: { startDate: 'desc' },
      }),
      prisma.plan.findMany({ orderBy: { price: 'asc' } }),
    ]);

    const activePlans = userPlans.map((up) => ({
      planId: up.planId,
      planName: up.plan.name,
      tier: up.plan.tier,
      level: up.plan.level,
      daysCurrent: up.daysCompleted,
      totalDays: up.plan.duration,
      totalLocked: up.lockedAmount,
      startDate: up.startDate,
      dailyEarning: up.plan.dailyEarning,
      spinAmounts: up.plan.spinAmounts,
      spinTotal: up.plan.spinTotal,
      totalDailyEarning: up.plan.totalDailyEarning,
      earnedSoFar: up.daysCompleted * up.plan.dailyEarning,
      status: up.status,
    }));

    res.json({
      user,
      wallet: wallet
        ? {
            balance: wallet.balance,
            locked: wallet.locked,
            available: wallet.available,
            withdrawable: wallet.withdrawable,
            earnedToday: wallet.earnedToday,
            earnedThisWeek: wallet.earnedThisWeek,
            totalEarned: wallet.totalEarned,
          }
        : null,
      activePlans,
      allPlans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        tier: p.tier,
        level: p.level,
        price: p.price,
        dailyEarning: p.dailyEarning,
        spinAmounts: p.spinAmounts,
        spinTotal: p.spinTotal,
        totalDailyEarning: p.totalDailyEarning,
        duration: p.duration,
        color: p.color,
        badge: p.badge,
        upcoming: p.upcoming,
        description: p.description,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
