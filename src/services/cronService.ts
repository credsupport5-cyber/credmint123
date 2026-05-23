import prisma from '../lib/prisma';
import { TxnType } from '@prisma/client';

export async function runDailyEarnings() {
  console.log('[Cron] Running daily earnings...');

  const activePlans = await prisma.userPlan.findMany({
    where: { status: 'ACTIVE' },
    include: { plan: true, user: { include: { wallet: true } } },
  });

  let credited = 0;

  for (const userPlan of activePlans) {
    const newDays = userPlan.daysCompleted + 1;
    const { dailyEarning } = userPlan.plan;
    const wallet = userPlan.user.wallet;

    if (!wallet) continue;

    try {
      await prisma.$transaction(async (tx) => {
        // Credit daily earning
        await tx.wallet.update({
          where: { userId: userPlan.userId },
          data: {
            balance: { increment: dailyEarning },
            available: { increment: dailyEarning },
            locked: { decrement: dailyEarning },
            totalEarned: { increment: dailyEarning },
            earnedToday: { increment: dailyEarning },
            earnedThisWeek: { increment: dailyEarning },
          },
        });

        await tx.transaction.create({
          data: {
            userId: userPlan.userId,
            type: TxnType.CREDIT,
            amount: dailyEarning,
            label: 'Daily Earning',
            description: `${userPlan.plan.name} daily credit (Day ${newDays})`,
          },
        });

        // Update plan progress
        if (newDays >= userPlan.plan.duration) {
          // Plan completed — unlock any remaining locked amount
          const remainingLocked = Math.max(0, wallet.locked - dailyEarning);
          await tx.wallet.update({
            where: { userId: userPlan.userId },
            data: {
              balance: { increment: remainingLocked },
              available: { increment: remainingLocked },
              locked: { set: 0 },
            },
          });

          await tx.userPlan.update({
            where: { id: userPlan.id },
            data: { daysCompleted: newDays, status: 'COMPLETED' },
          });

          console.log(`[Cron] Plan completed for user ${userPlan.userId}`);
        } else {
          await tx.userPlan.update({
            where: { id: userPlan.id },
            data: { daysCompleted: newDays },
          });
        }
      });

      credited++;
    } catch (err) {
      console.error(`[Cron] Failed to process plan ${userPlan.id}:`, err);
    }
  }

  console.log(`[Cron] Daily earnings done. Credited ${credited}/${activePlans.length} users.`);
}

export async function resetDailyStats() {
  await prisma.wallet.updateMany({ data: { earnedToday: 0 } });
  console.log('[Admin] Reset earnedToday for all wallets');
}

export async function resetWeeklyStats() {
  await prisma.wallet.updateMany({ data: { earnedThisWeek: 0 } });
  console.log('[Admin] Reset earnedThisWeek for all wallets');
}
