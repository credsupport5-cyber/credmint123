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

export async function performSpin(
  prisma: PrismaClient,
  userId: string,
) {
  const status = await getSpinStatus(prisma, userId);

  if (status.spinsRemaining === 0) {
    throw new AppError('NO_SPINS_LEFT', 'No spins remaining for today', 400);
  }

  const selectedPrize = prizeAtIndex(status.planId, status.spinsUsedToday);

  await prisma.spinLog.create({
    data: { userId, prize: selectedPrize.label, value: selectedPrize.value },
  });

  let transaction = null;
  let updatedWallet = null;

  if (!selectedPrize.isTryAgain && selectedPrize.value > 0) {
    transaction = await creditWallet(
      prisma,
      userId,
      selectedPrize.value,
      'Spin Prize',
      `Won ${selectedPrize.label} on Spin & Earn`
    );
    updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
  }

  return {
    prize: selectedPrize,
    spinsRemaining: status.spinsRemaining - 1,
    wallet: updatedWallet,
    transaction,
  };
}

export async function batchPerformSpins(
  prisma: PrismaClient,
  userId: string,
  count: number
) {
  const status = await getSpinStatus(prisma, userId);

  if (status.spinsRemaining < count) {
    throw new AppError(
      'NO_SPINS_LEFT',
      `Only ${status.spinsRemaining} spins remaining, need ${count}`,
      400
    );
  }

  let totalWon = 0;
  const results: Prize[] = [];

  for (let i = 0; i < count; i++) {
    const prize = prizeAtIndex(status.planId, status.spinsUsedToday + i);
    await prisma.spinLog.create({ data: { userId, prize: prize.label, value: prize.value } });
    totalWon += prize.value;
    results.push(prize);
  }

  let updatedWallet = null;
  if (totalWon > 0) {
    await creditWallet(prisma, userId, totalWon, 'Spin Prize', `Won ₹${totalWon} from ${count} spins`);
    updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
  }

  return {
    results,
    totalWon,
    spinsUsed: count,
    spinsRemaining: status.spinsRemaining - count,
    wallet: updatedWallet,
  };
}
