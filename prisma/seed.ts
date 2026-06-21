import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function main() {
  console.log('Seeding database...');

  // ── Plans ──────────────────────────────────────────────────────────────────
  const plans = [
    // Silver
    {
      id: 'silver_1', name: 'Silver Level 1', tier: 'SILVER' as const, level: 1,
      price: 500, dailyEarning: 15, spinAmounts: [5, 5, 0, 0, 0], spinTotal: 10, totalDailyEarning: 25,
      duration: 20, color: '#94A3B8', upcoming: false,
      description: '₹500 → ₹1,000 in 20 days. Earn ₹25/day.',
    },
    {
      id: 'silver_2', name: 'Silver Level 2', tier: 'SILVER' as const, level: 2,
      price: 1000, dailyEarning: 25, spinAmounts: [5, 5, 5, 5, 5], spinTotal: 25, totalDailyEarning: 50,
      duration: 20, color: '#94A3B8', badge: 'Popular', upcoming: false,
      description: '₹1,000 → ₹2,000 in 20 days. Earn ₹50/day.',
    },
    {
      id: 'silver_3', name: 'Silver Level 3', tier: 'SILVER' as const, level: 3,
      price: 2000, dailyEarning: 50, spinAmounts: [10, 10, 10, 10, 10], spinTotal: 50, totalDailyEarning: 100,
      duration: 20, color: '#94A3B8', upcoming: false,
      description: '₹2,000 → ₹4,000 in 20 days. Earn ₹100/day.',
    },
    // Gold
    {
      id: 'gold_1', name: 'Gold Level 1', tier: 'GOLD' as const, level: 1,
      price: 4999, dailyEarning: 125, spinAmounts: [25, 25, 25, 25, 25], spinTotal: 125, totalDailyEarning: 250,
      duration: 20, color: '#D4AF37', upcoming: false,
      description: '₹4,999 → ₹9,998 in 20 days. Earn ₹250/day.',
    },
    {
      id: 'gold_2', name: 'Gold Level 2', tier: 'GOLD' as const, level: 2,
      price: 7999, dailyEarning: 200, spinAmounts: [50, 50, 50, 25, 25], spinTotal: 200, totalDailyEarning: 400,
      duration: 20, color: '#D4AF37', badge: 'Popular', upcoming: false,
      description: '₹7,999 → ₹15,998 in 20 days. Earn ₹400/day.',
    },
    {
      id: 'gold_3', name: 'Gold Level 3', tier: 'GOLD' as const, level: 3,
      price: 9999, dailyEarning: 250, spinAmounts: [50, 50, 50, 50, 50], spinTotal: 250, totalDailyEarning: 500,
      duration: 20, color: '#D4AF37', upcoming: false,
      description: '₹9,999 → ₹19,998 in 20 days. Earn ₹500/day.',
    },
    // Diamond
    {
      id: 'diamond_1', name: 'Diamond Level 1', tier: 'DIAMOND' as const, level: 1,
      price: 13999, dailyEarning: 350, spinAmounts: [100, 100, 50, 50, 50], spinTotal: 350, totalDailyEarning: 700,
      duration: 20, color: '#60A5FA', upcoming: false,
      description: '₹13,999 → ₹27,998 in 20 days. Earn ₹700/day.',
    },
    {
      id: 'diamond_2', name: 'Diamond Level 2', tier: 'DIAMOND' as const, level: 2,
      price: 17999, dailyEarning: 450, spinAmounts: [100, 100, 100, 100, 50], spinTotal: 450, totalDailyEarning: 900,
      duration: 20, color: '#60A5FA', badge: 'Popular', upcoming: false,
      description: '₹17,999 → ₹35,998 in 20 days. Earn ₹900/day.',
    },
    {
      id: 'diamond_3', name: 'Diamond Level 3', tier: 'DIAMOND' as const, level: 3,
      price: 21999, dailyEarning: 600, spinAmounts: [100, 100, 100, 100, 100], spinTotal: 500, totalDailyEarning: 1100,
      duration: 20, color: '#60A5FA', badge: 'Best Value', upcoming: false,
      description: '₹21,999 → ₹43,998 in 20 days. Earn ₹1,100/day.',
    },
    // Platinum (upcoming)
    {
      id: 'platinum_1', name: 'Platinum Plan', tier: 'PLATINUM' as const, level: 1,
      price: 0, dailyEarning: 0, spinAmounts: [], spinTotal: 0, totalDailyEarning: 0,
      duration: 20, color: '#A78BFA', upcoming: true,
      description: 'Exclusive high-yield plan — launching soon',
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({ where: { id: plan.id }, update: plan, create: plan });
  }
  console.log(`✓ Seeded ${plans.length} plans`);

  // ── USDT Payment method ────────────────────────────────────────────────────
  await prisma.paymentMethod.updateMany({ data: { isActive: false } });
  const paymentMethod = await prisma.paymentMethod.upsert({
    where: { id: 'default_usdt' },
    update: { isActive: true },
    create: {
      id: 'default_usdt',
      type: 'USDT',
      details: { address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', network: 'TRC20' },
      isActive: true,
    },
  });
  console.log('✓ Payment method: USDT TRC20');

  // ── Referrer: Sunny (SUNNY2JT8) ────────────────────────────────────────────
  const sunnyHash = await bcrypt.hash('sunny@1234', 12);
  const sunny = await prisma.user.upsert({
    where: { phone: '9999999999' },
    update: {},
    create: {
      phone: '9999999999',
      passwordHash: sunnyHash,
      name: 'Sunny',
      role: 'USER',
      kycStatus: 'VERIFIED',
      referralCode: 'SUNNY2JT8',
    },
  });

  // Ensure Sunny has a wallet
  await prisma.wallet.upsert({
    where: { userId: sunny.id },
    update: {},
    create: {
      userId: sunny.id,
      balance: 100,
      deposits: 100,
      totalEarned: 100,
    },
  });
  console.log('✓ Referrer user: Sunny (SUNNY2JT8)');

  // ── Admin user ─────────────────────────────────────────────────────────────
  const adminHash = await bcrypt.hash('admin@credmint', 12);
  const admin = await prisma.user.upsert({
    where: { phone: '0000000000' },
    update: { referredById: sunny.id },
    create: {
      phone: '0000000000',
      passwordHash: adminHash,
      name: 'Admin',
      role: 'ADMIN',
      kycStatus: 'VERIFIED',
      referralCode: 'ADMIN0000',
      referredById: sunny.id,
    },
  });

  // Admin wallet — 5k deposited, silver_2 plan (₹1,000) bought, 5 days earnings (₹50/day = ₹250)
  await prisma.wallet.upsert({
    where: { userId: admin.id },
    update: {
      balance: 4285,
      locked: 1000,
      deposits: 3035,
      withdrawable: 250,
      earnedToday: 50,
      earnedThisWeek: 350,
      totalEarned: 250,
    },
    create: {
      userId: admin.id,
      balance: 4285,
      locked: 1000,
      deposits: 3035,
      withdrawable: 250,
      earnedToday: 50,
      earnedThisWeek: 350,
      totalEarned: 250,
    },
  });
  console.log('✓ Admin wallet: ₹4,285 balance');

  // ── Admin active plan: Silver Level 2 ─────────────────────────────────────
  // Cancel any stale active plans
  await prisma.userPlan.updateMany({
    where: { userId: admin.id, status: 'ACTIVE' },
    data: { status: 'CANCELLED' },
  });

  await prisma.userPlan.create({
    data: {
      userId: admin.id,
      planId: 'silver_2',
      startDate: daysAgo(5),
      daysCompleted: 5,
      lockedAmount: 1000,
      status: 'ACTIVE',
    },
  });
  console.log('✓ Admin plan: Silver Level 2 (Day 5 of 20)');

  // ── Admin transactions ─────────────────────────────────────────────────────
  const existingTxnCount = await prisma.transaction.count({ where: { userId: admin.id } });
  if (existingTxnCount === 0) {
    const txns = [
      // Deposit
      { userId: admin.id, type: 'CREDIT' as const, amount: 5000,  label: 'Deposit',       description: 'USDT deposit approved',        createdAt: daysAgo(6) },
      // Plan purchase debit
      { userId: admin.id, type: 'DEBIT'  as const, amount: 1000,  label: 'Plan Purchase',  description: 'Silver Level 2 activated',     createdAt: daysAgo(5) },
      // Daily earnings
      { userId: admin.id, type: 'CREDIT' as const, amount: 50,    label: 'Daily Earning',  description: 'Silver Level 2 · Day 1',       createdAt: daysAgo(4) },
      { userId: admin.id, type: 'CREDIT' as const, amount: 50,    label: 'Daily Earning',  description: 'Silver Level 2 · Day 2',       createdAt: daysAgo(3) },
      { userId: admin.id, type: 'CREDIT' as const, amount: 50,    label: 'Daily Earning',  description: 'Silver Level 2 · Day 3',       createdAt: daysAgo(2) },
      { userId: admin.id, type: 'CREDIT' as const, amount: 50,    label: 'Daily Earning',  description: 'Silver Level 2 · Day 4',       createdAt: daysAgo(1) },
      { userId: admin.id, type: 'CREDIT' as const, amount: 50,    label: 'Daily Earning',  description: 'Silver Level 2 · Day 5',       createdAt: daysAgo(0) },
      // Spin winnings
      { userId: admin.id, type: 'CREDIT' as const, amount: 25,    label: 'Spin Reward',    description: 'Spin wheel prize',             createdAt: daysAgo(4) },
      { userId: admin.id, type: 'CREDIT' as const, amount: 10,    label: 'Spin Reward',    description: 'Spin wheel prize',             createdAt: daysAgo(3) },
      { userId: admin.id, type: 'CREDIT' as const, amount: 50,    label: 'Spin Reward',    description: 'Spin wheel prize',             createdAt: daysAgo(2) },
      // Withdrawal debit
      { userId: admin.id, type: 'DEBIT'  as const, amount: 500,   label: 'Withdrawal',     description: 'Bank transfer to HDFC ****012', createdAt: daysAgo(3) },
    ];

    for (const txn of txns) {
      await prisma.transaction.create({ data: txn });
    }
    console.log(`✓ Admin transactions: ${txns.length} records`);
  } else {
    console.log('  (transactions already exist, skipped)');
  }

  // ── Payment submission (approved ₹5,000 deposit) ──────────────────────────
  const existingSubmission = await prisma.paymentSubmission.findFirst({ where: { userId: admin.id } });
  if (!existingSubmission) {
    await prisma.paymentSubmission.create({
      data: {
        userId: admin.id,
        methodId: paymentMethod.id,
        amount: 5000,
        txnId:   'DEMO_ADMIN_TXN_001',
        txnHash: 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890',
        status: 'APPROVED',
        createdAt: daysAgo(6),
        verifiedAt: daysAgo(6),
      },
    });
    console.log('✓ Payment submission: ₹5,000 USDT (APPROVED)');
  } else {
    console.log('  (payment submission already exists, skipped)');
  }

  // ── Withdrawal requests ────────────────────────────────────────────────────
  const existingWithdrawal = await prisma.withdrawalRequest.findFirst({ where: { userId: admin.id } });
  if (!existingWithdrawal) {
    // Completed withdrawal
    await prisma.withdrawalRequest.create({
      data: {
        userId: admin.id,
        amount: 500,
        accountNumber: '123456789012',
        ifsc: 'HDFC0001234',
        accountName: 'Admin User',
        status: 'COMPLETED',
        createdAt: daysAgo(4),
        completedAt: daysAgo(3),
      },
    });
    // Pending withdrawal
    await prisma.withdrawalRequest.create({
      data: {
        userId: admin.id,
        amount: 200,
        accountNumber: '123456789012',
        ifsc: 'HDFC0001234',
        accountName: 'Admin User',
        status: 'PENDING',
        createdAt: daysAgo(1),
      },
    });
    console.log('✓ Withdrawal requests: 1 completed + 1 pending');
  } else {
    console.log('  (withdrawal requests already exist, skipped)');
  }

  // ── Referral record: Sunny referred Admin ─────────────────────────────────
  const existingReferral = await prisma.referral.findFirst({
    where: { referrerId: sunny.id, refereeId: admin.id },
  });
  if (!existingReferral) {
    await prisma.referral.create({
      data: {
        referrerId:    sunny.id,
        refereeId:     admin.id,
        planId:        'silver_2',
        earningAmount: 100, // 10% of ₹1,000
        level:         1,
        createdAt:     daysAgo(5),
      },
    });
    // Credit Sunny's referral earnings
    await prisma.wallet.update({
      where: { userId: sunny.id },
      data: {
        balance:     { increment: 100 },
        withdrawable: { increment: 100 },
        totalEarned: { increment: 100 },
      },
    });
    console.log('✓ Referral: Sunny → Admin (₹100 credited to Sunny)');
  } else {
    console.log('  (referral already exists, skipped)');
  }

  console.log('\n✅ Seed complete!');
  console.log('   Admin  → phone: 0000000000 | password: admin@credmint');
  console.log('   Sunny  → phone: 9999999999 | code: SUNNY2JT8');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
