import { BadRequestException, Injectable } from '@nestjs/common';
import { GatewayProvider, Prisma } from '@prisma/client';
import { resolveOzowConfig } from '../gateways/ozow.config';
import {
  assertPaystackConfigConsistency,
  resolvePaystackConfig,
} from '../gateways/paystack.config';
import {
  assertYocoConfigConsistency,
  resolveYocoConfig,
} from '../gateways/yoco.config';

export type RoutingMode = 'STRICT_PRIORITY' | 'FAILOVER_PRIORITY';
export type RoutingSelectionMode = 'explicit' | 'auto';
export type RoutingPaymentMethodPreference = 'CARD' | 'BANK_EFT' | null;

export type RoutingCandidate = {
  gateway: GatewayProvider;
  priority: number;
  reason: string[];
};

export type GatewayReadiness = {
  gateway: GatewayProvider;
  ready: boolean;
  issues: string[];
  mode: 'test' | 'live' | null;
};

export type RoutingDecision = {
  mode: RoutingMode;
  selectionMode: RoutingSelectionMode;
  requestedGateway: GatewayProvider | 'AUTO' | null;
  selectedGateway: GatewayProvider;
  routingReason: string[];
  eligibleGateways: RoutingCandidate[];
  skippedGateways: Array<{
    gateway: GatewayProvider;
    issues: string[];
    mode: 'test' | 'live' | null;
  }>;
  rankedGateways: RoutingCandidate[];
  readiness: GatewayReadiness[];
};

type MerchantGatewayConfig = {
  gatewayOrder?: Prisma.JsonValue | null;
  payfastMerchantId?: string | null;
  payfastMerchantKey?: string | null;
  payfastIsSandbox?: boolean | null;
  ozowSiteCode?: string | null;
  ozowPrivateKey?: string | null;
  yocoPublicKey?: string | null;
  yocoSecretKey?: string | null;
  ozowApiKey?: string | null;
  ozowIsTest?: boolean | null;
  yocoTestMode?: boolean | null;
  paystackSecretKey?: string | null;
  paystackTestMode?: boolean | null;
};

@Injectable()
export class RoutingEngine {
  private readonly readinessRailOrder: GatewayProvider[] = [
    GatewayProvider.PAYSTACK,
    GatewayProvider.YOCO,
    GatewayProvider.OZOW,
  ];

  private readonly autoRailOrder: GatewayProvider[] = [
    GatewayProvider.PAYSTACK,
    GatewayProvider.YOCO,
    GatewayProvider.OZOW,
  ];

  decide(args: {
    requestedGateway: GatewayProvider | 'AUTO' | null;
    merchant: MerchantGatewayConfig;
    excludedGateways?: GatewayProvider[];
    mode: RoutingMode;
    amountCents?: number | null;
    currency?: string | null;
    customerEmail?: string | null;
    paymentMethodPreference?: string | null;
  }): RoutingDecision {
    const readiness = this.getGatewayReadiness(args);
    const selectionMode: RoutingSelectionMode =
      args.requestedGateway && args.requestedGateway !== 'AUTO'
        ? 'explicit'
        : 'auto';
    const skippedGateways = readiness
      .filter((item) => !item.ready)
      .map((item) => ({
        gateway: item.gateway,
        issues: item.issues,
        mode: item.mode,
      }));

    if (args.requestedGateway && args.requestedGateway !== 'AUTO') {
      const excluded = new Set(args.excludedGateways ?? []);
      if (excluded.has(args.requestedGateway)) {
        throw new BadRequestException(
          `Gateway ${args.requestedGateway} is not available for this payment`,
        );
      }

      const gatewayReadiness =
        readiness.find((item) => item.gateway === args.requestedGateway) ??
        this.legacyGatewayReadiness(
          args.requestedGateway,
          args.merchant,
          args.excludedGateways,
        );
      if (!gatewayReadiness?.ready) {
        const issue = gatewayReadiness?.issues[0];
        throw new BadRequestException(
          issue
            ? `Gateway ${args.requestedGateway} is not available for this payment: ${issue}`
            : `Gateway ${args.requestedGateway} is not available for this payment`,
        );
      }

      return {
        mode: args.mode,
        selectionMode,
        requestedGateway: args.requestedGateway,
        selectedGateway: args.requestedGateway,
        routingReason: ['explicit_gateway_request'],
        eligibleGateways: [
          {
            gateway: args.requestedGateway,
            priority: 1,
            reason: ['explicit_gateway_request'],
          },
        ],
        skippedGateways,
        rankedGateways: [
          {
            gateway: args.requestedGateway,
            priority: 1,
            reason: ['explicit_gateway_request'],
          },
        ],
        readiness: [...readiness, gatewayReadiness].filter(
          (item, index, list) =>
            list.findIndex(
              (candidate) => candidate.gateway === item.gateway,
            ) === index,
        ),
      };
    }

    const paymentMethodPreference = this.normalizePaymentMethodPreference(
      args.paymentMethodPreference,
    );
    const eligible = this.buildEligibleGateways(
      readiness,
      this.resolveAutoRailOrder(paymentMethodPreference),
      paymentMethodPreference,
    );

    if (!eligible.length) {
      throw new BadRequestException(
        this.buildNoGatewayAvailableMessage(readiness),
      );
    }

    return {
      mode: args.mode,
      selectionMode,
      requestedGateway: args.requestedGateway ?? 'AUTO',
      selectedGateway: eligible[0].gateway,
      routingReason: eligible[0].reason,
      eligibleGateways: eligible,
      skippedGateways,
      rankedGateways: eligible,
      readiness,
    };
  }

