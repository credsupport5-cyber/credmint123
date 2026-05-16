import cron from 'node-cron';
import prisma from '../lib/prisma';
import { TxnType } from '@prisma/client';

export function startCronJobs() {
  // Daily earnings — midnight IST (UTC+5:30 = 18:30 UTC previous day)
  cron.schedule('30 18 * * *', runDailyEarnings, { timezone: 'UTC' });

  // Reset earnedToday at midnight IST
  cron.schedule('30 18 * * *', resetDailyStats, { timezone: 'UTC' });

  // Reset earnedThisWeek at Monday midnight IST
  cron.schedule('30 18 * * 0', resetWeeklyStats, { timezone: 'UTC' });

  console.log('[Cron] Jobs scheduled');
}

async function runDailyEarnings() {
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

async function resetDailyStats() {
  await prisma.wallet.updateMany({ data: { earnedToday: 0 } });
  console.log('[Cron] Reset earnedToday for all wallets');
}

async function resetWeeklyStats() {
  await prisma.wallet.updateMany({ data: { earnedThisWeek: 0 } });
  console.log('[Cron] Reset earnedThisWeek for all wallets');
}

// Manual trigger for testing
export { runDailyEarnings };
