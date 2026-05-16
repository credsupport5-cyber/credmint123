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

    const [user, wallet, userPlan, plans] = await Promise.all([
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
      prisma.userPlan.findFirst({
        where: { userId, status: 'ACTIVE' },
        include: { plan: true },
      }),
      prisma.plan.findMany({ orderBy: { price: 'asc' } }),
    ]);

    const activePlan = userPlan
      ? {
          planId: userPlan.planId,
          planName: userPlan.plan.name,
          daysCurrent: userPlan.daysCompleted,
          totalDays: userPlan.plan.duration,
          totalLocked: userPlan.lockedAmount,
          startDate: userPlan.startDate,
          dailyEarning: userPlan.plan.dailyEarning,
          earnedSoFar: userPlan.daysCompleted * userPlan.plan.dailyEarning,
          status: userPlan.status,
        }
      : null;

    res.json({
      user,
      wallet: wallet
        ? {
            balance: wallet.balance,
            locked: wallet.locked,
            available: wallet.available,
            earnedToday: wallet.earnedToday,
            earnedThisWeek: wallet.earnedThisWeek,
            totalEarned: wallet.totalEarned,
          }
        : null,
      activePlan,
      allPlans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        dailyEarning: p.dailyEarning,
        duration: p.duration,
        color: p.color,
        badge: p.badge,
        upcoming: p.upcoming,
        description: p.description,
        totalReturn: p.dailyEarning * p.duration,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
