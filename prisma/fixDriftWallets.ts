// Fix the 5 drift wallets that migrateWallets.ts SKIPS (balance != available+withdrawable).
// Their stored columns broke the old invariant, so the lossy split can't be trusted.
// Targets below are reconstructed from the TRANSACTION LEDGER (ground truth):
//
//   I        = Σ income CREDITs (Daily Earning + Spin Prize/Bonus + Referral)
//   refund   = Σ 'Withdrawal Refund' CREDITs
//   dep_in   = Σ 'Deposit' CREDITs
//   W        = Σ WithdrawalRequest.amount (PENDING + COMPLETED)
//   L        = Σ UserPlan.lockedAmount where status = ACTIVE   (completed plans already released)
//
//   balance      = dep_in + I + refund − W          (real money present, locked included)
//   locked       = L
//   spendable    = balance − L
//   withdrawable = clamp(I − W, 0, spendable)
//   deposits     = spendable − withdrawable
//
// GUARD: each row only patched if current DB still matches the `cur*` snapshot below
// (captured pre-fix). If state moved, row SKIPS — re-derive by hand.
//
// ⚠ 0000000000 (admin/test): ledger is internally inconsistent (income CREDITs ₹3905
//   != totalEarned 3390; ledger balance 8405 != stored 5550 — hand-tampered seed acct).
//   Target = ledger-truth. NOT real customer money. Verify/adjust before running, or
//   drop it from PATCHES and fix the admin wallet via reseed.
//
// RUN (after migrateWallets.ts apply, before --drop-available):
//   ./node_modules/.bin/ts-node prisma/fixDriftWallets.ts --dry-run
//   ./node_modules/.bin/ts-node prisma/fixDriftWallets.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

type Fix = {
  phone: string;
  // guard: current DB must still match this (pre-fix snapshot)
  curBal: number; curAvail: number; curWd: number; curLock: number;
  // target final new-model state
  tgtBal: number; tgtDep: number; tgtWd: number; tgtLock: number;
  note?: string;
};

const PATCHES: Fix[] = [
  { phone: '7206310551', curBal: 10750, curAvail: 251,  curWd: 500, curLock: 9749, tgtBal: 10750, tgtDep: 1,    tgtWd: 750,  tgtLock: 9999 },
  { phone: '8955649536', curBal: 5375,  curAvail: 126,  curWd: 250, curLock: 4874, tgtBal: 5375,  tgtDep: 1,    tgtWd: 375,  tgtLock: 4999 },
  { phone: '1234567890', curBal: 1280,  curAvail: 25,   curWd: 255, curLock: 975,  tgtBal: 1280,  tgtDep: 0,    tgtWd: 280,  tgtLock: 1000, note: 'test' },
  { phone: '0987654321', curBal: 1025,  curAvail: 25,   curWd: 0,   curLock: 975,  tgtBal: 1025,  tgtDep: 0,    tgtWd: 25,   tgtLock: 1000, note: 'test' },
  { phone: '0000000000', curBal: 5550,  curAvail: 4490, curWd: 60,  curLock: 1605, tgtBal: 8405,  tgtDep: 2700, tgtWd: 3205, tgtLock: 2500, note: 'admin — ledger-truth, VERIFY' },
];

async function main() {
  console.log(`[fix-drift] ${PATCHES.length} wallets — ${DRY_RUN ? 'DRY RUN — no writes' : 'APPLYING'}`);
  let fixed = 0, skipped = 0;

  for (const p of PATCHES) {
    const user = await prisma.user.findUnique({ where: { phone: p.phone }, select: { id: true } });
    if (!user) { console.warn(`  ! ${p.phone}: user not found — skip`); skipped++; continue; }

    // read current via raw SQL (available not in generated client)
    const [w] = await prisma.$queryRawUnsafe<{ balance: number; available: number; withdrawable: number; locked: number }[]>(
      `SELECT "balance","available","withdrawable","locked" FROM "Wallet" WHERE "userId" = $1`, user.id
    );
    if (!w) { console.warn(`  ! ${p.phone}: wallet not found — skip`); skipped++; continue; }

    const matches =
      Math.abs(w.balance - p.curBal) < 0.01 && Math.abs(w.available - p.curAvail) < 0.01 &&
      Math.abs(w.withdrawable - p.curWd) < 0.01 && Math.abs(w.locked - p.curLock) < 0.01;

    if (!matches) {
      console.warn(
        `  ! ${p.phone}: STATE MOVED — current(bal ${w.balance} avail ${w.available} wd ${w.withdrawable} lock ${w.locked}) ` +
        `!= snapshot(bal ${p.curBal} avail ${p.curAvail} wd ${p.curWd} lock ${p.curLock}). SKIP — re-derive by hand.`
      );
      skipped++;
      continue;
    }

    // sanity: target must satisfy new invariant
    if (Math.abs(p.tgtBal - (p.tgtDep + p.tgtWd + p.tgtLock)) > 0.01) {
      console.error(`  ! ${p.phone}: BAD TARGET — ${p.tgtBal} != dep+wd+lock ${p.tgtDep + p.tgtWd + p.tgtLock}. SKIP.`);
      skipped++;
      continue;
    }

    console.log(
      `  ${p.phone}${p.note ? ` (${p.note})` : ''}: ` +
      `bal ${p.curBal}->${p.tgtBal}  dep ->${p.tgtDep}  wd ${p.curWd}->${p.tgtWd}  lock ${p.curLock}->${p.tgtLock}`
    );
    fixed++;

    if (!DRY_RUN) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Wallet" SET "balance" = $1, "deposits" = $2, "withdrawable" = $3, "locked" = $4 WHERE "userId" = $5`,
        p.tgtBal, p.tgtDep, p.tgtWd, p.tgtLock, user.id
      );
    }
  }

  console.log(`[fix-drift] done — ${fixed} ${DRY_RUN ? 'would fix' : 'fixed'}, ${skipped} skipped`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
