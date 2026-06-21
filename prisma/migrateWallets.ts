// Migrate wallets from old single-bucket (`available`) to new 4-bucket model
// (`deposits` + `withdrawable` + `locked`). BALANCE-EXACT, churn-proof.
//
// CURRENT (live) invariant — verified on prod: balance = available + withdrawable;
//   `locked` is a SEPARATE pool, NOT part of balance.
// NEW invariant — balance INCLUDES locked: balance = deposits + withdrawable + locked.
// So migration both (a) splits spendable into deposits+withdrawable AND
// (b) folds locked into balance.
//
// SOURCE OF TRUTH (not the lossy `available` split):
//   I = totalEarned                      lifetime income (daily+referral+spin).
//                                         Old deposit code never bumped it -> pure income.
//   W = Σ WithdrawalRequest.amount        status IN (PENDING, COMPLETED).
//                                         REJECTED already refunded -> excluded.
//   spendable = available + withdrawable  all non-locked cash, however currently split
//                                         (folds any prior partial backfill -> churn-proof).
//
//   withdrawable_new = clamp(I - W, 0, spendable)   income still in wallet, capped by real cash
//   deposits_new     = spendable - withdrawable_new remainder = deposits (+ withdrawn-deposit gap)
//   balance_new      = spendable + locked            NEW: locked now folded into balance
//   locked           = UNCHANGED                     principal preserved exactly
//
//   => deposits_new + withdrawable_new + locked == spendable + locked == balance_new  ✓
//
// GUARD: if |balance - (available+withdrawable)| > 0.01 the row already broke the
// CURRENT invariant (pre-existing drift, ~5 rows) -> SKIPPED + logged. Fix by hand
// (see patchDriftWallets.ts precedent) before re-running.
//
// `available` read via raw SQL — Prisma Client no longer types it (schema edited).
//
// RUN — file-only, NO psql, NO `prisma db push` first (push would drop `available`
// before this reads it). Use the local binary (`npx` is hook-rewritten to `npm`):
//   ./node_modules/.bin/ts-node prisma/migrateWallets.ts --dry-run        # 1. preview
//   ./node_modules/.bin/ts-node prisma/migrateWallets.ts                  # 2. apply (adds `deposits`, backfills; ONE-SHOT)
//   ./node_modules/.bin/ts-node prisma/fixDriftWallets.ts                 # 3. fix drift rows to final state
//   ./node_modules/.bin/ts-node prisma/migrateWallets.ts --drop-available # 4. verify NEW invariant + drop dead col
// This file does column add + data backfill + (guarded) column drop.
// --drop-available is STANDALONE (no loop) — verifies balance=deposits+withdrawable+locked
// on every row; drops `available` only if all valid. Loop is one-shot (double-run guarded).
// After step 4, schema matches prisma/schema.prisma (db push = no-op).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const DROP_AVAILABLE = process.argv.includes('--drop-available');

type Row = {
  userId: string;
  balance: number;
  available: number;
  withdrawable: number;
  locked: number;
  totalEarned: number;
  withdrawn: number;
};

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const r2 = (x: number) => Math.round(x * 100) / 100;

