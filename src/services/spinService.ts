import { PrismaClient } from '@prisma/client';
import { AppError } from '../lib/errors';
import { creditWallet } from './walletService';

const SPIN_PRIZES = [
  { label: '₹10', value: 10, isTryAgain: false },
  { label: '₹25', value: 25, isTryAgain: false },
  { label: '₹10', value: 10, isTryAgain: false },
  { label: '₹50', value: 50, isTryAgain: false },
  { label: '₹25', value: 25, isTryAgain: false },
  { label: '₹100', value: 100, isTryAgain: false },
  { label: '₹10', value: 10, isTryAgain: false },
  { label: '₹25', value: 25, isTryAgain: false },
  { label: '₹50', value: 50, isTryAgain: false },
  { label: '₹10', value: 10, isTryAgain: false },
  { label: 'Try Again', value: 0, isTryAgain: true },
  { label: 'Try Again', value: 0, isTryAgain: true },
];

export const SPINS_PER_PLAN: Record<string, number> = {
  silver: 5,
  gold: 10,
  diamond: 15,
};

export function getPrizesConfig() {
  const unique = new Map<string, { label: string; value: number; count: number }>();
  for (const p of SPIN_PRIZES) {
    if (unique.has(p.label)) {
      unique.get(p.label)!.count++;
    } else {
      unique.set(p.label, { label: p.label, value: p.value, count: 1 });
    }
  }
  return Array.from(unique.values());
}

export async function getSpinStatus(prisma: PrismaClient, userId: string) {
  const activePlan = await prisma.userPlan.findFirst({
    where: { userId, status: 'ACTIVE' },
    include: { plan: true },
  });

  if (!activePlan) {
    throw new AppError('NO_ACTIVE_PLAN', 'An active plan is required to spin', 403);
  }

  const spinsAllotted = SPINS_PER_PLAN[activePlan.plan.id] ?? 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const spinsUsedToday = await prisma.spinLog.count({
    where: {
      userId,
      createdAt: { gte: todayStart },
    },
  });

  return {
    spinsAllotted,
    spinsUsedToday,
    spinsRemaining: Math.max(0, spinsAllotted - spinsUsedToday),
    planTier: activePlan.plan.id,
    prizes: getPrizesConfig(),
  };
}

export async function performSpin(prisma: PrismaClient, userId: string) {
  const status = await getSpinStatus(prisma, userId);

  if (status.spinsRemaining === 0) {
    throw new AppError('NO_SPINS_LEFT', 'No spins remaining for today', 400);
  }

  const randomIndex = Math.floor(Math.random() * SPIN_PRIZES.length);
  const prize = SPIN_PRIZES[randomIndex];

  let transaction = null;
  let updatedWallet = null;

  await prisma.spinLog.create({
    data: { userId, prize: prize.label, value: prize.value },
  });

  if (!prize.isTryAgain && prize.value > 0) {
    transaction = await creditWallet(
      prisma,
      userId,
      prize.value,
      'Spin Prize',
      `Won ${prize.label} on Qin & Earn`
    );
    updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
  }

  return {
    prize,
    spinsRemaining: status.spinsRemaining - 1,
    wallet: updatedWallet,
    transaction,
  };
}
