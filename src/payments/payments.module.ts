import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { RoutingModule } from '../routing/routing.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [PrismaModule, RoutingModule, GatewaysModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, ApiKeyGuard],
  exports: [PaymentsService],
})
export class PaymentsModule {}