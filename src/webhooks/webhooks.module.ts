import { GatewaysModule } from '../gateways/gateways.module';
import { PaymentsModule } from '../payments/payments.module';
import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [PrismaModule, PaymentsModule, GatewaysModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, ApiKeyGuard, WebhookDeliveryWorker],
  exports: [WebhooksService],
})
export class WebhooksModule {}
