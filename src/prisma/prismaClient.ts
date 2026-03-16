import 'dotenv/config';
import { createPrismaClientWithAdapter } from './prisma-adapter';

function readDatabaseUrl() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    throw new Error('DATABASE_URL is missing. Set it in your .env file.');
  }

  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  return raw;
}

const { prisma, pool } = createPrismaClientWithAdapter(readDatabaseUrl());
export { prisma };

export async function disconnectPrismaClient() {
  await prisma.$disconnect();
  await pool.end();
}
