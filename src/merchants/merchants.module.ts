import { Module } from '@nestjs/common';
import { GatewaysModule } from '../gateways/gateways.module';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';

@Module({
  imports: [PrismaModule, GatewaysModule],
  controllers: [MerchantsController],
  providers: [MerchantsService, ApiKeyGuard],
  exports: [MerchantsService],
})
export class MerchantsModule {}
