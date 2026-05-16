import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.use(authMiddleware);

// GET /team
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const [referrals, weeklyReferrals, totalEarnings, weeklyEarnings] = await Promise.all([
      prisma.referral.findMany({
        where: { referrerId: userId },
        include: {
          referee: {
            select: {
              name: true,
              createdAt: true,
              userPlans: {
                where: { status: 'ACTIVE' },
                include: { plan: { select: { name: true } } },
                take: 1,
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.referral.count({
        where: { referrerId: userId, createdAt: { gte: weekStart } },
      }),
      prisma.referral.aggregate({
        where: { referrerId: userId },
        _sum: { earningAmount: true },
      }),
      prisma.referral.aggregate({
        where: { referrerId: userId, createdAt: { gte: weekStart } },
        _sum: { earningAmount: true },
      }),
    ]);

    res.json({
      stats: {
        totalReferrals: referrals.length,
        thisWeek: weeklyReferrals,
        totalEarnings: totalEarnings._sum.earningAmount ?? 0,
        weeklyEarnings: weeklyEarnings._sum.earningAmount ?? 0,
      },
      referralCode: user?.referralCode,
      members: referrals.map((r) => ({
        id: r.id,
        name: r.referee.name,
        joinDate: r.referee.createdAt.toISOString().split('T')[0],
        plan: r.referee.userPlans[0]?.plan.name ?? 'No active plan',
        earningsForMe: r.earningAmount,
        status: r.referee.userPlans.length > 0 ? 'active' : 'inactive',
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /team/earnings
router.get('/earnings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(50).default(20),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const [total, earnings] = await Promise.all([
      prisma.referral.count({ where: { referrerId: req.user!.userId } }),
      prisma.referral.findMany({
        where: { referrerId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          referee: { select: { name: true } },
        },
      }),
    ]);

    const plansMap = await prisma.plan.findMany({ select: { id: true, name: true } });
    const planNames = Object.fromEntries(plansMap.map((p) => [p.id, p.name]));

    res.json({
      total,
      earnings: earnings.map((e) => ({
        id: e.id,
        refereeName: (e as typeof e & { referee: { name: string } }).referee.name,
        plan: planNames[e.planId] ?? e.planId,
        earningAmount: e.earningAmount,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
