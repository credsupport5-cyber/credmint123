import prisma from '../lib/prisma';
import { redis } from '../lib/redis';
import { TxnType } from '@prisma/client';

// Fix #7: Redis-based day lock prevents double-runs (cron + manual trigger)
// Fix #8: per-plan Redis set tracks processed IDs — safe to retry on partial failure
export async function runDailyEarnings(force = false) {
  console.log('[Cron] Running daily earnings...');

  const today = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
  const lockKey = `cron:daily:lock:${today}`;
  const processedKey = `cron:daily:processed:${today}`;
  const TTL = 26 * 3600; // 26 hours — survives midnight drift, expires before next day's run

  if (!force) {
    // nx = set only if not exists (atomic)
    const acquired = await redis.set(lockKey, '1', { nx: true, ex: TTL });
    if (!acquired) {
      console.log('[Cron] Already ran today — skipping. Use force=true to override.');
      throw Object.assign(new Error('Daily earnings already ran today'), { code: 'ALREADY_RAN', statusCode: 409 });
    }
  }

  const activePlans = await prisma.userPlan.findMany({
    where: { status: 'ACTIVE' },
    include: { plan: true, user: { include: { wallet: true } } },
  });

  let credited = 0;

  for (const userPlan of activePlans) {
    // Fix #8: skip already-processed plans (safe on partial-failure retry)
    const alreadyDone = await redis.sismember(processedKey, userPlan.id);
    if (alreadyDone) {
      credited++;
      continue;
    }

    const newDays = userPlan.daysCompleted + 1;
    const { dailyEarning } = userPlan.plan;
    const wallet = userPlan.user.wallet;

    if (!wallet) continue;

    try {
      await prisma.$transaction(async (tx) => {
        // Daily earning is income -> withdrawable. Principal stays locked forever.
        await tx.wallet.update({
          where: { userId: userPlan.userId },
          data: {
            balance: { increment: dailyEarning },
            withdrawable: { increment: dailyEarning },
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

        // At duration end, earnings stop and plan completes.
        // Principal is NOT released — it stays locked permanently.
        if (newDays >= userPlan.plan.duration) {
          await tx.userPlan.update({
            where: { id: userPlan.id },
            data: { daysCompleted: newDays, status: 'COMPLETED' },
          });

          console.log(`[Cron] Plan completed for user ${userPlan.userId} (principal stays locked)`);
        } else {
          await tx.userPlan.update({
            where: { id: userPlan.id },
            data: { daysCompleted: newDays },
          });
        }
      });

      // Mark plan as processed in Redis (2-day TTL for safety)
      await redis.sadd(processedKey, userPlan.id);
      await redis.expire(processedKey, TTL);
      credited++;
    } catch (err) {
      console.error(`[Cron] Failed to process plan ${userPlan.id}:`, err);
    }
  }

  console.log(`[Cron] Daily earnings done. Credited ${credited}/${activePlans.length} users.`);
  return { credited, total: activePlans.length };
}

export async function resetDailyStats() {
  await prisma.wallet.updateMany({ data: { earnedToday: 0 } });
  console.log('[Admin] Reset earnedToday for all wallets');
}

export async function resetWeeklyStats() {
  await prisma.wallet.updateMany({ data: { earnedThisWeek: 0 } });
  console.log('[Admin] Reset earnedThisWeek for all wallets');
}
