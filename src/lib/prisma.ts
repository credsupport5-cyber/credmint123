import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function makePrisma() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  });

  // Re-connect transparently after E57P01 (admin_shutdown) or similar transient kills
  client.$use(async (params, next) => {
    try {
      return await next(params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Retry once on connection-terminated errors
      if (msg.includes('E57P01') || msg.includes('terminating connection') || msg.includes('Connection pool timeout')) {
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
