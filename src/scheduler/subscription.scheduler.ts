import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { SubscriptionInterval, SubscriptionStatus } from '@prisma/client';

@Injectable()
export class SubscriptionScheduler {
  private readonly logger = new Logger(SubscriptionScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Cron('0 * * * *') // runs every hour
  async processSubscriptions() {
    const now = new Date();

    const dueSubscriptions = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextBillingAt: {
          lte: now,
        },
      },
    });

    if (!dueSubscriptions.length) {
      return;
    }

    this.logger.log(`Processing ${dueSubscriptions.length} subscriptions`);

    for (const sub of dueSubscriptions) {
      try {
        await this.paymentsService.createPaymentIntent(sub.merchantId, {
          amountCents: sub.amountCents,
          currency: sub.currency,
          description: `Subscription charge (${sub.interval})`,
          gateway: 'PAYFAST',
        } as any);

        const nextBillingAt = this.computeNextBillingDate(
          sub.nextBillingAt,
          sub.interval,
        );

        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { nextBillingAt },
        });
      } catch (err) {
        this.logger.error(`Subscription billing failed for ${sub.id}`, err);
      }
    }
  }

  private computeNextBillingDate(
    current: Date,
    interval: SubscriptionInterval,
  ) {
    const next = new Date(current);

    switch (interval) {
      case SubscriptionInterval.DAY:
        next.setDate(next.getDate() + 1);
        break;
      case SubscriptionInterval.WEEK:
        next.setDate(next.getDate() + 7);
        break;
      case SubscriptionInterval.MONTH:
        next.setMonth(next.getMonth() + 1);
        break;
      case SubscriptionInterval.YEAR:
        next.setFullYear(next.getFullYear() + 1);
        break;
    }

    return next;
  }
}
