import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const READ_ACTIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'queryRaw',
]);

export function isTransientDatabaseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('E57P01')
    || message.includes('terminating connection')
    || message.includes('Connection pool timeout');
}

function makePrisma() {
  const client = new PrismaClient({
    // Prisma logs every connection Neon closes during scale-to-zero. Production
    // request/error handling below records failures once instead of once per pool slot.
    log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : [],
  });

  // Neon can close idle connections when its compute suspends. Retry only read
  // operations once: retrying a write could duplicate a completed financial action.
  client.$use(async (params, next) => {
    try {
      return await next(params);
    } catch (err: unknown) {
      if (READ_ACTIONS.has(params.action) && isTransientDatabaseError(err)) {
        await client.$connect();
        return await next(params);
      }
      throw err;
    }
  });

  return client;
}

export const prisma = globalForPrisma.prisma || makePrisma();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
