import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhooksService } from './webhooks.service';

const webhookWorkerCron =
  process.env.WEBHOOK_WORKER_CRON?.trim() || CronExpression.EVERY_10_SECONDS;

@Injectable()
export class WebhookDeliveryWorker {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);

  constructor(private readonly webhooksService: WebhooksService) {}

  @Cron(webhookWorkerCron)
  async handleCron() {
    try {
      await this.webhooksService.processPendingDeliveries();
    } catch (error) {
      this.logger.error(
        'Webhook delivery worker cycle failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
