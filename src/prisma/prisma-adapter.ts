import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export function createPrismaPgAdapter(connectionString: string) {
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);

  return { pool, adapter };
}

/**
 * Convenience helper for one-off scripts/tests.
 *
 * Prisma v7 "driver adapter" mode requires providing either { adapter } or { accelerateUrl }
 * to the PrismaClient constructor. This helper makes it easy to do the right thing.
 */
export function createPrismaClientWithAdapter(connectionString: string) {
  const { pool, adapter } = createPrismaPgAdapter(connectionString);
  const prisma = new PrismaClient({ adapter });

  return { prisma, pool };
}
