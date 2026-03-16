import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';

@Module({
  imports: [PrismaModule],
  controllers: [MerchantsController],
  providers: [MerchantsService, ApiKeyGuard],
})
export class MerchantsModule {}
