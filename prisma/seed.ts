import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Seed plans
  const plans = [
    {
      id: 'silver',
      name: 'Silver Plan',
      price: 499,
      dailyEarning: 50,
      duration: 20,
      color: '#94A3B8',
      description: 'Invest ₹499, earn ₹50/day — double in 20 days',
    },
    {
      id: 'gold',
      name: 'Gold Plan',
      price: 999,
      dailyEarning: 100,
      duration: 20,
      color: '#D4AF37',
      badge: 'Popular',
      description: 'Invest ₹999, earn ₹100/day — double in 20 days',
    },
    {
      id: 'diamond',
      name: 'Diamond Plan',
      price: 4999,
      dailyEarning: 500,
      duration: 20,
      color: '#60A5FA',
      badge: 'Best Value',
      description: 'Invest ₹4,999, earn ₹500/day — double in 20 days',
    },
    {
      id: 'platinum',
      name: 'Platinum Plan',
      price: 0,
      dailyEarning: 0,
      duration: 20,
      color: '#A78BFA',
      upcoming: true,
      description: 'Exclusive high-yield plan — launching soon',
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      update: plan,
      create: plan,
    });
  }

  console.log(`Seeded ${plans.length} plans`);

  // Seed admin user
  const adminPhone = '0000000000';
  const adminPasswordHash = await bcrypt.hash('admin@credmint', 12);

  await prisma.user.upsert({
    where: { phone: adminPhone },
    update: {},
    create: {
      phone: adminPhone,
      passwordHash: adminPasswordHash,
      name: 'Admin',
      role: 'ADMIN',
      kycStatus: 'VERIFIED',
      referralCode: 'ADMIN0000',
      wallet: { create: {} },
    },
  });

  console.log('Seeded admin user (phone: 0000000000, password: admin@credmint)');
  console.log('Done!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
