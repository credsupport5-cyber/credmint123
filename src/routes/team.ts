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

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const [user, directSignups, totalEarnings, weeklyEarnings] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } }),
      // All users who registered with my referral code (including those without a plan yet)
      prisma.user.findMany({
        where: { referredById: userId },
        select: {
          id: true,
          name: true,
          createdAt: true,
          userPlans: {
            where: { status: 'ACTIVE' },
            include: { plan: { select: { name: true } } },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
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

    // L1 earnings per direct referee (for per-member display)
    const l1Referrals = await prisma.referral.findMany({
      where: { referrerId: userId, level: 1 },
      select: { refereeId: true, earningAmount: true },
    });
    const earningsMap = Object.fromEntries(l1Referrals.map((r) => [r.refereeId, r.earningAmount]));

    const weeklySignups = directSignups.filter((u) => u.createdAt >= weekStart).length;

    res.json({
      stats: {
        totalReferrals: directSignups.length,
        thisWeek: weeklySignups,
        totalEarnings: totalEarnings._sum.earningAmount ?? 0,
        weeklyEarnings: weeklyEarnings._sum.earningAmount ?? 0,
      },
      referralCode: user?.referralCode,
      members: directSignups.map((u) => ({
        id: u.id,
        name: u.name,
        joinDate: u.createdAt.toISOString().split('T')[0],
        plan: u.userPlans[0]?.plan.name ?? 'No active plan',
        earningsForMe: earningsMap[u.id] ?? 0,
        status: u.userPlans.length > 0 ? 'active' : 'registered',
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