  getGatewayReadiness(args: {
    merchant: MerchantGatewayConfig;
    excludedGateways?: GatewayProvider[];
    mode: RoutingMode;
    amountCents?: number | null;
    currency?: string | null;
    customerEmail?: string | null;
    paymentMethodPreference?: string | null;
  }): GatewayReadiness[] {
    const excluded = new Set(args.excludedGateways ?? []);
    const currency =
      typeof args.currency === 'string' && args.currency.trim()
        ? args.currency.trim().toUpperCase()
        : null;
    const amountCents =
      typeof args.amountCents === 'number' && Number.isFinite(args.amountCents)
        ? Math.trunc(args.amountCents)
        : null;

    return this.readinessRailOrder.map((gateway) => {
      const issues: string[] = [];
      if (excluded.has(gateway)) {
        issues.push('excluded from the current routing attempt');
      }

      if (gateway === GatewayProvider.OZOW) {
        const config = resolveOzowConfig({
          ozowSiteCode: args.merchant.ozowSiteCode ?? null,
          ozowPrivateKey: args.merchant.ozowPrivateKey ?? null,
          ozowApiKey: args.merchant.ozowApiKey ?? null,
          ozowIsTest: args.merchant.ozowIsTest ?? null,
        });

        if (config.hasPartialMerchantConfig) {
          issues.push('merchant Ozow config is incomplete');
        } else if (!config.siteCode || !config.privateKey) {
          issues.push('merchant Ozow credentials are not configured');
        }

        if (currency && currency !== 'ZAR') {
          issues.push('Ozow currently supports ZAR only');
        }

        return {
          gateway,
          ready: issues.length === 0,
          issues,
          mode: config.isTest ? 'test' : 'live',
        };
      }

      if (gateway === GatewayProvider.YOCO) {
        try {
          const config = resolveYocoConfig({
            yocoPublicKey: args.merchant.yocoPublicKey ?? null,
            yocoSecretKey: args.merchant.yocoSecretKey ?? null,
            yocoTestMode: args.merchant.yocoTestMode ?? null,
          });
          assertYocoConfigConsistency(config);

          if (!config.publicKey || !config.secretKey) {
            issues.push('merchant Yoco credentials are not configured');
          }

          if (currency && currency !== 'ZAR') {
            issues.push('Yoco currently supports ZAR only');
          }

          if (amountCents !== null && amountCents < 200) {
            issues.push('Yoco requires a minimum amount of 200 cents');
          }

          return {
            gateway,
            ready: issues.length === 0,
            issues,
            mode: config.testMode ? 'test' : 'live',
          };
        } catch (error) {
          issues.push(
            error instanceof Error
              ? error.message
              : 'merchant Yoco mode configuration is invalid',
          );

          return {
            gateway,
            ready: false,
            issues,
            mode: null,
          };
        }
      }

      if (gateway === GatewayProvider.PAYSTACK) {
        try {
          const config = resolvePaystackConfig({
            paystackSecretKey: args.merchant.paystackSecretKey ?? null,
            paystackTestMode: args.merchant.paystackTestMode ?? null,
          });
          assertPaystackConfigConsistency(config);

          if (!config.secretKey) {
            issues.push('merchant Paystack credentials are not configured');
          }

          if (!args.customerEmail || args.customerEmail.trim().length === 0) {
            issues.push('Paystack requires customerEmail');
          }

          return {
            gateway,
            ready: issues.length === 0,
            issues,
            mode: config.testMode ? 'test' : 'live',
          };
        } catch (error) {
          issues.push(
            error instanceof Error
              ? error.message
              : 'merchant Paystack mode configuration is invalid',
          );

          return {
            gateway,
            ready: false,
            issues,
            mode: null,
          };
        }
      }

      return {
        gateway,
        ready: false,
        issues: ['unsupported gateway'],
        mode: null,
      };
    });
  }

