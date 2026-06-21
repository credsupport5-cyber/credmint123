// Patch the 3 wallets that DRIFTED during revertWallets.ts (earned income after
// backfill). Sets them to old single-bucket state + preserves post-backfill income.
//
//   target available = balance = oldAvailable + incomeDelta   (income back in `available`)
//   target locked    = oldLocked
//
// Guard: only patches if current DB still equals the drifted snapshot below
// (from the DRIFT log). If MORE income landed since, row SKIPS — re-check by hand.
//
// Run BEFORE git-reverting code / prisma generate / db push:
//   npx ts-node prisma/patchDriftWallets.ts --dry-run
//   npx ts-node prisma/patchDriftWallets.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

type Patch = {
  phone: string;
  // guard: current DB must match this (the DRIFT-logged current state)
  curBal: number; curAvail: number; curWd: number; curLock: number;
  // target old single-bucket state (income folded into available)
  tgtBal: number; tgtAvail: number; tgtLock: number;
};

const PATCHES: Patch[] = [
  // 9466374474 + 9468012944 already patched. Only 7374901919 left (state moved again).
  { phone: '7374901919', curBal: 112395, curAvail: 0, curWd: 37900, curLock: 74495, tgtBal: 50109, tgtAvail: 50109, tgtLock: 10739 },
];

async function main() {
  console.log(`[patch-drift] ${PATCHES.length} wallets — ${DRY_RUN ? 'DRY RUN' : 'APPLYING'}`);
  let patched = 0, skipped = 0;

  for (const p of PATCHES) {
    const user = await prisma.user.findUnique({ where: { phone: p.phone } });
    if (!user) { console.warn(`  ! ${p.phone}: user not found — skip`); skipped++; continue; }

    const w = await prisma.wallet.findUnique({ where: { userId: user.id } });
    if (!w) { console.warn(`  ! ${p.phone}: wallet not found — skip`); skipped++; continue; }

    const matches =
      w.balance === p.curBal && w.available === p.curAvail &&
      w.withdrawable === p.curWd && w.locked === p.curLock;

    if (!matches) {
      console.warn(
        `  ! ${p.phone}: STATE MOVED — current(bal ${w.balance} avail ${w.available} wd ${w.withdrawable} lock ${w.locked}) ` +
        `!= expected(bal ${p.curBal} avail ${p.curAvail} wd ${p.curWd} lock ${p.curLock}). SKIP — re-check by hand.`
      );
      skipped++;
      continue;
    }

    console.log(
      `  ${p.phone}: bal ${p.curBal}->${p.tgtBal}  avail ${p.curAvail}->${p.tgtAvail}  wd ${p.curWd}->0  lock ${p.curLock}->${p.tgtLock}`
    );
    patched++;

    if (!DRY_RUN) {
      await prisma.wallet.update({
        where: { userId: user.id },
        data: { balance: p.tgtBal, available: p.tgtAvail, withdrawable: 0, locked: p.tgtLock },
      });
    }
  }

  console.log(`[patch-drift] done — ${patched} ${DRY_RUN ? 'would patch' : 'patched'}, ${skipped} skipped`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
