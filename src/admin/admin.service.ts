import {
  GatewayProvider,
  PaymentStatus,
  Prisma,
  SupportEscalationStatus,
  WebhookDeliveryStatus,
} from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type AdminMerchantRecord = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  createdAt: Date;
};

type AdminPaymentRecord = {
  id: string;
  reference: string;
  baseAmountCents: number;
  amountCents: number;
  platformFeeCents: number;
  providerFeeCents: number | null;
  merchantNetCents: number;
  status: PaymentStatus;
  gateway: GatewayProvider | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  rawGateway: Prisma.JsonValue | null;
  merchant: {
    id: string;
    name: string;
  };
  attempts: Array<{
    gateway: GatewayProvider;
    status: string;
    createdAt: Date;
  }>;
};

type AdminWebhookIssueRecord = {
  id: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  updatedAt: Date;
  webhookEndpoint: {
    url: string;
    merchant: {
      id: string;
      name: string;
    };
  };
};

type AdminSupportEscalationRecord = {
  id: string;
  status: SupportEscalationStatus;
  reason: string;
  emailTo: string;
  createdAt: Date;
  merchant: {
    id: string;
    name: string;
  };
  conversation: {
    id: string;
    title: string | null;
  };
};

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview() {
    const now = new Date();
    const todayStart = this.startOfDay(now);
    const sevenDayStart = this.startOfDay(this.addDays(now, -6));
    const thirtyDayStart = this.startOfDay(this.addDays(now, -29));

    const [
      merchants,
      payments,
      failedWebhookDeliveries,
      retryingWebhookDeliveries,
      recentWebhookIssues,
      supportConversationCount,
      supportEscalationCount,
      recentEscalations,
    ] = await Promise.all([
      this.prisma.merchant.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          createdAt: true,
        },
      }),
      this.prisma.payment.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          reference: true,
          baseAmountCents: true,
          amountCents: true,
          platformFeeCents: true,
          providerFeeCents: true,
          merchantNetCents: true,
          status: true,
          gateway: true,
          createdAt: true,
          updatedAt: true,
          expiresAt: true,
          rawGateway: true,
          merchant: {
            select: {
              id: true,
              name: true,
            },
          },
          attempts: {
            orderBy: { createdAt: 'asc' },
            select: {
              gateway: true,
              status: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.webhookDelivery.count({
        where: {
          status: WebhookDeliveryStatus.FAILED,
        },
      }),
      this.prisma.webhookDelivery.count({
        where: {
          status: WebhookDeliveryStatus.PENDING,
          attempts: { gt: 0 },
        },
      }),
      this.prisma.webhookDelivery.findMany({
        where: {
          OR: [
            { status: WebhookDeliveryStatus.FAILED },
            {
              status: WebhookDeliveryStatus.PENDING,
              attempts: { gt: 0 },
            },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          event: true,
          status: true,
          attempts: true,
          lastError: true,
          nextAttemptAt: true,
          updatedAt: true,
          webhookEndpoint: {
            select: {
              url: true,
              merchant: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.supportConversation.count(),
      this.prisma.supportEscalation.count(),
      this.prisma.supportEscalation.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          status: true,
          reason: true,
          emailTo: true,
          createdAt: true,
          merchant: {
            select: {
              id: true,
              name: true,
            },
          },
          conversation: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      }),
    ]);

    const merchantRecords = merchants as AdminMerchantRecord[];
    const paymentRecords = (payments as AdminPaymentRecord[]).filter(
      (payment) => !this.isMerchantSignupBootstrapPayment(payment.rawGateway),
    );
    const webhookIssueRecords =
      recentWebhookIssues as AdminWebhookIssueRecord[];
    const supportEscalationRecords =
      recentEscalations as AdminSupportEscalationRecord[];

    const totalMerchants = merchantRecords.length;
    const activeMerchants = merchantRecords.filter(
      (merchant) => merchant.isActive,
    ).length;

    const paidPayments = paymentRecords.filter(
      (payment) => payment.status === PaymentStatus.PAID,
    );
    const successfulPayments = paidPayments.length;
    const failedOnlyPayments = paymentRecords.filter(
      (payment) => payment.status === PaymentStatus.FAILED,
    );
    const cancelledPayments = paymentRecords.filter(
      (payment) => payment.status === PaymentStatus.CANCELLED,
    );
    const failedPayments = failedOnlyPayments.length;
    const pendingPayments = paymentRecords.filter(
      (payment) => payment.status === PaymentStatus.PENDING,
    );
    const createdPayments = paymentRecords.filter(
      (payment) => payment.status === PaymentStatus.CREATED,
    );
    const expiredPayments = paymentRecords.filter(
      (payment) =>
        (payment.status === PaymentStatus.CREATED ||
          payment.status === PaymentStatus.PENDING) &&
        payment.expiresAt < now,
    );
    const terminalPayments =
      successfulPayments + failedPayments + cancelledPayments.length;
    const successRate =
      terminalPayments > 0
        ? Number(((successfulPayments / terminalPayments) * 100).toFixed(2))
        : 0;
    const failoverCount = paymentRecords.filter((payment) =>
      this.paymentUsedFailover(payment),
    ).length;
    const gatewayUsage = this.buildGatewayUsage(paymentRecords);
    const grossProcessedVolumeCents = paidPayments.reduce(
      (sum, payment) => sum + payment.amountCents,
      0,
    );
    const stackauraFeeEarnedCents = paidPayments.reduce(
      (sum, payment) => sum + payment.platformFeeCents,
      0,
    );
    const merchantReceivableVolumeCents = paidPayments.reduce(
      (sum, payment) => sum + payment.merchantNetCents,
      0,
    );
    const observedProviderFeePayments = paidPayments.filter(
      (payment) => typeof payment.providerFeeCents === 'number',
    );
    const providerFeesObservedCents =
      observedProviderFeePayments.length > 0
        ? observedProviderFeePayments.reduce(
            (sum, payment) => sum + (payment.providerFeeCents ?? 0),
            0,
          )
        : null;
    const netVolumeAfterProviderFeesCents =
      providerFeesObservedCents === null
        ? null
        : Math.max(
            0,
            merchantReceivableVolumeCents - providerFeesObservedCents,
          );
    const averageFeePerPaymentCents =
      successfulPayments > 0
        ? Math.round(stackauraFeeEarnedCents / successfulPayments)
        : 0;
    const reachedPendingCount = paymentRecords.length - createdPayments.length;

    return {
      generatedAt: now.toISOString(),
      business: {
        totalMerchants,
        activeMerchants,
        newSignups: {
          today: this.countMerchantsSince(merchantRecords, todayStart),
          last7Days: this.countMerchantsSince(merchantRecords, sevenDayStart),
          last30Days: this.countMerchantsSince(merchantRecords, thirtyDayStart),
        },
        signupTrend: this.buildDateSeries({
          start: thirtyDayStart,
          end: now,
          dates: merchantRecords.map((merchant) => merchant.createdAt),
        }),
      },
      payments: {
        totalPayments: paymentRecords.length,
        successfulPayments,
        failedPayments,
        successRate,
        failoverCount,
        gatewayUsage,
        paymentsOverTime: this.buildPaymentTrend(
          paymentRecords,
          thirtyDayStart,
          now,
        ),
        recentOutcomes: paymentRecords
          .filter(
            (payment) =>
              payment.status === PaymentStatus.PAID ||
              payment.status === PaymentStatus.FAILED ||
              payment.status === PaymentStatus.CANCELLED,
          )
          .slice(0, 12)
          .map((payment) => ({
            reference: payment.reference,
            merchantId: payment.merchant.id,
            merchantName: payment.merchant.name,
            amountCents: payment.amountCents,
            status: payment.status,
            gateway: this.resolveGateway(payment),
            gatewayLabel: this.formatGatewayLabel(this.resolveGateway(payment)),
            createdAt: payment.createdAt.toISOString(),
          })),
        recentErrors: paymentRecords
          .filter(
            (payment) =>
              payment.status === PaymentStatus.FAILED ||
              payment.status === PaymentStatus.CANCELLED,
          )
          .slice(0, 8)
          .map((payment) => ({
            reference: payment.reference,
            merchantId: payment.merchant.id,
            merchantName: payment.merchant.name,
            status: payment.status,
            gateway: this.resolveGateway(payment),
            gatewayLabel: this.formatGatewayLabel(this.resolveGateway(payment)),
            createdAt: payment.createdAt.toISOString(),
            routeSummary: this.buildRouteSummary(payment),
          })),
      },
      revenue: {
        grossProcessedVolumeCents,
        stackauraFeeEarnedCents,
        providerFeesObservedCents,
        netVolumeAfterProviderFeesCents,
        averageFeePerPaymentCents,
        revenueOverTime: this.buildRevenueTrend(
          paidPayments,
          thirtyDayStart,
          now,
        ),
        revenueByGateway: this.buildRevenueByGateway(paidPayments),
        revenueByMerchant: this.buildRevenueByMerchant(paidPayments),
        recentFeeBearingPayments: paidPayments
          .filter((payment) => payment.platformFeeCents > 0)
          .slice(0, 8)
          .map((payment) => ({
            reference: payment.reference,
            merchantId: payment.merchant.id,
            merchantName: payment.merchant.name,
            gateway: this.resolveGateway(payment),
            gatewayLabel: this.formatGatewayLabel(this.resolveGateway(payment)),
            baseAmountCents: payment.baseAmountCents,
            amountCents: payment.amountCents,
            platformFeeCents: payment.platformFeeCents,
            merchantNetCents: payment.merchantNetCents,
            createdAt: payment.createdAt.toISOString(),
          })),
        providerFeesAvailable: providerFeesObservedCents !== null,
      },
      funnel: {
        counts: {
          created: createdPayments.length,
          pending: pendingPayments.length,
          paid: successfulPayments,
          failed: failedPayments,
          cancelled: cancelledPayments.length,
          expired: expiredPayments.length,
        },
        conversion: {
          createdToPendingPct: this.calculatePercentage(
            reachedPendingCount,
            paymentRecords.length,
          ),
          pendingToPaidPct: this.calculatePercentage(
            successfulPayments,
            reachedPendingCount,
          ),
          createdToPaidPct: this.calculatePercentage(
            successfulPayments,
            paymentRecords.length,
          ),
          pendingToTerminalPct: this.calculatePercentage(
            successfulPayments + failedPayments + cancelledPayments.length,
            reachedPendingCount,
          ),
        },
        overTime: this.buildFunnelTrend(paymentRecords, thirtyDayStart, now),
      },
      gatewayHealth: {
        byGateway: this.buildGatewayHealth(paymentRecords),
        recentIncidents: paymentRecords
          .filter(
            (payment) =>
              payment.status === PaymentStatus.FAILED ||
              payment.status === PaymentStatus.CANCELLED,
          )
          .slice(0, 12)
          .map((payment) => ({
            reference: payment.reference,
            merchantId: payment.merchant.id,
            merchantName: payment.merchant.name,
            gateway: this.resolveGateway(payment),
            gatewayLabel: this.formatGatewayLabel(this.resolveGateway(payment)),
            status: payment.status,
            routeSummary: this.buildRouteSummary(payment),
            createdAt: payment.createdAt.toISOString(),
          })),
        dataNotes: {
          webhookIssuesByGateway:
            'Not wired yet. Webhook delivery failures are currently stored by endpoint and merchant, not by gateway.',
          avgResolutionTime:
            'Derived from payment updatedAt minus payment createdAt for terminal payments.',
        },
      },
      operations: {
        webhookIssues: {
          totalIssues: failedWebhookDeliveries + retryingWebhookDeliveries,
          failedDeliveries: failedWebhookDeliveries,
          retryingDeliveries: retryingWebhookDeliveries,
          recent: webhookIssueRecords.map((delivery) => ({
            id: delivery.id,
            merchantId: delivery.webhookEndpoint.merchant.id,
            merchantName: delivery.webhookEndpoint.merchant.name,
            event: delivery.event,
            status: delivery.status,
            attempts: delivery.attempts,
            lastError: delivery.lastError,
            nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
            updatedAt: delivery.updatedAt.toISOString(),
          })),
        },
        support: {
          conversationCount: supportConversationCount,
          escalationCount: supportEscalationCount,
          recentEscalations: supportEscalationRecords.map((escalation) => ({
            id: escalation.id,
            merchantId: escalation.merchant.id,
            merchantName: escalation.merchant.name,
            status: escalation.status,
            reason: escalation.reason,
            emailTo: escalation.emailTo,
            conversationTitle:
              escalation.conversation.title ?? 'Support conversation',
            createdAt: escalation.createdAt.toISOString(),
          })),
        },
        recentIssues: this.buildRecentIssues({
          payments: paymentRecords,
          webhookIssues: webhookIssueRecords,
          escalations: supportEscalationRecords,
        }),
      },
      dataNotes: {
        successRate:
          'Calculated from terminal payments only, where terminal payments are PAID, FAILED, or CANCELLED.',
        failoverCount:
          'Counts payments that recorded an explicit fallback signal or used more than one gateway attempt.',
        gatewayUsage:
          'Resolved from the latest payment attempt when attempts exist, otherwise from the payment gateway field.',
      },
    };
  }

  private countMerchantsSince(merchants: AdminMerchantRecord[], start: Date) {
    return merchants.filter((merchant) => merchant.createdAt >= start).length;
  }

  private buildDateSeries(args: { start: Date; end: Date; dates: Date[] }) {
    const counts = new Map<string, number>();

    for (const date of args.dates) {
      if (date < args.start || date > args.end) {
        continue;
      }

      const key = this.dateKey(date);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const series: Array<{ date: string; count: number }> = [];
    for (
      let cursor = new Date(args.start);
      cursor <= args.end;
      cursor = this.addDays(cursor, 1)
    ) {
      const key = this.dateKey(cursor);
      series.push({
        date: key,
        count: counts.get(key) ?? 0,
      });
    }

    return series;
  }

  private buildPaymentTrend(
    payments: AdminPaymentRecord[],
    start: Date,
    end: Date,
  ) {
    const counts = new Map<
      string,
      { date: string; total: number; successful: number; failed: number }
    >();

    for (const payment of payments) {
      if (payment.createdAt < start || payment.createdAt > end) {
        continue;
      }

      const key = this.dateKey(payment.createdAt);
      const bucket = counts.get(key) ?? {
        date: key,
        total: 0,
        successful: 0,
        failed: 0,
      };

      bucket.total += 1;
      if (payment.status === PaymentStatus.PAID) {
        bucket.successful += 1;
      }
      if (
        payment.status === PaymentStatus.FAILED ||
        payment.status === PaymentStatus.CANCELLED
      ) {
        bucket.failed += 1;
      }

      counts.set(key, bucket);
    }

    const series: Array<{
      date: string;
      total: number;
      successful: number;
      failed: number;
    }> = [];
    for (
      let cursor = new Date(start);
      cursor <= end;
      cursor = this.addDays(cursor, 1)
    ) {
      const key = this.dateKey(cursor);
      series.push(
        counts.get(key) ?? {
          date: key,
          total: 0,
          successful: 0,
          failed: 0,
        },
      );
    }

    return series;
  }

  private calculatePercentage(numerator: number, denominator: number) {
    if (denominator <= 0) {
      return 0;
    }

    return Number(((numerator / denominator) * 100).toFixed(2));
  }

  private buildRevenueTrend(
    payments: AdminPaymentRecord[],
    start: Date,
    end: Date,
  ) {
    const buckets = new Map<
      string,
      {
        date: string;
        grossVolumeCents: number;
        stackauraFeeCents: number;
        merchantReceivableCents: number;
        providerFeeObservedCents: number | null;
      }
    >();

    for (const payment of payments) {
      if (payment.createdAt < start || payment.createdAt > end) {
        continue;
      }

      const key = this.dateKey(payment.createdAt);
      const bucket = buckets.get(key) ?? {
        date: key,
        grossVolumeCents: 0,
        stackauraFeeCents: 0,
        merchantReceivableCents: 0,
        providerFeeObservedCents: null,
      };

      bucket.grossVolumeCents += payment.amountCents;
      bucket.stackauraFeeCents += payment.platformFeeCents;
      bucket.merchantReceivableCents += payment.merchantNetCents;
      if (typeof payment.providerFeeCents === 'number') {
        bucket.providerFeeObservedCents =
          (bucket.providerFeeObservedCents ?? 0) + payment.providerFeeCents;
      }

      buckets.set(key, bucket);
    }

    const series: Array<{
      date: string;
      grossVolumeCents: number;
      stackauraFeeCents: number;
      merchantReceivableCents: number;
      providerFeeObservedCents: number | null;
      netVolumeAfterProviderFeesCents: number | null;
    }> = [];
    for (
      let cursor = new Date(start);
      cursor <= end;
      cursor = this.addDays(cursor, 1)
    ) {
      const key = this.dateKey(cursor);
      const bucket = buckets.get(key) ?? {
        date: key,
        grossVolumeCents: 0,
        stackauraFeeCents: 0,
        merchantReceivableCents: 0,
        providerFeeObservedCents: null,
      };

      series.push({
        ...bucket,
        netVolumeAfterProviderFeesCents:
          bucket.providerFeeObservedCents === null
            ? null
            : Math.max(
                0,
                bucket.merchantReceivableCents -
                  bucket.providerFeeObservedCents,
              ),
      });
    }

    return series;
  }

  private buildRevenueByGateway(payments: AdminPaymentRecord[]) {
    const distribution = new Map<
      GatewayProvider,
      {
        gateway: GatewayProvider;
        label: string;
        paymentCount: number;
        grossVolumeCents: number;
        stackauraFeeCents: number;
        providerFeeObservedCents: number | null;
        merchantReceivableCents: number;
      }
    >();

    for (const payment of payments) {
      const gateway = this.resolveGateway(payment);
      if (!gateway) {
        continue;
      }

      const current = distribution.get(gateway) ?? {
        gateway,
        label: this.formatGatewayLabel(gateway),
        paymentCount: 0,
        grossVolumeCents: 0,
        stackauraFeeCents: 0,
        providerFeeObservedCents: null,
        merchantReceivableCents: 0,
      };

      current.paymentCount += 1;
      current.grossVolumeCents += payment.amountCents;
      current.stackauraFeeCents += payment.platformFeeCents;
      current.merchantReceivableCents += payment.merchantNetCents;
      if (typeof payment.providerFeeCents === 'number') {
        current.providerFeeObservedCents =
          (current.providerFeeObservedCents ?? 0) + payment.providerFeeCents;
      }

      distribution.set(gateway, current);
    }

    return Array.from(distribution.values()).sort(
      (left, right) => right.grossVolumeCents - left.grossVolumeCents,
    );
  }

  private buildRevenueByMerchant(payments: AdminPaymentRecord[]) {
    const distribution = new Map<
      string,
      {
        merchantId: string;
        merchantName: string;
        paymentCount: number;
        grossVolumeCents: number;
        stackauraFeeCents: number;
        providerFeeObservedCents: number | null;
        merchantReceivableCents: number;
      }
    >();

    for (const payment of payments) {
      const current = distribution.get(payment.merchant.id) ?? {
        merchantId: payment.merchant.id,
        merchantName: payment.merchant.name,
        paymentCount: 0,
        grossVolumeCents: 0,
        stackauraFeeCents: 0,
        providerFeeObservedCents: null,
        merchantReceivableCents: 0,
      };

      current.paymentCount += 1;
      current.grossVolumeCents += payment.amountCents;
      current.stackauraFeeCents += payment.platformFeeCents;
      current.merchantReceivableCents += payment.merchantNetCents;
      if (typeof payment.providerFeeCents === 'number') {
        current.providerFeeObservedCents =
          (current.providerFeeObservedCents ?? 0) + payment.providerFeeCents;
      }

      distribution.set(payment.merchant.id, current);
    }

    return Array.from(distribution.values()).sort(
      (left, right) => right.grossVolumeCents - left.grossVolumeCents,
    );
  }

  private buildFunnelTrend(
    payments: AdminPaymentRecord[],
    start: Date,
    end: Date,
  ) {
    const counts = new Map<
      string,
      {
        date: string;
        created: number;
        pending: number;
        paid: number;
        failed: number;
        cancelled: number;
        expired: number;
      }
    >();

    for (const payment of payments) {
      if (payment.createdAt < start || payment.createdAt > end) {
        continue;
      }

      const key = this.dateKey(payment.createdAt);
      const bucket = counts.get(key) ?? {
        date: key,
        created: 0,
        pending: 0,
        paid: 0,
        failed: 0,
        cancelled: 0,
        expired: 0,
      };

      if (payment.status === PaymentStatus.CREATED) {
        bucket.created += 1;
      } else if (payment.status === PaymentStatus.PENDING) {
        bucket.pending += 1;
        if (payment.expiresAt < new Date()) {
          bucket.expired += 1;
        }
      } else if (payment.status === PaymentStatus.PAID) {
        bucket.paid += 1;
      } else if (payment.status === PaymentStatus.FAILED) {
        bucket.failed += 1;
      } else if (payment.status === PaymentStatus.CANCELLED) {
        bucket.cancelled += 1;
      }

      counts.set(key, bucket);
    }

    const series: Array<{
      date: string;
      created: number;
      pending: number;
      paid: number;
      failed: number;
      cancelled: number;
      expired: number;
    }> = [];
    for (
      let cursor = new Date(start);
      cursor <= end;
      cursor = this.addDays(cursor, 1)
    ) {
      const key = this.dateKey(cursor);
      series.push(
        counts.get(key) ?? {
          date: key,
          created: 0,
          pending: 0,
          paid: 0,
          failed: 0,
          cancelled: 0,
          expired: 0,
        },
      );
    }

    return series;
  }

  private buildGatewayHealth(payments: AdminPaymentRecord[]) {
    const buckets = new Map<
      GatewayProvider,
      {
        gateway: GatewayProvider;
        label: string;
        totalPayments: number;
        paid: number;
        failed: number;
        cancelled: number;
        failoverCount: number;
        resolutionMinutesSum: number;
        resolutionSampleCount: number;
        latestFailingReferences: Array<{
          reference: string;
          status: string;
          createdAt: string;
        }>;
      }
    >();

    for (const payment of payments) {
      const gateway = this.resolveGateway(payment);
      if (!gateway) {
        continue;
      }

      const current = buckets.get(gateway) ?? {
        gateway,
        label: this.formatGatewayLabel(gateway),
        totalPayments: 0,
        paid: 0,
        failed: 0,
        cancelled: 0,
        failoverCount: 0,
        resolutionMinutesSum: 0,
        resolutionSampleCount: 0,
        latestFailingReferences: [],
      };

      current.totalPayments += 1;
      if (payment.status === PaymentStatus.PAID) {
        current.paid += 1;
      }
      if (payment.status === PaymentStatus.FAILED) {
        current.failed += 1;
      }
      if (payment.status === PaymentStatus.CANCELLED) {
        current.cancelled += 1;
      }
      if (this.paymentUsedFailover(payment)) {
        current.failoverCount += 1;
      }
      if (
        payment.status === PaymentStatus.PAID ||
        payment.status === PaymentStatus.FAILED ||
        payment.status === PaymentStatus.CANCELLED
      ) {
        current.resolutionMinutesSum += Math.max(
          0,
          (payment.updatedAt.getTime() - payment.createdAt.getTime()) / 60000,
        );
        current.resolutionSampleCount += 1;
      }
      if (
        (payment.status === PaymentStatus.FAILED ||
          payment.status === PaymentStatus.CANCELLED) &&
        current.latestFailingReferences.length < 5
      ) {
        current.latestFailingReferences.push({
          reference: payment.reference,
          status: payment.status,
          createdAt: payment.createdAt.toISOString(),
        });
      }

      buckets.set(gateway, current);
    }

    return Array.from(buckets.values())
      .map((bucket) => ({
        gateway: bucket.gateway,
        label: bucket.label,
        totalPayments: bucket.totalPayments,
        successRate: this.calculatePercentage(
          bucket.paid,
          bucket.totalPayments,
        ),
        failureRate: this.calculatePercentage(
          bucket.failed,
          bucket.totalPayments,
        ),
        cancelRate: this.calculatePercentage(
          bucket.cancelled,
          bucket.totalPayments,
        ),
        failoverCount: bucket.failoverCount,
        webhookIssueCount: null as number | null,
        avgResolutionMinutes:
          bucket.resolutionSampleCount > 0
            ? Number(
                (
                  bucket.resolutionMinutesSum / bucket.resolutionSampleCount
                ).toFixed(2),
              )
            : null,
        latestFailingReferences: bucket.latestFailingReferences,
      }))
      .sort((left, right) => right.totalPayments - left.totalPayments);
  }

  private buildGatewayUsage(payments: AdminPaymentRecord[]) {
    const distribution = new Map<
      GatewayProvider,
      {
        gateway: GatewayProvider;
        label: string;
        count: number;
        volumeCents: number;
      }
    >();

    for (const payment of payments) {
      const gateway = this.resolveGateway(payment);
      if (!gateway) {
        continue;
      }

      const current = distribution.get(gateway) ?? {
        gateway,
        label: this.formatGatewayLabel(gateway),
        count: 0,
        volumeCents: 0,
      };
      current.count += 1;
      current.volumeCents += payment.amountCents;
      distribution.set(gateway, current);
    }

    return Array.from(distribution.values()).sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return left.label.localeCompare(right.label);
    });
  }

  private buildRecentIssues(args: {
    payments: AdminPaymentRecord[];
    webhookIssues: AdminWebhookIssueRecord[];
    escalations: AdminSupportEscalationRecord[];
  }) {
    return [
      ...args.payments
        .filter(
          (payment) =>
            payment.status === PaymentStatus.FAILED ||
            payment.status === PaymentStatus.CANCELLED,
        )
        .slice(0, 6)
        .map((payment) => ({
          kind: 'payment_error' as const,
          createdAt: payment.createdAt.toISOString(),
          merchantId: payment.merchant.id,
          merchantName: payment.merchant.name,
          title: payment.reference,
          status: payment.status,
          detail: this.buildRouteSummary(payment),
        })),
      ...args.webhookIssues.map((issue) => ({
        kind: 'webhook_issue' as const,
        createdAt: issue.updatedAt.toISOString(),
        merchantId: issue.webhookEndpoint.merchant.id,
        merchantName: issue.webhookEndpoint.merchant.name,
        title: issue.event,
        status: issue.status,
        detail: issue.lastError ?? `Attempts: ${issue.attempts}`,
      })),
      ...args.escalations.map((escalation) => ({
        kind: 'support_escalation' as const,
        createdAt: escalation.createdAt.toISOString(),
        merchantId: escalation.merchant.id,
        merchantName: escalation.merchant.name,
        title: escalation.conversation.title ?? 'Support escalation',
        status: escalation.status,
        detail: escalation.reason,
      })),
    ]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 12);
  }

  private buildRouteSummary(payment: AdminPaymentRecord) {
    const steps = payment.attempts.flatMap((attempt) => {
      const parts = [this.formatGatewayLabel(attempt.gateway)];
      const statusLabel = this.mapAttemptStatus(attempt.status);
      if (statusLabel) {
        parts.push(statusLabel);
      }
      return parts;
    });

    if (
      payment.status === PaymentStatus.PAID &&
      steps[steps.length - 1] !== 'Succeeded'
    ) {
      steps.push('Succeeded');
    }

    return steps.length > 0
      ? steps.join(' -> ')
      : 'No routing history available';
  }

  private mapAttemptStatus(status: string) {
    const normalized = status.trim().toUpperCase();
    if (normalized === 'FAILED' || normalized === 'CANCELLED') {
      return 'Failed';
    }
    if (
      normalized === 'PAID' ||
      normalized === 'SUCCESS' ||
      normalized === 'SUCCEEDED'
    ) {
      return 'Succeeded';
    }
    if (normalized === 'PENDING' || normalized === 'INITIATED') {
      return 'Initiated';
    }
    return null;
  }

  private paymentUsedFailover(payment: AdminPaymentRecord) {
    const routingMeta = this.extractRoutingMeta(payment.rawGateway);
    if (routingMeta.fallbackCount > 0) {
      return true;
    }

    const distinctGateways = new Set(
      payment.attempts.map((attempt) => attempt.gateway),
    );
    return distinctGateways.size > 1;
  }

  private extractRoutingMeta(rawGateway: Prisma.JsonValue | null | undefined) {
    const root = this.asJsonRecord(rawGateway);
    const routing = this.asJsonRecord(root?.routing);
    const fallbackCount = this.parseCount(routing?.fallbackCount);

    return {
      fallbackCount,
    };
  }

  private parseCount(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }

    return 0;
  }

  private resolveGateway(payment: AdminPaymentRecord) {
    const latestAttempt = payment.attempts[payment.attempts.length - 1] ?? null;
    return latestAttempt?.gateway ?? payment.gateway ?? null;
  }

  private isMerchantSignupBootstrapPayment(
    rawGateway: Prisma.JsonValue | null | undefined,
  ) {
    const root = this.asJsonRecord(rawGateway);
    const publicFlow = this.asJsonRecord(root?.publicFlow);
    return publicFlow?.flow === 'merchant_signup';
  }

  private asJsonRecord(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private formatGatewayLabel(gateway: GatewayProvider | null) {
    if (!gateway) {
      return 'Unknown';
    }

    if (gateway === GatewayProvider.PAYSTACK) {
      return 'Paystack';
    }
    if (gateway === GatewayProvider.YOCO) {
      return 'Yoco';
    }
    if (gateway === GatewayProvider.OZOW) {
      return 'Ozow';
    }
    if (gateway === GatewayProvider.PAYFAST) {
      return 'PayFast';
    }
    return gateway;
  }

  private startOfDay(value: Date) {
    const next = new Date(value);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  private addDays(value: Date, days: number) {
    const next = new Date(value);
    next.setDate(next.getDate() + days);
    return next;
  }

  private dateKey(value: Date) {
    return value.toISOString().slice(0, 10);
  }
}
