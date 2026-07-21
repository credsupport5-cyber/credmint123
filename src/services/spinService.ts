import { PrismaClient } from '@prisma/client';
import { AppError } from '../lib/errors';
import { creditWallet } from './walletService';

const SPIN_PRIZES: Record<string, number[]> = {
  silver_1:  [5, 5, 0, 0, 0],
  silver_2:  [5, 5, 5, 5, 5],
  silver_3:  [10, 10, 10, 10, 10],
  gold_1:    [25, 25, 25, 25, 25],
  gold_2:    [50, 50, 50, 25, 25],
  gold_3:    [50, 50, 50, 50, 50],
  diamond_1: [100, 100, 50, 50, 50],
  diamond_2: [100, 100, 100, 100, 50],
  diamond_3: [100, 100, 100, 100, 100],
  platinum_1: [250, 250, 250, 250, 250],
  platinum_2: [500, 500, 500, 250, 125],
  platinum_3: [500, 500, 500, 500, 500],
};

type Prize = { label: string; value: number; isTryAgain: boolean };

function prizeAtIndex(planId: string, index: number): Prize {
  const arr = SPIN_PRIZES[planId] ?? [0];
  const val = arr[Math.min(index, arr.length - 1)];
  return {
    label: val === 0 ? 'Try Again' : `₹${val}`,
    value: val,
    isTryAgain: val === 0,
  };
}

export async function getSpinStatus(prisma: PrismaClient, userId: string) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [activePlans, spinsUsedToday] = await Promise.all([
    prisma.userPlan.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { plan: true },
    }),
    prisma.spinLog.count({
      where: { userId, createdAt: { gte: todayStart } },
    }),
  ]);

  if (activePlans.length === 0) {
    throw new AppError('NO_ACTIVE_PLAN', 'An active plan is required to spin', 403);
  }

  const topPlan = activePlans.sort((a, b) => b.plan.price - a.plan.price)[0];
  const planId = topPlan.plan.id;
  const spinsAllotted = SPIN_PRIZES[planId]?.length ?? 5;
  const reelValues = SPIN_PRIZES[planId] ?? [];

  return {
    spinsAllotted,
    spinsUsedToday,
    spinsRemaining: Math.max(0, spinsAllotted - spinsUsedToday),
    planTier: topPlan.plan.tier,
    planPrice: topPlan.plan.price,
    planId,
    reelValues,
  };
}

// Fix #4: spinLog + creditWallet in single atomic transaction
export async function performSpin(prisma: PrismaClient, userId: string) {
  const status = await getSpinStatus(prisma, userId);

  if (status.spinsRemaining === 0) {
    throw new AppError('NO_SPINS_LEFT', 'No spins remaining for today', 400);
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const selectedPrize = prizeAtIndex(status.planId, status.spinsUsedToday);

  let transactionRecord = null;

  await prisma.$transaction(async (tx) => {
    // Re-check spin count inside tx to prevent concurrent double-spin
    const spinsNow = await tx.spinLog.count({
      where: { userId, createdAt: { gte: todayStart } },
    });
    if (spinsNow >= status.spinsAllotted) {
      throw new AppError('NO_SPINS_LEFT', 'No spins remaining for today', 400);
    }

    await tx.spinLog.create({
      data: { userId, prize: selectedPrize.label, value: selectedPrize.value },
    });

    if (!selectedPrize.isTryAgain && selectedPrize.value > 0) {
      transactionRecord = await creditWallet(
        prisma,
        userId,
        selectedPrize.value,
        'Spin Prize',
        `Won ${selectedPrize.label} on Spin & Earn`,
        tx as Parameters<typeof creditWallet>[5]
      );
    }
  });

  const updatedWallet = !selectedPrize.isTryAgain && selectedPrize.value > 0
    ? await prisma.wallet.findUnique({ where: { userId } })
    : null;

  return {
    prize: selectedPrize,
    spinsRemaining: status.spinsRemaining - 1,
    wallet: updatedWallet,
    transaction: transactionRecord,
  };
}

// Fix #4: all spinLogs + creditWallet in single atomic transaction
export async function batchPerformSpins(prisma: PrismaClient, userId: string, count: number) {
  const status = await getSpinStatus(prisma, userId);

  if (status.spinsRemaining < count) {
    throw new AppError(
      'NO_SPINS_LEFT',
      `Only ${status.spinsRemaining} spins remaining, need ${count}`,
      400
    );
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let totalWon = 0;
  const results: Prize[] = [];

  await prisma.$transaction(async (tx) => {
    const spinsNow = await tx.spinLog.count({
      where: { userId, createdAt: { gte: todayStart } },
    });
    if (spinsNow + count > status.spinsAllotted) {
      throw new AppError(
        'NO_SPINS_LEFT',
        `Only ${status.spinsAllotted - spinsNow} spins remaining`,
        400
      );
    }

    const spinLogs = [];
    for (let i = 0; i < count; i++) {
      const prize = prizeAtIndex(status.planId, spinsNow + i);
      spinLogs.push({ userId, prize: prize.label, value: prize.value });
      totalWon += prize.value;
      results.push(prize);
    }

    await tx.spinLog.createMany({ data: spinLogs });

    if (totalWon > 0) {
      await creditWallet(
        prisma,
        userId,
        totalWon,
        'Spin Prize',
        `Won ₹${totalWon} from ${count} spins`,
        tx as Parameters<typeof creditWallet>[5]
      );
    }
  });

  const updatedWallet = totalWon > 0 ? await prisma.wallet.findUnique({ where: { userId } }) : null;

  return {
    results,
    totalWon,
    spinsUsed: count,
    spinsRemaining: status.spinsRemaining - count,
    wallet: updatedWallet,
  };
}
