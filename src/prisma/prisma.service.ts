import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { createPrismaPgAdapter } from './prisma-adapter';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor() {
    const databaseUrl = PrismaService.readDatabaseUrl();
    const { adapter, pool } = createPrismaPgAdapter(databaseUrl);
    super({ adapter });
    this.pool = pool;
  }

  private static readDatabaseUrl() {
    const raw =
      process.env.DATABASE_URL?.trim() ?? process.env.DIRECT_URL?.trim();
    if (!raw) {
      throw new Error(
        'DATABASE_URL is missing. Set it in your environment or .env file.',
      );
    }

    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1);
    }

    return raw;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
