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

export async function debitWallet(
  prisma: PrismaClient,
  userId: string,
  amount: number,
  label: string,
  description: string,
  tx?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
) {
  const client = (tx || prisma) as PrismaClient;
  const wallet = await client.wallet.findUnique({ where: { userId } });
  if (!wallet || wallet.available < amount) {
    throw new Error('INSUFFICIENT_BALANCE');
  }

  await client.wallet.update({
    where: { userId },
    data: {
      balance: { decrement: amount },
      available: { decrement: amount },
    },
  });

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
