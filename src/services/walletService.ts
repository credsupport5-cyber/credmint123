import { PrismaClient, TxnType } from '@prisma/client';

export async function creditWallet(
  prisma: PrismaClient,
  userId: string,
  amount: number,
  label: string,
  description: string,
  tx?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
) {
  const client = (tx || prisma) as PrismaClient;
  await client.wallet.update({
    where: { userId },
    data: {
      balance: { increment: amount },
      available: { increment: amount },
      totalEarned: { increment: amount },
      earnedToday: { increment: amount },
      earnedThisWeek: { increment: amount },
    },
  });

  return client.transaction.create({
    data: { userId, type: TxnType.CREDIT, amount, label, description },
  });
}

// Fix #6: use WHERE guard to prevent overdraft on concurrent debits
export async function debitWallet(
  prisma: PrismaClient,
  userId: string,
  amount: number,
  label: string,
  description: string,
  tx?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
) {
  const client = (tx || prisma) as PrismaClient;

  const updated = await client.wallet.updateMany({
    where: { userId, available: { gte: amount } },
    data: {
      balance: { decrement: amount },
      available: { decrement: amount },
    },
  });

  if (updated.count === 0) {
    throw new Error('INSUFFICIENT_BALANCE');
  }

  return client.transaction.create({
    data: { userId, type: TxnType.DEBIT, amount, label, description },
  });
}

export async function lockFunds(
  prisma: PrismaClient,
  userId: string,
  amount: number,
  tx?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
) {
  const client = (tx || prisma) as PrismaClient;
  await client.wallet.update({
    where: { userId },
    data: {
      balance: { decrement: amount },
      available: { decrement: amount },
      locked: { increment: amount },
    },
  });
}
