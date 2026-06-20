// One-time backfill: recompute wallet buckets (available / withdrawable / locked / balance)
// from source events after introducing the `withdrawable` bucket.
//
// Run AFTER `npx prisma db push`:
//   npx ts-node prisma/backfillWallets.ts            # apply
//   npx ts-node prisma/backfillWallets.ts --dry-run  # preview only
//
// Model (invariant: balance = available + withdrawable + locked):
//   available    = deposits - locked        (deposit funds still spendable on plans)
//   withdrawable = income - withdrawn        (referral + spin + daily, minus paid/pending withdrawals)
//   locked       = sum of plan principals (ACTIVE + COMPLETED — locked forever)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');

const INCOME_LABELS = ['Daily Earning', 'Spin Prize', 'Spin Bonus'];
const isIncomeLabel = (label: string) =>
  INCOME_LABELS.includes(label) || label.includes('Referral');

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, phone: true } });
  console.log(`[backfill] ${users.length} users — ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);

  let changed = 0;

  for (const user of users) {
    const userId = user.id;

    const [credits, plans, withdrawals, wallet] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId, type: 'CREDIT' },
        select: { amount: true, label: true },
      }),
      prisma.userPlan.findMany({
        where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        select: { lockedAmount: true },
      }),
      prisma.withdrawalRequest.findMany({
        where: { userId, status: { in: ['PENDING', 'COMPLETED'] } },
        select: { amount: true },
      }),
      prisma.wallet.findUnique({ where: { userId } }),
    ]);

    if (!wallet) continue;

    const deposits = credits
      .filter((c) => c.label === 'Deposit')
      .reduce((s, c) => s + c.amount, 0);

    const income = credits
      .filter((c) => isIncomeLabel(c.label))
      .reduce((s, c) => s + c.amount, 0);

    const locked = plans.reduce((s, p) => s + p.lockedAmount, 0);
    const withdrawn = withdrawals.reduce((s, w) => s + w.amount, 0);

    const withdrawable = Math.max(0, income - withdrawn);
    const available = Math.max(0, deposits - locked);
    const balance = available + withdrawable + locked;

    const same =
      wallet.available === available &&
      wallet.withdrawable === withdrawable &&
      wallet.locked === locked &&
      wallet.balance === balance;

    if (same) continue;
    changed++;

    console.log(
      `  ${user.phone}: ` +
        `bal ${wallet.balance}->${balance}  ` +
        `avail ${wallet.available}->${available}  ` +
        `wd ${wallet.withdrawable}->${withdrawable}  ` +
        `lock ${wallet.locked}->${locked}`
    );

    if (!DRY_RUN) {
      await prisma.wallet.update({
        where: { userId },
        data: { available, withdrawable, locked, balance },
      });
    }
  }

  console.log(`[backfill] done — ${changed} wallets ${DRY_RUN ? 'would change' : 'updated'}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