  private buildEligibleGateways(
    readiness: GatewayReadiness[],
    gatewayOrder: GatewayProvider[],
    paymentMethodPreference: RoutingPaymentMethodPreference,
  ): RoutingCandidate[] {
    return gatewayOrder
      .map(
        (gateway) =>
          readiness.find((candidate) => candidate.gateway === gateway) ?? null,
      )
      .filter((gateway): gateway is GatewayReadiness => Boolean(gateway?.ready))
      .map((gateway, index) => ({
        gateway: gateway.gateway,
        priority: index + 1,
        reason: [
          'auto_eligible_gateway',
          `priority=${index + 1}`,
          gateway.mode ? `mode=${gateway.mode}` : null,
          paymentMethodPreference
            ? `payment_method_preference=${paymentMethodPreference.toLowerCase()}`
            : null,
        ].filter((value): value is string => Boolean(value)),
      }));
  }

  private resolveAutoRailOrder(
    paymentMethodPreference: RoutingPaymentMethodPreference,
  ) {
    if (paymentMethodPreference === 'BANK_EFT') {
      return [
        GatewayProvider.OZOW,
        GatewayProvider.YOCO,
        GatewayProvider.PAYSTACK,
      ];
    }

    return this.autoRailOrder;
  }

  private normalizePaymentMethodPreference(
    value: string | null | undefined,
  ): RoutingPaymentMethodPreference {
    const normalized =
      typeof value === 'string' && value.trim()
        ? value.trim().toUpperCase()
        : null;

    if (!normalized) {
      return null;
    }

    if (
      normalized === 'BANK_EFT' ||
      normalized === 'BANK' ||
      normalized === 'EFT' ||
      normalized === 'INSTANT_EFT'
    ) {
      return 'BANK_EFT';
    }

    if (
      normalized === 'CARD' ||
      normalized === 'CARDS' ||
      normalized === 'CARD_PAYMENT'
    ) {
      return 'CARD';
    }

    return null;
  }

  private buildNoGatewayAvailableMessage(readiness: GatewayReadiness[]) {
    const details = readiness
      .map((gateway) => {
        const label = gateway.gateway;
        const issue = gateway.issues[0] ?? 'not ready';
        return `${label}: ${issue}`;
      })
      .join('; ');

    return details
      ? `No gateway available for this payment. ${details}`
      : 'No gateway available for this payment';
  }

  private legacyGatewayReadiness(
    gateway: GatewayProvider,
    merchant: MerchantGatewayConfig,
    excludedGateways?: GatewayProvider[],
  ): GatewayReadiness | null {
    const excluded = new Set(excludedGateways ?? []);
    const issues: string[] = [];
    if (excluded.has(gateway)) {
      issues.push('excluded from the current routing attempt');
    }

    switch (gateway) {
      case GatewayProvider.PAYFAST:
        if (!merchant.payfastMerchantId || !merchant.payfastMerchantKey) {
          issues.push('merchant PayFast credentials are not configured');
        }
        return {
          gateway,
          ready: issues.length === 0,
          issues,
          mode:
            typeof merchant.payfastIsSandbox === 'boolean'
              ? merchant.payfastIsSandbox
                ? 'test'
                : 'live'
              : null,
        };
      case GatewayProvider.PAYSTACK:
        try {
          const config = resolvePaystackConfig({
            paystackSecretKey: merchant.paystackSecretKey ?? null,
            paystackTestMode: merchant.paystackTestMode ?? null,
          });
          assertPaystackConfigConsistency(config);

          if (!config.secretKey) {
            issues.push('merchant Paystack credentials are not configured');
          }

          return {
            gateway,
            ready: issues.length === 0,
            issues,
            mode: config.testMode ? 'test' : 'live',
          };
        } catch (error) {
          issues.push(
            error instanceof Error
              ? error.message
              : 'merchant Paystack mode configuration is invalid',
          );

          return {
            gateway,
            ready: false,
            issues,
            mode: null,
          };
        }
      default:
        return null;
    }
  }
}