// Standalone finalize: verify NEW invariant on every row, then drop `available`.
// Decoupled from the migration loop so it never re-splits already-migrated rows.
async function dropAvailable() {
  const [{ exists }] = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'Wallet' AND column_name = 'deposits'
    ) AS exists
  `;
  if (!exists) {
    console.error('[migrate-wallets] "deposits" column missing — run the migration (step 2) before --drop-available.');
    return;
  }

  const bad = await prisma.$queryRaw<{ userId: string; balance: number; recomputed: number }[]>`
    SELECT "userId", "balance",
           ("deposits" + "withdrawable" + "locked") AS recomputed
    FROM "Wallet"
    WHERE abs("balance" - ("deposits" + "withdrawable" + "locked")) > 0.01
  `;
  if (bad.length > 0) {
    console.warn(`[migrate-wallets] ⚠ ${bad.length} rows violate balance = deposits+withdrawable+locked — NOT dropping "available".`);
    for (const b of bad.slice(0, 10)) {
      console.warn(`  ! ${b.userId}: balance ${b.balance} != ${r2(b.recomputed)} — fix (see fixDriftWallets.ts), re-run.`);
    }
    return;
  }
  if (DRY_RUN) { console.log('[migrate-wallets] --dry-run: all rows valid, would drop "available".'); return; }
  await prisma.$executeRawUnsafe(`ALTER TABLE "Wallet" DROP COLUMN IF EXISTS "available"`);
  console.log('[migrate-wallets] all rows valid — dropped column "available". Schema matches Prisma.');
}

async function main() {
  if (DROP_AVAILABLE) { await dropAvailable(); return; } // standalone — no migration loop

  console.log(`[migrate-wallets] ${DRY_RUN ? 'DRY RUN — no writes' : 'APPLYING'}`);

  if (!DRY_RUN) {
    // Ensure target column exists before the guard queries it.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "deposits" DOUBLE PRECISION NOT NULL DEFAULT 0`
    );
    // Double-run guard: re-running the loop corrupts already-split rows
    // (available unchanged but withdrawable rewritten). Abort if any deposits set.
    const [{ done }] = await prisma.$queryRaw<{ done: number }[]>`
      SELECT count(*)::int AS done FROM "Wallet" WHERE "deposits" <> 0
    `;
    if (done > 0) {
      console.error(`[migrate-wallets] ABORT — ${done} wallets already have deposits set (already migrated). Re-run would double-split.`);
      return;
    }
  }

  // Read `available` via raw SQL (not in generated client anymore).
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT w."userId",
           w."balance",
           w."available",
           w."withdrawable",
           w."locked",
           w."totalEarned",
           COALESCE((
             SELECT SUM(wr."amount") FROM "WithdrawalRequest" wr
             WHERE wr."userId" = w."userId" AND wr."status" IN ('PENDING','COMPLETED')
           ), 0) AS withdrawn
    FROM "Wallet" w
  `;

  let migrated = 0, drift = 0;
  console.log('userId    bal->newBal   avail  wd   -> deposits  withdrawable  locked');

  for (const w of rows) {
    const spendable = w.available + w.withdrawable;

    // guard against CURRENT invariant (balance = available + withdrawable);
    // pre-existing drift gets skipped, never silently "fixed"
    if (Math.abs(w.balance - spendable) > 0.01) {
      console.warn(
        `  ! DRIFT ${w.userId}: balance ${w.balance} != available+withdrawable ` +
        `${r2(spendable)} (avail ${w.available} wd ${w.withdrawable} lock ${w.locked}). SKIP — fix by hand.`
      );
      drift++;
      continue;
    }

    const withdrawableNew = r2(clamp(w.totalEarned - w.withdrawn, 0, spendable));
    const depositsNew = r2(spendable - withdrawableNew);
    const balanceNew = r2(spendable + w.locked); // NEW: locked folded into balance

    console.log(
      `  ${w.userId.slice(0, 8)}  ${w.balance}->${balanceNew}  ${w.available}  ${w.withdrawable}  ` +
      `-> dep ${depositsNew}  wd ${withdrawableNew}  lock ${w.locked}`
    );
    migrated++;

    if (!DRY_RUN) {
      // locked untouched; split spendable into deposits+withdrawable; fold locked into balance
      await prisma.$executeRawUnsafe(
        `UPDATE "Wallet" SET "deposits" = $1, "withdrawable" = $2, "balance" = $3 WHERE "userId" = $4`,
        depositsNew, withdrawableNew, balanceNew, w.userId
      );
    }
  }

  console.log(
    `[migrate-wallets] done — ${migrated} ${DRY_RUN ? 'would migrate' : 'migrated'}, ${drift} drift-skipped`
  );
  if (drift > 0) {
    console.log(`[migrate-wallets] next: fix ${drift} drift rows (fixDriftWallets.ts), then run --drop-available.`);
  } else if (!DRY_RUN) {
    console.log('[migrate-wallets] clean. Run with --drop-available to drop the dead "available" column.');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
