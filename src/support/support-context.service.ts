import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus, PayoutStatus } from '@prisma/client';
import { resolveMerchantPlan } from '../payments/monetization.config';
import { MerchantsService } from '../merchants/merchants.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  MerchantSupportContext,
  MerchantSupportEnvironment,
} from './support.types';

@Injectable()
export class SupportContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merchantsService: MerchantsService,
  ) {}

  async buildMerchantContext(
    merchantId: string,
  ): Promise<MerchantSupportContext> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        planCode: true,
        platformFeeBps: true,
        platformFeeFixedCents: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }

    const [
      ozow,
      yoco,
      paystack,
      apiKeys,
      analytics,
      recentPayouts,
      pendingPayoutCount,
      failedPayoutCount,
      recentPaymentFailures,
    ] = await Promise.all([
      this.merchantsService.getOzowGatewayConnection(merchantId),
      this.merchantsService.getYocoGatewayConnection(merchantId),
      this.merchantsService.getPaystackGatewayConnection(merchantId),
      this.prisma.apiKey.findMany({
        where: { merchantId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          prefix: true,
          createdAt: true,
          lastUsedAt: true,
        },
      }),
      this.merchantsService.getMerchantAnalytics(merchantId),
      this.prisma.payout.findMany({
        where: { merchantId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          reference: true,
          status: true,
          amountCents: true,
          currency: true,
          provider: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.payout.count({
        where: {
          merchantId,
          status: {
            in: [PayoutStatus.CREATED, PayoutStatus.PENDING],
          },
        },
      }),
      this.prisma.payout.count({
        where: {
          merchantId,
          status: PayoutStatus.FAILED,
        },
      }),
      this.prisma.payment.findMany({
        where: {
          merchantId,
          status: {
            in: [PaymentStatus.FAILED, PaymentStatus.CANCELLED],
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          reference: true,
          status: true,
          gateway: true,
          updatedAt: true,
          attempts: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              gateway: true,
              status: true,
            },
          },
        },
      }),
    ]);

    const plan = resolveMerchantPlan({
      merchantPlanCode: merchant.planCode,
      merchantPlatformFeeBps: merchant.platformFeeBps,
      merchantPlatformFeeFixedCents: merchant.platformFeeFixedCents,
    });

    const testKeyCount = apiKeys.filter((key) =>
      key.prefix?.toLowerCase().startsWith('ck_test'),
    ).length;
    const liveKeyCount = apiKeys.filter((key) =>
      key.prefix?.toLowerCase().startsWith('ck_live'),
    ).length;
    const currentEnvironment = this.resolveEnvironment({
      testKeyCount,
      liveKeyCount,
      ozowTestMode:
        typeof ozow.testMode === 'boolean' ? ozow.testMode : undefined,
      yocoTestMode:
        typeof yoco.testMode === 'boolean' ? yoco.testMode : undefined,
      paystackTestMode:
        typeof paystack.testMode === 'boolean' ? paystack.testMode : undefined,
      connectedGateways: [ozow.connected, yoco.connected, paystack.connected],
    });

    const hasApiKeys = apiKeys.length > 0;
    const onboardingCompleted = merchant.isActive;

    return {
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        isActive: merchant.isActive,
        accountStatus: merchant.isActive ? 'ACTIVE' : 'PENDING_ACTIVATION',
        planCode: plan.code,
        plan: {
          code: plan.code,
          source: plan.source,
          feeSource: plan.feePolicy.source,
          manualGatewaySelection: plan.routingFeatures.manualGatewaySelection,
          autoRouting: plan.routingFeatures.autoRouting,
          fallback: plan.routingFeatures.fallback,
        },
        currentEnvironment,
        createdAt: merchant.createdAt.toISOString(),
        updatedAt: merchant.updatedAt.toISOString(),
      },
      gateways: {
        connectedCount: [
          ozow.connected,
          yoco.connected,
          paystack.connected,
        ].filter(Boolean).length,
        ozow,
        yoco,
        paystack,
      },
      apiKeys: {
        activeCount: apiKeys.length,
        testKeyCount,
        liveKeyCount,
        latestCreatedAt: apiKeys[0]?.createdAt?.toISOString() ?? null,
        latestLastUsedAt:
          apiKeys
            .map((key) => key.lastUsedAt)
            .filter((value): value is Date => value instanceof Date)
            .sort((left, right) => right.getTime() - left.getTime())[0]
            ?.toISOString() ?? null,
      },
      onboarding: {
        completed: onboardingCompleted,
        status: onboardingCompleted ? 'COMPLETED' : 'PENDING_ACTIVATION',
        detail: onboardingCompleted
          ? 'This merchant is active in Stackaura and can use authenticated dashboard features.'
          : hasApiKeys
            ? 'This merchant has at least one API key, but the account is still not fully active.'
            : 'This merchant is still pending activation and does not yet appear fully onboarded.',
      },
      payments: {
        totalPayments: analytics.totalPayments,
        totalVolumeCents: analytics.totalVolumeCents,
        successRate: analytics.successRate,
        recoveredPayments: analytics.recoveredPayments,
        activeGatewaysUsed: analytics.activeGatewaysUsed,
        recentFailures: recentPaymentFailures.map((payment) => ({
          reference: payment.reference,
          status: payment.status,
          gateway: payment.gateway ?? null,
          updatedAt: payment.updatedAt.toISOString(),
          lastAttemptGateway: payment.attempts[0]?.gateway ?? null,
          lastAttemptStatus: payment.attempts[0]?.status ?? null,
        })),
        recentRoutingIssues: analytics.recentRoutingHistory
          .slice(0, 3)
          .map((item) => ({
            reference: item.reference,
            status: item.status,
            routeSummary: item.routeSummary,
            fallbackCount: item.fallbackCount,
            createdAt: item.createdAt,
          })),
      },
      payouts: {
        pendingCount: pendingPayoutCount,
        failedCount: failedPayoutCount,
        recent: recentPayouts.map((payout) => ({
          reference: payout.reference,
          status: payout.status,
          amountCents: payout.amountCents,
          currency: payout.currency,
          provider: payout.provider ?? null,
          createdAt: payout.createdAt.toISOString(),
          updatedAt: payout.updatedAt.toISOString(),
        })),
      },
      kyc: {
        tracked: false,
        status: 'UNAVAILABLE',
        detail:
          'KYC progress is not explicitly tracked in the current Stackaura merchant schema yet.',
      },
      supportInboxEmail: this.getSupportInboxEmail(),
      generatedAt: new Date().toISOString(),
    };
  }

  private getSupportInboxEmail() {
    return (
      process.env.SUPPORT_INBOX_EMAIL?.trim() || 'wesupport@stackaura.co.za'
    );
  }

  private resolveEnvironment(args: {
    testKeyCount: number;
    liveKeyCount: number;
    ozowTestMode?: boolean;
    yocoTestMode?: boolean;
    paystackTestMode?: boolean;
    connectedGateways: boolean[];
  }): MerchantSupportEnvironment {
    if (args.testKeyCount > 0 && args.liveKeyCount > 0) {
      return 'mixed';
    }

    if (args.liveKeyCount > 0) {
      return 'live';
    }

    if (args.testKeyCount > 0) {
      return 'test';
    }

    const gatewayModes = [
      args.ozowTestMode,
      args.yocoTestMode,
      args.paystackTestMode,
    ].filter((value): value is boolean => typeof value === 'boolean');

    if (
      gatewayModes.length === 0 ||
      args.connectedGateways.every((value) => !value)
    ) {
      return 'unknown';
    }

    const hasTest = gatewayModes.some((value) => value === true);
    const hasLive = gatewayModes.some((value) => value === false);

    if (hasTest && hasLive) {
      return 'mixed';
    }

    if (hasLive) {
      return 'live';
    }

    if (hasTest) {
      return 'test';
    }

    return 'unknown';
  }
}
