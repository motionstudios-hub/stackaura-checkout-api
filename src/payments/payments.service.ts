import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  GatewayProvider,
  IntentStatus,
  LedgerAccount,
  LedgerDirection,
  PaymentStatus,
  Prisma,
  SubscriptionInterval,
  SubscriptionStatus,
} from '@prisma/client';
import {
  GatewayCreatePaymentResult,
  GatewayRedirectForm,
} from '../gateways/gateway.types';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingEngine } from '../routing/routing.engine';
import type { RoutingDecision } from '../routing/routing.engine';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { OzowGateway } from '../gateways/ozow.gateway';
import { PaystackGateway } from '../gateways/paystack.gateway';
import { YocoGateway } from '../gateways/yoco.gateway';
import { MerchantsService } from '../merchants/merchants.service';
import {
  OZOW_CANCEL_URL,
  OZOW_ERROR_URL,
  OZOW_NOTIFY_URL,
  OZOW_SUCCESS_URL,
  resolveOzowConfig,
} from '../gateways/ozow.config';
import { resolvePaystackConfig } from '../gateways/paystack.config';
import {
  mapPaystackEventToPaymentStatus,
  mapPaystackTransactionStatusToPaymentStatus,
} from '../gateways/paystack.lifecycle';
import { resolveYocoConfig } from '../gateways/yoco.config';
import {
  mapYocoCheckoutStatusToPaymentStatus,
  mapYocoEventToPaymentStatus,
} from '../gateways/yoco.lifecycle';
import type { PaystackVerifyStatus } from '../gateways/paystack.gateway';
import { canTransitionPaymentStatus } from './payment-status.transitions';
import * as crypto from 'crypto';
import type { PublicOzowSignupInitiateDto } from './ozow.dto';
import {
  computePlatformFeeBreakdown,
  resolveMerchantPlan,
  type PlatformFeeBreakdown,
  type ResolvedPlatformFeePolicy,
  type RoutingPlanFeatures,
} from './monetization.config';
import { decryptStoredSecret } from '../security/secrets';

export type CreatePaymentDto = {
  amountCents: number;
  currency?: string;
  gateway?: string;
  paymentMethodPreference?: string;
  reference?: string;
  customerEmail?: string;
  description?: string;
  expiresInMinutes?: number;
  itemName?: string;
  returnUrl?: string;
  cancelUrl?: string;
  errorUrl?: string;
  notifyUrl?: string;
  bankReference?: string;
};

export type CreatePaymentIntentDto = {
  amountCents: number;
  currency?: string;
  gateway?: string;
  paymentMethodPreference?: string;
  customerEmail?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
};

export type ListPaymentsQuery = {
  status?: string | string[];
  gateway?: string | string[];
  from?: string | string[];
  to?: string | string[];
  q?: string | string[];
  cursor?: string | string[];
  limit?: string | string[];
};

export type CreateSubscriptionDto = {
  customerEmail: string;
  amountCents: number;
  currency?: string;
  interval: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  startAt?: string;
};

type PublicOzowReturnUrls = {
  success: string;
  cancel: string;
  error: string;
};

type RequestedGateway = GatewayProvider | 'AUTO' | null;

type CheckoutSelectableGateway = 'AUTO' | 'YOCO' | 'OZOW' | 'PAYSTACK';

type MerchantGatewayConfig = {
  id: string;
  payfastMerchantId: string | null;
  payfastMerchantKey: string | null;
  payfastPassphrase: string | null;
  payfastIsSandbox: boolean;
  ozowSiteCode: string | null;
  ozowPrivateKey: string | null;
  ozowApiKey: string | null;
  ozowIsTest: boolean;
  yocoPublicKey: string | null;
  yocoSecretKey: string | null;
  yocoTestMode: boolean;
  paystackSecretKey: string | null;
  paystackTestMode: boolean;
  planCode: string;
  gatewayOrder: Prisma.JsonValue | null;
  platformFeeBps: number;
  platformFeeFixedCents: number;
};

type PaymentForRedirect = {
  id: string;
  reference: string;
  amountCents: number;
  currency: string;
  description: string | null;
  customerEmail: string | null;
};

type PaymentIntentForRedirect = {
  id: string;
  amountCents: number;
  currency: string;
  description: string | null;
  customerEmail: string | null;
};

type AttemptRecord = {
  id: string;
  gateway: GatewayProvider;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  redirectUrl?: string;
};

type IntentAttemptRecord = {
  id: string;
  gateway: GatewayProvider;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type CheckoutRequestContext = {
  itemName?: string;
  returnUrl?: string;
  cancelUrl?: string;
  errorUrl?: string;
  notifyUrl?: string;
  bankReference?: string;
  paymentMethodPreference?: string;
};

type HostedCheckoutGatewayOption = {
  value: CheckoutSelectableGateway;
  label: string;
  description: string;
  detail: string;
  available: boolean;
  selected: boolean;
  recommended: boolean;
  locked: boolean;
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routingEngine: RoutingEngine,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly ozowGateway: OzowGateway,
    private readonly yocoGateway: YocoGateway,
    private readonly paystackGateway: PaystackGateway,
    private readonly merchantsService: MerchantsService,
  ) {}
  private async createGatewayRedirect(args: {
    gateway: GatewayProvider;
    payment: PaymentForRedirect;
    merchant: MerchantGatewayConfig;
    itemName?: string;
    returnUrl?: string;
    cancelUrl?: string;
    errorUrl?: string;
    notifyUrl?: string;
    bankReference?: string;
  }) {
    const adapter = this.gatewayRegistry.get(args.gateway);

    return adapter.createPayment({
      merchantId: args.merchant.id,
      paymentId: args.payment.id,
      reference: args.payment.reference,
      amountCents: args.payment.amountCents,
      currency: args.payment.currency,
      description: args.payment.description,
      customerEmail: args.payment.customerEmail,
      metadata: {
        gateway: args.gateway,
        itemName: args.itemName ?? '',
        returnUrl: args.returnUrl ?? '',
        cancelUrl: args.cancelUrl ?? '',
        errorUrl: args.errorUrl ?? '',
        notifyUrl: args.notifyUrl ?? '',
        bankReference: args.bankReference ?? '',
        customer: args.payment.customerEmail ?? '',
      },
      config: {
        payfastMerchantId: args.merchant.payfastMerchantId,
        payfastMerchantKey: args.merchant.payfastMerchantKey,
        payfastPassphrase: args.merchant.payfastPassphrase,
        payfastIsSandbox: args.merchant.payfastIsSandbox,
        ozowSiteCode: args.merchant.ozowSiteCode,
        ozowPrivateKey: args.merchant.ozowPrivateKey,
        ozowApiKey: args.merchant.ozowApiKey,
        ozowIsTest: args.merchant.ozowIsTest,
        yocoPublicKey: args.merchant.yocoPublicKey,
        yocoSecretKey: args.merchant.yocoSecretKey,
        yocoTestMode: args.merchant.yocoTestMode,
        paystackSecretKey: args.merchant.paystackSecretKey,
        paystackTestMode: args.merchant.paystackTestMode,
      },
    });
  }


  private intentReferenceFromId(intentId: string) {
    return `pi_${intentId.replace(/-/g, '').slice(0, 24)}`;
  }

  private toIntentAttemptSummaries(attempts: IntentAttemptRecord[] | undefined) {
    return (attempts ?? []).map((attempt) => ({
      id: attempt.id,
      gateway: attempt.gateway,
      status: attempt.status,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    }));
  }

  private currentIntentAttemptId(attempts: IntentAttemptRecord[] | undefined) {
    return attempts && attempts.length > 0 ? attempts[0].id : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private parseRedirectForm(value: unknown): GatewayRedirectForm | null {
    const record = this.asRecord(value);
    if (!record) return null;

    const action =
      typeof record.action === 'string' && record.action.trim()
        ? record.action.trim()
        : null;
    const method =
      typeof record.method === 'string' && record.method.trim().toUpperCase() === 'POST'
        ? 'POST'
        : null;
    const fieldsRecord = this.asRecord(record.fields);

    if (!action || !method || !fieldsRecord) {
      return null;
    }

    const fields: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(fieldsRecord)) {
      if (typeof rawValue === 'string') {
        fields[key] = rawValue;
      } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        fields[key] = String(rawValue);
      }
    }

    return {
      action,
      method,
      fields,
    };
  }

  private gatewayRequestSnapshot(
    gateway: GatewayProvider,
    session: GatewayCreatePaymentResult,
  ): Prisma.InputJsonObject {
    return {
      provider: gateway,
      externalReference: session.externalReference ?? null,
      request: {
        redirectUrl: session.redirectUrl,
        redirectForm: session.redirectForm ?? null,
        raw: session.raw ?? null,
        generatedAt: new Date().toISOString(),
      },
    } as Prisma.InputJsonObject;
  }

  private mergeGatewayPayload(
    existing: Prisma.JsonValue | null | undefined,
    patch: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    const existingRecord = this.asRecord(existing);
    return {
      ...(existingRecord ?? {}),
      ...patch,
    } as Prisma.InputJsonObject;
  }

  private trimToNull(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private toStringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  private resolveMerchantFeePolicy(merchant: MerchantGatewayConfig) {
    return resolveMerchantPlan({
      merchantPlanCode: merchant.planCode,
      merchantPlatformFeeBps: merchant.platformFeeBps,
      merchantPlatformFeeFixedCents: merchant.platformFeeFixedCents,
    }).feePolicy;
  }

  private resolveMerchantRoutingPlan(merchant: MerchantGatewayConfig) {
    return resolveMerchantPlan({
      merchantPlanCode: merchant.planCode,
      merchantPlatformFeeBps: merchant.platformFeeBps,
      merchantPlatformFeeFixedCents: merchant.platformFeeFixedCents,
    }).routingFeatures;
  }

  private assertRoutingPlanAllows(args: {
    requestedGateway: RequestedGateway;
    routingPlan: RoutingPlanFeatures;
  }) {
    const wantsExplicit =
      args.requestedGateway !== null && args.requestedGateway !== 'AUTO';
    const wantsAuto =
      args.requestedGateway === null || args.requestedGateway === 'AUTO';

    if (wantsExplicit && !args.routingPlan.manualGatewaySelection) {
      throw new BadRequestException(
        'Manual gateway selection is not enabled for this plan',
      );
    }

    if (wantsAuto && !args.routingPlan.autoRouting) {
      throw new BadRequestException(
        'AUTO routing is not enabled for this plan',
      );
    }
  }

  private parseStoredGatewayProvider(value: unknown): GatewayProvider | null {
    const raw = this.trimToNull(value)?.toUpperCase();
    if (!raw) {
      return null;
    }

    return Object.values(GatewayProvider).includes(raw as GatewayProvider)
      ? (raw as GatewayProvider)
      : null;
  }

  private parseStoredRequestedGateway(value: unknown): RequestedGateway {
    const raw = this.trimToNull(value)?.toUpperCase();
    if (!raw) {
      return null;
    }

    if (raw === 'AUTO') {
      return 'AUTO';
    }

    return Object.values(GatewayProvider).includes(raw as GatewayProvider)
      ? (raw as GatewayProvider)
      : null;
  }

  private parseCheckoutSelectableGateway(
    value: string | null | undefined,
  ): CheckoutSelectableGateway | null {
    const requested = this.parseRequestedGateway(value ?? undefined);
    if (!requested) {
      return null;
    }

    if (
      requested !== 'AUTO' &&
      requested !== GatewayProvider.YOCO &&
      requested !== GatewayProvider.OZOW &&
      requested !== GatewayProvider.PAYSTACK
    ) {
      throw new BadRequestException(
        'gateway must be one of AUTO, YOCO, OZOW, PAYSTACK',
      );
    }

    return requested;
  }

  private coerceCheckoutSelectableGateway(
    value: RequestedGateway,
  ): CheckoutSelectableGateway {
    if (
      value === GatewayProvider.YOCO ||
      value === GatewayProvider.OZOW ||
      value === GatewayProvider.PAYSTACK ||
      value === 'AUTO'
    ) {
      return value;
    }

    return 'AUTO';
  }

  private gatewayDisplayName(
    gateway: CheckoutSelectableGateway | GatewayProvider | null,
  ) {
    if (gateway === 'AUTO') {
      return 'Auto';
    }

    if (gateway === GatewayProvider.YOCO) {
      return 'Yoco';
    }

    if (gateway === GatewayProvider.OZOW) {
      return 'Ozow';
    }

    if (gateway === GatewayProvider.PAYSTACK) {
      return 'Paystack';
    }

    if (gateway === GatewayProvider.PAYFAST) {
      return 'PayFast';
    }

    return 'Stackaura';
  }

  private extractStoredRoutingState(
    rawGateway: Prisma.JsonValue | null | undefined,
  ) {
    const root = this.asRecord(rawGateway);
    const routing = this.asRecord(root?.routing);
    const requestRecord = this.asRecord(root?.request) ?? root;
    const fallbackCount = this.parseNonNegativeInt(routing?.fallbackCount);
    const requestedGateway =
      this.parseStoredRequestedGateway(routing?.requestedGateway) ?? 'AUTO';
    const selectedGateway = this.parseStoredGatewayProvider(
      routing?.selectedGateway,
    );

    return {
      requestedGateway,
      selectedGateway,
      explicitSelection:
        requestedGateway !== null && requestedGateway !== 'AUTO',
      fallbackCount,
      handoffStarted:
        Boolean(
          (typeof requestRecord?.redirectUrl === 'string' &&
            requestRecord.redirectUrl.trim()) ||
            this.parseRedirectForm(
              requestRecord?.redirectForm ?? root?.redirectForm,
            ),
        ),
    };
  }

  private buildRoutingSnapshot(args: {
    decision: RoutingDecision;
    routingPlan?: RoutingPlanFeatures;
    fallbackCount?: number;
    lastFallback?: Record<string, unknown> | null;
    initializationFailures?: Array<Record<string, unknown>>;
  }): Prisma.InputJsonObject {
    const eligibleGateways = args.decision.eligibleGateways.map((candidate) => ({
      gateway: candidate.gateway,
      priority: candidate.priority,
      reason: candidate.reason,
    }));
    const skippedGateways = args.decision.skippedGateways.map((gateway) => ({
      gateway: gateway.gateway,
      issues: gateway.issues,
      mode: gateway.mode,
    }));

    return {
      routing: {
        requestedGateway: args.decision.requestedGateway ?? 'AUTO',
        explicitSelection: args.decision.selectionMode === 'explicit',
        selectionMode: args.decision.selectionMode,
        selectedGateway: args.decision.selectedGateway,
        routingReason: args.decision.routingReason,
        mode: args.decision.mode,
        eligibleGateways,
        rankedGateways: eligibleGateways,
        skippedGateways,
        fallbackCount: args.fallbackCount ?? 0,
        ...(args.routingPlan
          ? {
              featureAccess: {
                planCode: args.routingPlan.planCode,
                manualGatewaySelection:
                  args.routingPlan.manualGatewaySelection,
                autoRouting: args.routingPlan.autoRouting,
                fallback: args.routingPlan.fallback,
                source: args.routingPlan.source,
              },
            }
          : {}),
        ...(args.lastFallback ? { lastFallback: args.lastFallback } : {}),
        ...(args.initializationFailures?.length
          ? { initializationFailures: args.initializationFailures }
          : {}),
      },
    } as Prisma.InputJsonObject;
  }

  private buildMonetizationSnapshot(args: {
    planCode: string;
    feePolicy: ResolvedPlatformFeePolicy;
    feeBreakdown: PlatformFeeBreakdown;
  }): Prisma.InputJsonObject {
    return {
      monetization: {
        planCode: args.planCode,
        platformFeeCents: args.feeBreakdown.platformFeeCents,
        merchantNetCents: args.feeBreakdown.merchantNetCents,
        feePolicy: {
          fixedFeeCents: args.feePolicy.fixedFeeCents,
          percentageBps: args.feePolicy.percentageBps,
          ruleType: args.feePolicy.ruleType,
          source: args.feePolicy.source,
          merchantOverrideApplied: args.feePolicy.merchantOverrideApplied,
        },
      },
    } as Prisma.InputJsonObject;
  }

  private extractStoredRoutingSummary(
    rawGateway: Prisma.JsonValue | null | undefined,
    fallbackGateway?: GatewayProvider | null,
  ) {
    const root = this.asRecord(rawGateway);
    const routing = this.asRecord(root?.routing);
    const featureAccess = this.asRecord(routing?.featureAccess);

    return {
      routingMode: this.trimToNull(routing?.mode),
      routingSelectionMode: this.trimToNull(routing?.selectionMode),
      requestedGateway: this.parseStoredRequestedGateway(
        routing?.requestedGateway,
      ),
      selectedGateway:
        this.parseStoredGatewayProvider(routing?.selectedGateway) ??
        fallbackGateway ??
        null,
      routingReason: this.toStringArray(routing?.routingReason),
      fallbackCount: this.parseNonNegativeInt(routing?.fallbackCount),
      routingPlanCode: this.trimToNull(featureAccess?.planCode),
    };
  }

  private extractStoredMonetizationSummary(
    rawGateway: Prisma.JsonValue | null | undefined,
  ) {
    const root = this.asRecord(rawGateway);
    const monetization = this.asRecord(root?.monetization);
    const feePolicy = this.asRecord(monetization?.feePolicy);

    return {
      merchantPlanCode: this.trimToNull(monetization?.planCode),
      platformFeeRuleType: this.trimToNull(feePolicy?.ruleType),
      platformFeeSource: this.trimToNull(feePolicy?.source),
    };
  }

  private buildCheckoutRequestSnapshot(
    args: CheckoutRequestContext,
  ): Prisma.InputJsonObject {
    const checkout = Object.entries({
      itemName: this.trimToNull(args.itemName),
      returnUrl: this.trimToNull(args.returnUrl),
      cancelUrl: this.trimToNull(args.cancelUrl),
      errorUrl: this.trimToNull(args.errorUrl),
      notifyUrl: this.trimToNull(args.notifyUrl),
      bankReference: this.trimToNull(args.bankReference),
      paymentMethodPreference: this.trimToNull(args.paymentMethodPreference),
    }).reduce<Record<string, string>>((acc, [key, value]) => {
      if (value) {
        acc[key] = value;
      }
      return acc;
    }, {});

    return Object.keys(checkout).length
      ? ({ checkout } as Prisma.InputJsonObject)
      : ({} as Prisma.InputJsonObject);
  }

  private extractCheckoutRequestContext(
    rawGateway: Prisma.JsonValue | null | undefined,
  ): CheckoutRequestContext {
    const root = this.asRecord(rawGateway);
    const checkout = this.asRecord(root?.checkout);

    return {
      itemName: this.trimToNull(checkout?.itemName) ?? undefined,
      returnUrl: this.trimToNull(checkout?.returnUrl) ?? undefined,
      cancelUrl: this.trimToNull(checkout?.cancelUrl) ?? undefined,
      errorUrl: this.trimToNull(checkout?.errorUrl) ?? undefined,
      notifyUrl: this.trimToNull(checkout?.notifyUrl) ?? undefined,
      bankReference: this.trimToNull(checkout?.bankReference) ?? undefined,
      paymentMethodPreference:
        this.trimToNull(checkout?.paymentMethodPreference) ?? undefined,
    };
  }

  private resolveStoredFeePolicy(args: {
    rawGateway: Prisma.JsonValue | null | undefined;
    merchant: MerchantGatewayConfig;
  }) {
    const root = this.asRecord(args.rawGateway);
    const monetization = this.asRecord(root?.monetization);
    const feePolicy = this.asRecord(monetization?.feePolicy);
    const fixedFeeCents = Number(feePolicy?.fixedFeeCents);
    const percentageBps = Number(feePolicy?.percentageBps);
    const ruleType = this.trimToNull(feePolicy?.ruleType);
    const source = this.trimToNull(feePolicy?.source);
    const merchantOverrideApplied =
      typeof feePolicy?.merchantOverrideApplied === 'boolean'
        ? feePolicy.merchantOverrideApplied
        : null;

    if (
      Number.isFinite(fixedFeeCents) &&
      Number.isFinite(percentageBps) &&
      ruleType &&
      source
    ) {
      return {
        fixedFeeCents: Math.max(0, Math.trunc(fixedFeeCents)),
        percentageBps: Math.max(0, Math.trunc(percentageBps)),
        ruleType: ruleType as ResolvedPlatformFeePolicy['ruleType'],
        source: source as ResolvedPlatformFeePolicy['source'],
        merchantOverrideApplied: merchantOverrideApplied ?? false,
      } satisfies ResolvedPlatformFeePolicy;
    }

    return this.resolveMerchantFeePolicy(args.merchant);
  }

  private parseNonNegativeInt(value: unknown) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return 0;
    }

    return Math.trunc(num);
  }

  private extractRedirectState(
    rawGateway: Prisma.JsonValue | null | undefined,
    fallbackRedirectUrl?: string | null,
  ) {
    const root = this.asRecord(rawGateway);
    const requestRecord = this.asRecord(root?.request) ?? root;
    const redirectForm = this.parseRedirectForm(
      requestRecord?.redirectForm ?? root?.redirectForm,
    );
    const redirectUrl =
      (typeof requestRecord?.redirectUrl === 'string' &&
        requestRecord.redirectUrl.trim()) ||
      redirectForm?.action ||
      fallbackRedirectUrl ||
      null;

    return {
      redirectUrl,
      redirectForm,
      redirectMethod: redirectForm?.method ?? null,
    };
  }

  private extractOzowProviderReference(
    rawGateway: Prisma.JsonValue | null | undefined,
  ) {
    const root = this.asRecord(rawGateway);
    const requestRecord = this.asRecord(root?.request);
    const requestRaw = this.asRecord(requestRecord?.raw);
    const ozowRecord = this.asRecord(root?.ozow);

    return (
      this.trimToNull(requestRaw?.transactionReference) ??
      this.trimToNull(ozowRecord?.transactionReference) ??
      this.trimToNull(root?.externalReference) ??
      null
    );
  }

  private extractYocoState(rawGateway: Prisma.JsonValue | null | undefined) {
    const root = this.asRecord(rawGateway);
    const requestRecord = this.asRecord(root?.request);
    const requestRaw = this.asRecord(requestRecord?.raw);
    const yocoRecord = this.asRecord(root?.yoco);
    const eventRecord = this.asRecord(yocoRecord?.rawEvent);

    const checkoutId =
      (typeof yocoRecord?.checkoutId === 'string' && yocoRecord.checkoutId.trim()) ||
      (typeof requestRaw?.id === 'string' && requestRaw.id.trim()) ||
      (typeof root?.externalReference === 'string' && root.externalReference.trim()) ||
      null;
    const checkoutStatus =
      (typeof yocoRecord?.checkoutStatus === 'string' &&
        yocoRecord.checkoutStatus.trim()) ||
      (typeof requestRaw?.status === 'string' && requestRaw.status.trim()) ||
      null;
    const paymentId =
      (typeof yocoRecord?.paymentId === 'string' && yocoRecord.paymentId.trim()) ||
      (typeof requestRaw?.paymentId === 'string' && requestRaw.paymentId.trim()) ||
      null;
    const eventType =
      typeof yocoRecord?.eventType === 'string' && yocoRecord.eventType.trim()
        ? yocoRecord.eventType.trim()
        : null;
    const paymentStatus =
      typeof yocoRecord?.paymentStatus === 'string' &&
      yocoRecord.paymentStatus.trim()
        ? yocoRecord.paymentStatus.trim()
        : null;
    const processingMode =
      (typeof yocoRecord?.processingMode === 'string' &&
        yocoRecord.processingMode.trim()) ||
      (typeof requestRaw?.processingMode === 'string' &&
        requestRaw.processingMode.trim()) ||
      null;
    const failureReason =
      typeof yocoRecord?.failureReason === 'string' &&
      yocoRecord.failureReason.trim()
        ? yocoRecord.failureReason.trim()
        : null;

    return {
      checkoutId,
      checkoutStatus,
      paymentId,
      eventType,
      paymentStatus,
      processingMode,
      failureReason,
      raw: eventRecord ?? requestRaw ?? root,
    };
  }

  private extractPaystackState(rawGateway: Prisma.JsonValue | null | undefined) {
    const root = this.asRecord(rawGateway);
    const requestRecord = this.asRecord(root?.request);
    const requestRaw = this.asRecord(requestRecord?.raw);
    const paystackRecord = this.asRecord(root?.paystack);
    const eventRecord = this.asRecord(paystackRecord?.rawEvent);

    const accessCode =
      this.trimToNull(paystackRecord?.accessCode) ??
      this.trimToNull(requestRaw?.accessCode) ??
      this.trimToNull(root?.externalReference) ??
      null;
    const reference =
      this.trimToNull(paystackRecord?.reference) ??
      this.trimToNull(requestRaw?.reference) ??
      null;
    const providerStatus =
      this.trimToNull(paystackRecord?.providerStatus) ??
      this.trimToNull(paystackRecord?.transactionStatus) ??
      this.trimToNull(requestRaw?.status) ??
      null;
    const eventType = this.trimToNull(paystackRecord?.eventType) ?? null;
    const paidAt = this.trimToNull(paystackRecord?.paidAt) ?? null;
    const channel = this.trimToNull(paystackRecord?.channel) ?? null;
    const customerEmail = this.trimToNull(paystackRecord?.customerEmail) ?? null;
    const gatewayResponse =
      this.trimToNull(paystackRecord?.gatewayResponse) ?? null;

    return {
      accessCode,
      reference,
      providerStatus,
      eventType,
      paidAt,
      channel,
      customerEmail,
      gatewayResponse,
      raw: eventRecord ?? paystackRecord ?? requestRaw ?? root,
    };
  }

  private async getMerchantGatewayConfig(merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        payfastMerchantId: true,
        payfastMerchantKey: true,
        payfastPassphrase: true,
        payfastIsSandbox: true,
        ozowSiteCode: true,
        ozowPrivateKey: true,
        ozowApiKey: true,
        ozowIsTest: true,
        yocoPublicKey: true,
        yocoSecretKey: true,
        yocoTestMode: true,
        paystackSecretKey: true,
        paystackTestMode: true,
        planCode: true,
        gatewayOrder: true,
        platformFeeBps: true,
        platformFeeFixedCents: true,
      },
    });

    if (!merchant) throw new NotFoundException('Merchant not found');

    const payfastMerchantKey = decryptStoredSecret(merchant.payfastMerchantKey);
    const payfastPassphrase = decryptStoredSecret(merchant.payfastPassphrase);
    const ozowPrivateKey = decryptStoredSecret(merchant.ozowPrivateKey);
    const ozowApiKey = decryptStoredSecret(merchant.ozowApiKey);
    const yocoSecretKey = decryptStoredSecret(merchant.yocoSecretKey);
    const paystackSecretKey = decryptStoredSecret(merchant.paystackSecretKey);

    const ozowConfig = resolveOzowConfig({
      ozowSiteCode: merchant.ozowSiteCode,
      ozowPrivateKey,
      ozowApiKey,
      ozowIsTest: merchant.ozowIsTest,
    });
    const yocoConfig = resolveYocoConfig({
      yocoPublicKey: merchant.yocoPublicKey,
      yocoSecretKey,
      yocoTestMode: merchant.yocoTestMode,
    });
    const paystackConfig = resolvePaystackConfig({
      paystackSecretKey,
      paystackTestMode: merchant.paystackTestMode,
    });

    return {
      ...merchant,
      payfastMerchantKey,
      payfastPassphrase,
      ozowSiteCode: ozowConfig.siteCode,
      ozowPrivateKey: ozowConfig.privateKey,
      ozowApiKey: ozowConfig.apiKey,
      ozowIsTest: ozowConfig.isTest,
      yocoPublicKey: yocoConfig.publicKey,
      yocoSecretKey: yocoConfig.secretKey,
      yocoTestMode: yocoConfig.testMode,
      paystackSecretKey: paystackConfig.secretKey,
      paystackTestMode: paystackConfig.testMode,
      planCode:
        typeof merchant.planCode === 'string' && merchant.planCode.trim()
          ? merchant.planCode.trim().toLowerCase()
          : 'growth',
    };
  }

  private async getPaymentIntentResponseById(
    merchantId: string,
    intentId: string,
  ) {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: {
        id: intentId,
        merchantId,
      },
      select: {
        id: true,
        merchantId: true,
        amountCents: true,
        currency: true,
        status: true,
        customerEmail: true,
        description: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            gateway: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            gatewayRef: true,
            rawGateway: true,
          },
        },
      },
    });

    if (!intent) throw new NotFoundException('Payment intent not found');

    const latestAttempt = intent.attempts[0];
    const redirectState = this.extractRedirectState(
      latestAttempt?.rawGateway ?? null,
    );

    return {
      id: intent.id,
      merchantId: intent.merchantId,
      amountCents: intent.amountCents,
      currency: intent.currency,
      status: intent.status,
      customerEmail: intent.customerEmail,
      description: intent.description,
      metadata: intent.metadata,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      gateway: latestAttempt?.gateway ?? null,
      gatewayRef: latestAttempt?.gatewayRef ?? null,
      redirectUrl: redirectState.redirectUrl,
      redirectForm: redirectState.redirectForm,
      redirectMethod: redirectState.redirectMethod,
      attempts: this.toIntentAttemptSummaries(intent.attempts),
      currentAttemptId: this.currentIntentAttemptId(intent.attempts),
    };
  }

  private async getPaymentResponseById(merchantId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, merchantId },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        currency: true,
        amountCents: true,
        platformFeeCents: true,
        merchantNetCents: true,
        status: true,
        gateway: true,
        checkoutToken: true,
        expiresAt: true,
        customerEmail: true,
        description: true,
        gatewayRef: true,
        rawGateway: true,
        createdAt: true,
        updatedAt: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            gateway: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            redirectUrl: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');

    const latestAttempt = payment.attempts[0];
    const redirectState = this.extractRedirectState(
      payment.rawGateway,
      latestAttempt?.redirectUrl ?? null,
    );
    const routingSummary = this.extractStoredRoutingSummary(
      payment.rawGateway,
      payment.gateway,
    );
    const monetizationSummary = this.extractStoredMonetizationSummary(
      payment.rawGateway,
    );

    return {
      id: payment.id,
      merchantId: payment.merchantId,
      reference: payment.reference,
      currency: payment.currency,
      amountCents: payment.amountCents,
      platformFeeCents: payment.platformFeeCents,
      merchantNetCents: payment.merchantNetCents,
      status: payment.status,
      gateway: payment.gateway,
      checkoutToken: payment.checkoutToken,
      expiresAt: payment.expiresAt,
      customerEmail: payment.customerEmail,
      description: payment.description,
      gatewayRef: payment.gatewayRef,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      checkoutUrl: `${this.appUrl()}/v1/checkout/${payment.checkoutToken}`,
      redirectUrl: redirectState.redirectUrl,
      redirectForm: redirectState.redirectForm,
      redirectMethod: redirectState.redirectMethod,
      routingMode: routingSummary.routingMode,
      routingSelectionMode: routingSummary.routingSelectionMode,
      requestedGateway: routingSummary.requestedGateway,
      selectedGateway: routingSummary.selectedGateway,
      routingReason: routingSummary.routingReason,
      fallbackCount: routingSummary.fallbackCount,
      routingPlanCode: routingSummary.routingPlanCode,
      merchantPlanCode: monetizationSummary.merchantPlanCode,
      platformFeeRuleType: monetizationSummary.platformFeeRuleType,
      platformFeeSource: monetizationSummary.platformFeeSource,
      attempts: this.toAttemptSummaries(payment.attempts, true),
      currentAttemptId: this.currentAttemptId(payment.attempts),
    };
  }

  private readonly listSelect = {
    id: true,
    reference: true,
    status: true,
    gateway: true,
    amountCents: true,
    platformFeeCents: true,
    merchantNetCents: true,
    currency: true,
    customerEmail: true,
    description: true,
    createdAt: true,
    updatedAt: true,
    gatewayRef: true,
    rawGateway: true,
    expiresAt: true,
    checkoutToken: true,
    attempts: {
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        gateway: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    },
  } as const;

  private randomToken(bytes = 24) {
    // URL-safe token (base64url)
    return crypto.randomBytes(bytes).toString('base64url');
  }

  private randomReference() {
    return `INV-${crypto.randomBytes(6).toString('hex')}`;
  }
    private normalizeIdempotencyKey(value: string | undefined) {
    const key = value?.trim();
    return key ? key.slice(0, 255) : null;
  }

  private createIdempotencyRequestHash(scope: string, payload: unknown) {
    return crypto
      .createHash('sha256')
      .update(`${scope}:${JSON.stringify(payload)}`)
      .digest('hex');
  }
  private appUrl() {
    return (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  }

  private normalizeEmail(value: string) {
    return value.trim().toLowerCase();
  }

  private normalizeComparableText(value: string | null | undefined) {
    return (value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private publicOzowSignupAmountCents() {
    const configured = process.env.PUBLIC_OZOW_SIGNUP_AMOUNT_CENTS?.trim();
    if (!configured) {
      return 9900;
    }

    return this.parsePositiveInt(
      configured,
      'PUBLIC_OZOW_SIGNUP_AMOUNT_CENTS',
    );
  }

  private buildPublicOzowSignupReference(merchantId: string) {
    return `SIGNUP-${merchantId.replace(/-/g, '').slice(0, 24).toUpperCase()}`;
  }

  private allowListedReturnUrl(
    candidate: string | null | undefined,
    fallback: string,
  ) {
    const value =
      typeof candidate === 'string' && candidate.trim()
        ? candidate.trim()
        : null;

    return value === fallback ? value : fallback;
  }

  private resolvePublicOzowReturnUrls(
    returnUrls?: PublicOzowSignupInitiateDto['returnUrls'],
  ): PublicOzowReturnUrls {
    return {
      success: this.allowListedReturnUrl(returnUrls?.success, OZOW_SUCCESS_URL),
      cancel: this.allowListedReturnUrl(returnUrls?.cancel, OZOW_CANCEL_URL),
      error: this.allowListedReturnUrl(returnUrls?.error, OZOW_ERROR_URL),
    };
  }

  private buildPublicOzowFlowMetadata(args: {
    merchantId: string;
    signup: PublicOzowSignupInitiateDto['signup'];
    returnUrls: PublicOzowReturnUrls;
  }) {
    return {
      publicFlow: {
        flow: 'merchant_signup',
        merchantId: args.merchantId,
        signup: {
          businessName: args.signup.businessName.trim(),
          email: this.normalizeEmail(args.signup.email),
          country: args.signup.country?.trim() ?? null,
        },
        returnUrls: args.returnUrls,
        fulfillment: {
          status: 'PENDING',
        },
      },
    };
  }

  private isPublicOzowSignupPayment(rawGateway: Prisma.JsonValue | null | undefined) {
    const root = this.asRecord(rawGateway);
    const publicFlow = this.asRecord(root?.publicFlow);
    return publicFlow?.flow === 'merchant_signup';
  }

  private publicOzowSignupFlow(rawGateway: Prisma.JsonValue | null | undefined) {
    const root = this.asRecord(rawGateway);
    const publicFlow = this.asRecord(root?.publicFlow);
    if (publicFlow?.flow !== 'merchant_signup') {
      return null;
    }

    return publicFlow;
  }

  private async resolvePublicOzowSignupMerchant(
    signup: PublicOzowSignupInitiateDto['signup'],
  ) {
    const email = this.normalizeEmail(signup.email);
    const businessName = signup.businessName.trim();

    const existing = await this.prisma.merchant.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    if (!existing) {
      const created = await this.merchantsService.createPendingMerchantSignup({
        businessName,
        email,
        password: signup.password,
        country: signup.country?.trim(),
      });

      return created.merchant;
    }

    if (
      this.normalizeComparableText(existing.name) !==
      this.normalizeComparableText(businessName)
    ) {
      throw new ConflictException('Merchant with this email already exists');
    }

    return existing;
  }


  private parseRequestedGateway(value: string | undefined): RequestedGateway {
    const raw = value?.trim().toUpperCase();
    if (!raw) return null;
    if (raw === 'AUTO') return 'AUTO';

    if (!Object.values(GatewayProvider).includes(raw as GatewayProvider)) {
      throw new BadRequestException(
        `gateway must be one of AUTO, ${Object.values(GatewayProvider).join(', ')}`,
      );
    }

    return raw as GatewayProvider;
  }

  private parsePositiveInt(value: unknown, fieldName: string) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
      throw new BadRequestException(`${fieldName} must be a positive integer`);
    }
    return num;
  }

  private parseSubscriptionInterval(value: string | undefined) {
    const raw = value?.trim().toUpperCase();
    if (!raw) {
      throw new BadRequestException('interval is required');
    }

    if (!Object.values(SubscriptionInterval).includes(raw as SubscriptionInterval)) {
      throw new BadRequestException('interval must be one of DAY, WEEK, MONTH, YEAR');
    }

    return raw as SubscriptionInterval;
  }


  private resolveGatewayForCreate(
    requestedGateway: RequestedGateway,
    merchant: MerchantGatewayConfig,
    amountCents: number,
    currency: string,
    customerEmail?: string | null,
    paymentMethodPreference?: string | null,
  ) {
    return this.routingEngine.decide({
      requestedGateway,
      merchant,
      mode: 'STRICT_PRIORITY',
      amountCents,
      currency,
      customerEmail,
      paymentMethodPreference,
    });
  }

  private resolveNextFailoverDecision(args: {
    paymentGateway: GatewayProvider | null;
    attempts: Array<{ gateway: GatewayProvider }>;
    merchant: MerchantGatewayConfig;
    amountCents: number;
    currency: string;
    customerEmail?: string | null;
    paymentMethodPreference?: string | null;
  }) {
    const attempted = new Set<GatewayProvider>();
    for (const attempt of args.attempts) {
      attempted.add(attempt.gateway);
    }
    if (args.paymentGateway) {
      attempted.add(args.paymentGateway);
    }

    const decision = this.routingEngine.decide({
      requestedGateway: 'AUTO',
      merchant: args.merchant,
      excludedGateways: Array.from(attempted),
      mode: 'FAILOVER_PRIORITY',
      amountCents: args.amountCents,
      currency: args.currency,
      customerEmail: args.customerEmail,
      paymentMethodPreference: args.paymentMethodPreference,
    });

    return decision;
  }

  private buildInitializationFailureRecord(args: {
    gateway: GatewayProvider;
    error: unknown;
    fallbackTo?: GatewayProvider | null;
  }) {
    return {
      gateway: args.gateway,
      stage: 'initialization',
      failedAt: new Date().toISOString(),
      errorMessage:
        args.error instanceof Error
          ? args.error.message
          : 'Gateway initialization failed',
      errorName:
        args.error instanceof Error ? args.error.name : 'GatewayInitializationError',
      fallbackTo: args.fallbackTo ?? null,
    };
  }

  private appendInitializationFailure(
    existing: unknown,
    failure: Record<string, unknown>,
  ) {
    const root = this.asRecord(existing);
    const routing = this.asRecord(root?.routing);
    const failures = Array.isArray(routing?.initializationFailures)
      ? [...routing.initializationFailures]
      : [];
    failures.push(failure as Prisma.InputJsonValue);
    return failures as Array<Record<string, unknown>>;
  }

  private extractStoredInitializationFailures(
    rawGateway: Prisma.JsonValue | null | undefined,
  ) {
    const root = this.asRecord(rawGateway);
    const routing = this.asRecord(root?.routing);
    return Array.isArray(routing?.initializationFailures)
      ? (routing.initializationFailures as Array<Record<string, unknown>>)
      : [];
  }

  private hasProviderCheckoutStarted(args: {
    rawGateway: Prisma.JsonValue | null | undefined;
    latestAttemptRedirectUrl?: string | null;
  }) {
    const redirectState = this.extractRedirectState(
      args.rawGateway,
      args.latestAttemptRedirectUrl ?? null,
    );

    return Boolean(redirectState.redirectUrl || redirectState.redirectForm);
  }

  private async initializePaymentGatewayWithFallback(args: {
    payment: PaymentForRedirect & {
      status: PaymentStatus;
      rawGateway: Prisma.JsonValue | null | undefined;
      checkoutToken: string;
    };
    merchant: MerchantGatewayConfig;
    checkoutRequest: CheckoutRequestContext;
    routingDecision: RoutingDecision;
    routingPlan: RoutingPlanFeatures;
    monetizationSnapshot: Prisma.InputJsonObject;
  }) {
    const existingRoutingState = this.extractStoredRoutingState(args.payment.rawGateway);
    let fallbackCount = existingRoutingState.fallbackCount;
    let initializationFailures = this.extractStoredInitializationFailures(
      args.payment.rawGateway,
    );

    let lastError: unknown = null;

    for (const [index, candidate] of args.routingDecision.eligibleGateways.entries()) {
      try {
        const gatewaySession = await this.createGatewayRedirect({
          gateway: candidate.gateway,
          payment: args.payment,
          merchant: args.merchant,
          ...args.checkoutRequest,
        });
        const externalReference = gatewaySession.externalReference ?? null;
        const decision: RoutingDecision = {
          ...args.routingDecision,
          selectedGateway: candidate.gateway,
          routingReason: candidate.reason,
        };
        const lastFallback =
          fallbackCount > 0
            ? this.asRecord(
                initializationFailures[initializationFailures.length - 1],
              )
            : null;

        await this.prisma.$transaction(async (tx) => {
          const openAttemptResult = await tx.paymentAttempt.updateMany({
            where: {
              paymentId: args.payment.id,
              status: { in: ['CREATED', 'PENDING'] },
            },
            data: {
              status: 'CANCELLED',
            },
          });

          if (openAttemptResult.count > 0) {
            this.logger.log(
              JSON.stringify({
                event: 'payment.attempts.superseded',
                paymentId: args.payment.id,
                nextGateway: candidate.gateway,
                cancelledAttempts: openAttemptResult.count,
              }),
            );
          }

          const createdAttempt = await tx.paymentAttempt.create({
            data: {
              paymentId: args.payment.id,
              gateway: candidate.gateway,
              status: 'CREATED',
              redirectUrl: gatewaySession.redirectUrl,
            },
            select: { id: true },
          });

          await tx.payment.update({
            where: { id: args.payment.id },
            data: {
              gateway: candidate.gateway,
              gatewayRef: externalReference,
              status:
                args.payment.status === PaymentStatus.CREATED
                  ? PaymentStatus.CREATED
                  : PaymentStatus.PENDING,
              rawGateway: this.mergeGatewayPayload(args.payment.rawGateway, {
                ...this.gatewayRequestSnapshot(candidate.gateway, gatewaySession),
                ...this.buildRoutingSnapshot({
                  decision,
                  routingPlan: args.routingPlan,
                  fallbackCount,
                  lastFallback,
                  initializationFailures,
                }),
                ...args.monetizationSnapshot,
                ...this.buildCheckoutRequestSnapshot(args.checkoutRequest),
              }),
            },
            select: { id: true },
          });

          return createdAttempt;
        });

        return {
          gateway: candidate.gateway,
          session: gatewaySession,
          gatewayRef: externalReference,
          routingDecision: decision,
          fallbackCount,
          initializationFailures,
        };
      } catch (error) {
        lastError = error;
        const nextCandidate =
          args.routingDecision.eligibleGateways[index + 1]?.gateway ?? null;
        const nextFallbackCount = nextCandidate ? fallbackCount + 1 : fallbackCount;
        const failureRecord = this.buildInitializationFailureRecord({
          gateway: candidate.gateway,
          error,
          fallbackTo: nextCandidate,
        });
        initializationFailures = this.appendInitializationFailure(
          { routing: { initializationFailures } },
          failureRecord,
        );

        await this.prisma.$transaction(async (tx) => {
          await tx.paymentAttempt.create({
            data: {
              paymentId: args.payment.id,
              gateway: candidate.gateway,
              status: 'FAILED',
              redirectUrl: '',
            },
            select: { id: true },
          });

          await tx.payment.update({
            where: { id: args.payment.id },
            data: {
              rawGateway: this.mergeGatewayPayload(args.payment.rawGateway, {
                ...this.buildRoutingSnapshot({
                  decision: {
                    ...args.routingDecision,
                    selectedGateway: candidate.gateway,
                    routingReason: candidate.reason,
                  },
                  routingPlan: args.routingPlan,
                  fallbackCount: nextFallbackCount,
                  lastFallback: failureRecord,
                  initializationFailures,
                }),
                ...args.monetizationSnapshot,
                ...this.buildCheckoutRequestSnapshot(args.checkoutRequest),
              }),
            },
            select: { id: true },
          });
        });

        if (
          args.routingDecision.selectionMode !== 'auto' ||
          !nextCandidate ||
          !args.routingPlan.fallback
        ) {
          throw error;
        }

        fallbackCount = nextFallbackCount;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BadRequestException('No gateway available for initialization');
  }


  private mapPaymentStatusToAttemptStatus(status: PaymentStatus) {
    if (status === PaymentStatus.PAID) return 'SUCCEEDED';
    if (status === PaymentStatus.FAILED) return 'FAILED';
    if (status === PaymentStatus.CANCELLED) return 'CANCELLED';
    if (status === PaymentStatus.PENDING) return 'PENDING';
    return null;
  }

  private async cancelSupersededOpenAttempts(args: {
    tx: Prisma.TransactionClient;
    paymentId: string;
    nextGateway: GatewayProvider;
  }) {
    const result = await args.tx.paymentAttempt.updateMany({
      where: {
        paymentId: args.paymentId,
        gateway: { not: args.nextGateway },
        status: { in: ['CREATED', 'PENDING'] },
      },
      data: {
        status: 'CANCELLED',
      },
    });

    if (result.count > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'payment.attempts.superseded',
          paymentId: args.paymentId,
          nextGateway: args.nextGateway,
          cancelledAttempts: result.count,
        }),
      );
    }
  }

  private mapGatewayLookupStatus(
    status: 'pending' | 'succeeded' | 'failed',
  ): PaymentStatus {
    if (status === 'succeeded') return PaymentStatus.PAID;
    if (status === 'failed') return PaymentStatus.FAILED;
    return PaymentStatus.PENDING;
  }

  private async computeLedgerBalanceAfter(args: {
    tx: Prisma.TransactionClient;
    merchantId: string;
    account: LedgerAccount;
    direction: LedgerDirection;
    amountCents: number;
  }) {
    const existing = await args.tx.ledgerEntry.findMany({
      where: {
        merchantId: args.merchantId,
        account: args.account,
      },
      select: {
        amountCents: true,
        direction: true,
      },
    });

    const currentBalance = existing.reduce((sum, entry) => {
      return (
        sum +
        (entry.direction === LedgerDirection.CREDIT
          ? entry.amountCents
          : -entry.amountCents)
      );
    }, 0);

    return (
      currentBalance +
      (args.direction === LedgerDirection.CREDIT
        ? args.amountCents
        : -args.amountCents)
    );
  }

  private async createLedgerEntry(args: {
    tx: Prisma.TransactionClient;
    merchantId: string;
    paymentIntentId?: string | null;
    paymentId?: string | null;
    payoutId?: string | null;
    account: LedgerAccount;
    direction: LedgerDirection;
    amountCents: number;
    currency: string;
    description?: string | null;
  }) {
    const balanceAfter = await this.computeLedgerBalanceAfter({
      tx: args.tx,
      merchantId: args.merchantId,
      account: args.account,
      direction: args.direction,
      amountCents: args.amountCents,
    });

    return args.tx.ledgerEntry.create({
      data: {
        merchantId: args.merchantId,
        paymentIntentId: args.paymentIntentId ?? undefined,
        paymentId: args.paymentId ?? undefined,
        payoutId: args.payoutId ?? undefined,
        account: args.account,
        direction: args.direction,
        amountCents: args.amountCents,
        currency: args.currency,
        balanceAfter,
        description: args.description ?? undefined,
      },
    });
  }

  async writeSuccessfulPaymentLedger(args: {
    merchantId: string;
    amountCents: number;
    currency: string;
    platformFeeCents: number;
    merchantNetCents: number;
    paymentIntentId?: string | null;
    paymentId?: string | null;
    description?: string | null;
  }) {
    if (args.amountCents <= 0) {
      throw new BadRequestException('amountCents must be positive');
    }

    if (args.platformFeeCents < 0 || args.merchantNetCents < 0) {
      throw new BadRequestException('Ledger amounts cannot be negative');
    }

    if (args.platformFeeCents + args.merchantNetCents !== args.amountCents) {
      throw new BadRequestException(
        'Ledger amounts must balance to total payment amount',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const entries = [] as Array<
        Awaited<ReturnType<typeof tx.ledgerEntry.create>>
      >;

      entries.push(
        await this.createLedgerEntry({
          tx,
          merchantId: args.merchantId,
          paymentIntentId: args.paymentIntentId,
          paymentId: args.paymentId,
          account: LedgerAccount.CUSTOMER_FUNDS,
          direction: LedgerDirection.DEBIT,
          amountCents: args.amountCents,
          currency: args.currency,
          description: args.description ?? 'Customer payment received',
        }),
      );

      entries.push(
        await this.createLedgerEntry({
          tx,
          merchantId: args.merchantId,
          paymentIntentId: args.paymentIntentId,
          paymentId: args.paymentId,
          account: LedgerAccount.MERCHANT_BALANCE,
          direction: LedgerDirection.CREDIT,
          amountCents: args.merchantNetCents,
          currency: args.currency,
          description: 'Merchant balance credited',
        }),
      );

      if (args.platformFeeCents > 0) {
        entries.push(
          await this.createLedgerEntry({
            tx,
            merchantId: args.merchantId,
            paymentIntentId: args.paymentIntentId,
            paymentId: args.paymentId,
            account: LedgerAccount.PLATFORM_FEES,
            direction: LedgerDirection.CREDIT,
            amountCents: args.platformFeeCents,
            currency: args.currency,
            description: 'Stackaura platform fee',
          }),
        );
      }

      return entries;
    });
  }

    async recordSuccessfulPaymentLedgerByPaymentId(paymentIdPlain: string) {
    const paymentId = paymentIdPlain?.trim();
    if (!paymentId) {
      throw new BadRequestException('paymentId is required');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        merchantId: true,
        amountCents: true,
        currency: true,
        platformFeeCents: true,
        merchantNetCents: true,
        status: true,
        description: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status !== PaymentStatus.PAID) {
      throw new BadRequestException('Ledger can only be recorded for paid payments');
    }

    const existingLedger = await this.prisma.ledgerEntry.findFirst({
      where: {
        paymentId: payment.id,
      },
      select: { id: true },
    });

    if (existingLedger) {
      return this.prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
        orderBy: { createdAt: 'asc' },
      });
    }

    return this.writeSuccessfulPaymentLedger({
      merchantId: payment.merchantId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      platformFeeCents: payment.platformFeeCents,
      merchantNetCents: payment.merchantNetCents,
      paymentId: payment.id,
      description: payment.description ?? 'Customer payment received',
    });
  }

  private toAttemptSummaries(
    attempts: AttemptRecord[] | undefined,
    includeRedirectUrl: boolean,
  ) {
    return (attempts ?? []).map((attempt) => ({
      id: attempt.id,
      gateway: attempt.gateway,
      status: attempt.status,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      ...(includeRedirectUrl
        ? { redirectUrl: attempt.redirectUrl ?? null }
        : {}),
    }));
  }

  private currentAttemptId(attempts: AttemptRecord[] | undefined) {
    return attempts && attempts.length > 0 ? attempts[0].id : null;
  }

  async createPaymentIntent(
  merchantIdPlain: string,
  data: CreatePaymentIntentDto,
  _idempotencyKey?: string,
) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const normalizedIdempotencyKey = this.normalizeIdempotencyKey(
      _idempotencyKey,
    );
    const idempotencyScope = 'payment_intents.create';
    const idempotencyRequestHash = normalizedIdempotencyKey
      ? this.createIdempotencyRequestHash(idempotencyScope, data)
      : null;

    if (normalizedIdempotencyKey && idempotencyRequestHash) {
      const existingKey = await this.prisma.idempotencyKey.findUnique({
        where: {
          merchantId_scope_idempotencyKey: {
            merchantId,
            scope: idempotencyScope,
            idempotencyKey: normalizedIdempotencyKey,
          },
        },
      });

      if (existingKey) {
        if (existingKey.requestHash !== idempotencyRequestHash) {
          throw new ConflictException(
            'Idempotency-Key has already been used with a different request body',
          );
        }

        if (existingKey.paymentIntentId) {
          return this.getPaymentIntentResponseById(
            merchantId,
            existingKey.paymentIntentId,
          );
        }
      }
    }

    const amountCents = this.parsePositiveInt(data?.amountCents, 'amountCents');
    const currency =
      typeof data?.currency === 'string' && data.currency.trim()
        ? data.currency.trim().toUpperCase()
        : 'ZAR';
    const merchant = await this.getMerchantGatewayConfig(merchantId);
    const requestedGateway = this.parseRequestedGateway(data?.gateway);
    const routingPlan = this.resolveMerchantRoutingPlan(merchant);
    this.assertRoutingPlanAllows({
      requestedGateway,
      routingPlan,
    });
    const routingDecision = this.resolveGatewayForCreate(
      requestedGateway,
      merchant,
      amountCents,
      currency,
      data?.customerEmail,
      data?.paymentMethodPreference,
    );
    const gateway = routingDecision.selectedGateway;

    const intent = await this.prisma.paymentIntent.create({
      data: {
        merchantId,
        amountCents,
        currency,
        status: IntentStatus.REQUIRES_CONFIRMATION,
        customerEmail: data?.customerEmail,
        description: data?.description,
        metadata: data?.metadata,
      },
      select: {
        id: true,
        merchantId: true,
        amountCents: true,
        currency: true,
        status: true,
        customerEmail: true,
        description: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const gatewaySession = await this.createGatewayRedirect({
      gateway,
      payment: {
        id: intent.id,
        reference: this.intentReferenceFromId(intent.id),
        amountCents: intent.amountCents,
        currency: intent.currency,
        description: intent.description,
        customerEmail: intent.customerEmail,
      },
      merchant,
      itemName: data?.description ?? 'Stackaura payment intent',
    });

    const externalReference = gatewaySession.externalReference ?? null;

    const attempt = await this.prisma.paymentAttemptIntent.create({
      data: {
        paymentIntentId: intent.id,
        gateway,
        status: 'CREATED',
        gatewayRef: externalReference,
        rawGateway: {
          ...this.gatewayRequestSnapshot(gateway, gatewaySession),
          externalReference,
          ...this.buildRoutingSnapshot({
            decision: routingDecision,
            routingPlan,
          }),
        },
      },
      select: {
        id: true,
        gateway: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (normalizedIdempotencyKey && idempotencyRequestHash) {
      await this.prisma.idempotencyKey.upsert({
        where: {
          merchantId_scope_idempotencyKey: {
            merchantId,
            scope: idempotencyScope,
            idempotencyKey: normalizedIdempotencyKey,
          },
        },
        update: {
          requestHash: idempotencyRequestHash,
          paymentIntentId: intent.id,
        },
        create: {
          merchantId,
          scope: idempotencyScope,
          idempotencyKey: normalizedIdempotencyKey,
          requestHash: idempotencyRequestHash,
          paymentIntentId: intent.id,
        },
      });
    }

    return {
      ...intent,
      gateway,
      gatewayRef: externalReference,
      redirectUrl: gatewaySession.redirectUrl,
      redirectForm: gatewaySession.redirectForm ?? null,
      redirectMethod: gatewaySession.redirectForm?.method ?? null,
      attempts: this.toIntentAttemptSummaries([attempt]),
      currentAttemptId: attempt.id,
    };
  }

  async getPaymentIntentById(merchantIdPlain: string, intentIdPlain: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const intentId = intentIdPlain?.trim();
    if (!intentId) throw new BadRequestException('intentId is required');

    const intent = await this.prisma.paymentIntent.findFirst({
      where: {
        id: intentId,
        merchantId,
      },
      select: {
        id: true,
        merchantId: true,
        amountCents: true,
        currency: true,
        status: true,
        customerEmail: true,
        description: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            gateway: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            rawGateway: true,
          },
        },
      },
    });

    if (!intent) throw new NotFoundException('Payment intent not found');
    const latestAttempt = intent.attempts[0];
    const redirectState = this.extractRedirectState(
      latestAttempt?.rawGateway ?? null,
    );

    return {
      ...intent,
      redirectUrl: redirectState.redirectUrl,
      redirectForm: redirectState.redirectForm,
      redirectMethod: redirectState.redirectMethod,
      attempts: this.toIntentAttemptSummaries(intent.attempts),
      currentAttemptId: this.currentIntentAttemptId(intent.attempts),
    };
  }

  async createPayment(
  merchantIdPlain: string,
  data: CreatePaymentDto,
  _idempotencyKey?: string,
) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');
        const normalizedIdempotencyKey = this.normalizeIdempotencyKey(
      _idempotencyKey,
    );
    const idempotencyScope = 'payments.create';
    const idempotencyRequestHash = normalizedIdempotencyKey
      ? this.createIdempotencyRequestHash(idempotencyScope, data)
      : null;

    if (normalizedIdempotencyKey && idempotencyRequestHash) {
      const existingKey = await this.prisma.idempotencyKey.findUnique({
        where: {
          merchantId_scope_idempotencyKey: {
            merchantId,
            scope: idempotencyScope,
            idempotencyKey: normalizedIdempotencyKey,
          },
        },
      });

      if (existingKey) {
        if (existingKey.requestHash !== idempotencyRequestHash) {
          throw new ConflictException(
            'Idempotency-Key has already been used with a different request body',
          );
        }

        if (existingKey.paymentId) {
          return this.getPaymentResponseById(merchantId, existingKey.paymentId);
        }
      }
    }

    const amountCents = this.parsePositiveInt(data?.amountCents, 'amountCents');
    const merchant = await this.getMerchantGatewayConfig(merchantId);
    const routingPlan = this.resolveMerchantRoutingPlan(merchant);
    const feePolicy = this.resolveMerchantFeePolicy(merchant);
    const feeBreakdown = computePlatformFeeBreakdown({
      amountCents,
      policy: feePolicy,
    });
    const { platformFeeCents, merchantNetCents } = feeBreakdown;
    const expiresInMinutes =
      data?.expiresInMinutes !== undefined
        ? this.parsePositiveInt(data.expiresInMinutes, 'expiresInMinutes')
        : 30;

    const reference =
      typeof data?.reference === 'string' && data.reference.trim()
        ? data.reference.trim()
        : this.randomReference();
    const currency =
      typeof data?.currency === 'string' && data.currency.trim()
        ? data.currency.trim().toUpperCase()
        : 'ZAR';
    const requestedGateway = this.parseRequestedGateway(data?.gateway);
    this.assertRoutingPlanAllows({
      requestedGateway,
      routingPlan,
    });
    const routingDecision = this.resolveGatewayForCreate(
      requestedGateway,
      merchant,
      amountCents,
      currency,
      data?.customerEmail,
      data?.paymentMethodPreference,
    );
    const gateway = routingDecision.selectedGateway;
    const checkoutToken = this.randomToken();
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

    const existing = await this.prisma.payment.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (existing)
      throw new ConflictException('Payment reference already exists');

    const payment = await this.prisma.payment.create({
      data: {
        merchantId,
        reference,
        currency,
        amountCents,
        platformFeeCents,
        merchantNetCents,
        gateway,
        checkoutToken,
        expiresAt,
        customerEmail: data?.customerEmail,
        description: data?.description,
      },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        currency: true,
        amountCents: true,
        platformFeeCents: true,
        merchantNetCents: true,
        status: true,
        gateway: true,
        checkoutToken: true,
        expiresAt: true,
        customerEmail: true,
        description: true,
        gatewayRef: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const checkoutRequest = {
      itemName: data?.itemName,
      returnUrl: data?.returnUrl,
      cancelUrl: data?.cancelUrl,
      errorUrl: data?.errorUrl,
      notifyUrl: data?.notifyUrl,
      bankReference: data?.bankReference,
      paymentMethodPreference: data?.paymentMethodPreference,
    };
    const monetizationSnapshot = this.buildMonetizationSnapshot({
      planCode: routingPlan.planCode,
      feePolicy,
      feeBreakdown,
    });
    const initialization = await this.initializePaymentGatewayWithFallback({
      payment: {
        id: payment.id,
        reference: payment.reference,
        amountCents: payment.amountCents,
        currency: payment.currency,
        description: payment.description,
        customerEmail: payment.customerEmail,
        status: payment.status as PaymentStatus,
        rawGateway: null,
        checkoutToken: payment.checkoutToken,
      },
      merchant,
      checkoutRequest,
      routingDecision,
      routingPlan,
      monetizationSnapshot,
    });
    const redirectUrl = initialization.session.redirectUrl;
    const gatewayRef = initialization.gatewayRef;
    const selectedGateway = initialization.gateway;
      
      if (normalizedIdempotencyKey && idempotencyRequestHash) {
  await this.prisma.idempotencyKey.upsert({
    where: {
      merchantId_scope_idempotencyKey: {
        merchantId,
        scope: idempotencyScope,
        idempotencyKey: normalizedIdempotencyKey,
      },
    },
    update: {
      requestHash: idempotencyRequestHash,
      paymentId: payment.id,
    },
    create: {
      merchantId,
      scope: idempotencyScope,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash: idempotencyRequestHash,
      paymentId: payment.id,
    },
  });
}

    return {
      ...payment,
      checkoutUrl: `${this.appUrl()}/v1/checkout/${payment.checkoutToken}`,
      redirectUrl,
      redirectForm: initialization.session.redirectForm ?? null,
      redirectMethod: initialization.session.redirectForm?.method ?? null,
      gatewayRef,
      gateway: selectedGateway,
      routingMode: initialization.routingDecision.mode,
      routingSelectionMode: initialization.routingDecision.selectionMode,
      requestedGateway:
        initialization.routingDecision.requestedGateway ?? 'AUTO',
      selectedGateway,
      fallbackCount: initialization.fallbackCount,
      merchantPlanCode: routingPlan.planCode,
      platformFeeRuleType: feePolicy.ruleType,
      platformFeeSource: feePolicy.source,
      routingPlanCode: routingPlan.planCode,
    };
  }

  async initiateOzowPayment(
    merchantIdPlain: string,
    data: Pick<
      CreatePaymentDto,
      'amountCents' | 'currency' | 'reference' | 'customerEmail' | 'description' | 'bankReference'
    >,
    idempotencyKey?: string,
  ) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const merchant = await this.getMerchantGatewayConfig(merchantId);
    if (!merchant.ozowSiteCode || !merchant.ozowPrivateKey) {
      throw new BadRequestException('Ozow is not configured for this environment');
    }

    const amountCents = this.parsePositiveInt(data?.amountCents, 'amountCents');
    const currency =
      typeof data?.currency === 'string' && data.currency.trim()
        ? data.currency.trim().toUpperCase()
        : 'ZAR';
    const reference =
      typeof data?.reference === 'string' && data.reference.trim()
        ? data.reference.trim()
        : this.randomReference();

    const existing = await this.prisma.payment.findFirst({
      where: { merchantId, reference },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        currency: true,
        amountCents: true,
        platformFeeCents: true,
        merchantNetCents: true,
        status: true,
        gateway: true,
        checkoutToken: true,
        expiresAt: true,
        customerEmail: true,
        description: true,
        gatewayRef: true,
        rawGateway: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!existing) {
      return this.createPayment(
        merchantId,
        {
          amountCents,
          currency,
          gateway: GatewayProvider.OZOW,
          reference,
          customerEmail: data?.customerEmail,
          description: data?.description,
          returnUrl: OZOW_SUCCESS_URL,
          cancelUrl: OZOW_CANCEL_URL,
          errorUrl: OZOW_ERROR_URL,
          notifyUrl: OZOW_NOTIFY_URL,
          bankReference: data?.bankReference,
        },
        idempotencyKey,
      );
    }

    if (existing.amountCents !== amountCents || existing.currency !== currency) {
      throw new ConflictException(
        'Existing payment reference does not match amount or currency',
      );
    }

    if (existing.gateway && existing.gateway !== GatewayProvider.OZOW) {
      throw new ConflictException(
        'Existing payment reference is already assigned to a different gateway',
      );
    }

    if (existing.status === PaymentStatus.PAID) {
      return this.getPaymentResponseById(merchantId, existing.id);
    }

    const gatewaySession = await this.createGatewayRedirect({
      gateway: GatewayProvider.OZOW,
      payment: {
        id: existing.id,
        reference: existing.reference,
        amountCents: existing.amountCents,
        currency: existing.currency,
        description: data?.description ?? existing.description,
        customerEmail: data?.customerEmail ?? existing.customerEmail,
      },
      merchant,
      itemName: data?.description ?? existing.description ?? 'Stackaura payment',
      returnUrl: OZOW_SUCCESS_URL,
      cancelUrl: OZOW_CANCEL_URL,
      errorUrl: OZOW_ERROR_URL,
      notifyUrl: OZOW_NOTIFY_URL,
      bankReference: data?.bankReference,
    });
    const routingPlan = this.resolveMerchantRoutingPlan(merchant);
    const feePolicy = this.resolveStoredFeePolicy({
      rawGateway: existing.rawGateway,
      merchant,
    });
    const monetizationSnapshot = this.buildMonetizationSnapshot({
      planCode: routingPlan.planCode,
      feePolicy,
      feeBreakdown: {
        platformFeeCents: (existing as { platformFeeCents?: number })
          .platformFeeCents ?? 0,
        merchantNetCents: (existing as { merchantNetCents?: number })
          .merchantNetCents ?? existing.amountCents,
      },
    });

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: existing.id },
        data: {
          gateway: GatewayProvider.OZOW,
          status:
            existing.status === PaymentStatus.CREATED
              ? PaymentStatus.CREATED
              : PaymentStatus.PENDING,
          gatewayRef: gatewaySession.externalReference ?? existing.gatewayRef,
          customerEmail: data?.customerEmail ?? existing.customerEmail,
          description: data?.description ?? existing.description,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          rawGateway: this.mergeGatewayPayload(existing.rawGateway, {
            ...this.gatewayRequestSnapshot(GatewayProvider.OZOW, gatewaySession),
            ...this.buildRoutingSnapshot({
              decision: {
                mode: 'STRICT_PRIORITY',
                selectionMode: 'explicit',
                requestedGateway: GatewayProvider.OZOW,
                selectedGateway: GatewayProvider.OZOW,
                routingReason: ['explicit_gateway_request'],
                eligibleGateways: [
                  {
                    gateway: GatewayProvider.OZOW,
                    priority: 1,
                    reason: ['explicit_gateway_request'],
                  },
                ],
                skippedGateways: [],
                rankedGateways: [
                  {
                    gateway: GatewayProvider.OZOW,
                    priority: 1,
                    reason: ['explicit_gateway_request'],
                  },
                ],
                readiness: [],
              },
              routingPlan,
            }),
            ...monetizationSnapshot,
            ...this.buildCheckoutRequestSnapshot({
              returnUrl: OZOW_SUCCESS_URL,
              cancelUrl: OZOW_CANCEL_URL,
              errorUrl: OZOW_ERROR_URL,
              notifyUrl: OZOW_NOTIFY_URL,
              bankReference: data?.bankReference,
            }),
          }),
        },
        select: { id: true },
      }),
      this.prisma.paymentAttempt.create({
        data: {
          paymentId: existing.id,
          gateway: GatewayProvider.OZOW,
          status: 'CREATED',
          redirectUrl: gatewaySession.redirectUrl,
        },
        select: { id: true },
      }),
    ]);

    return this.getPaymentResponseById(merchantId, existing.id);
  }

  private async getHostedCheckoutPaymentRecord(checkoutTokenPlain: string) {
    const checkoutToken = checkoutTokenPlain?.trim();
    if (!checkoutToken) {
      throw new BadRequestException('checkoutToken is required');
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        checkoutToken,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        checkoutToken: true,
        merchantId: true,
        reference: true,
        amountCents: true,
        platformFeeCents: true,
        merchantNetCents: true,
        currency: true,
        status: true,
        description: true,
        customerEmail: true,
        expiresAt: true,
        gateway: true,
        rawGateway: true,
        merchant: {
          select: {
            name: true,
          },
        },
        attempts: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            redirectUrl: true,
            gateway: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Checkout session not found or expired');
    }

    return payment;
  }

  private buildHostedCheckoutGatewayOptions(args: {
    selectedGateway: CheckoutSelectableGateway;
    selectionLocked: boolean;
    readiness: ReturnType<RoutingEngine['getGatewayReadiness']>;
    autoSelectedGateway: GatewayProvider | null;
  }): HostedCheckoutGatewayOption[] {
    const readinessByGateway = new Map(
      args.readiness.map((item) => [item.gateway, item]),
    );
    const lockedToLabel = this.gatewayDisplayName(args.selectedGateway);
    const autoDetail = args.autoSelectedGateway
      ? `Stackaura will start with ${this.gatewayDisplayName(args.autoSelectedGateway)}.`
      : 'No eligible merchant gateway is available for this checkout.';

    return [
      {
        value: 'AUTO',
        label: 'Auto',
        description: 'Let Stackaura pick the best available rail for this payment.',
        detail: args.selectionLocked
          ? `This checkout is locked to ${lockedToLabel}.`
          : autoDetail,
        available: !args.selectionLocked && Boolean(args.autoSelectedGateway),
        selected: args.selectedGateway === 'AUTO',
        recommended: !args.selectionLocked && Boolean(args.autoSelectedGateway),
        locked: args.selectionLocked,
      },
      {
        value: GatewayProvider.YOCO,
        label: 'Yoco',
        description: 'Fast card checkout with Yoco.',
        detail: args.selectionLocked && args.selectedGateway !== GatewayProvider.YOCO
          ? `This checkout is locked to ${lockedToLabel}.`
          : readinessByGateway.get(GatewayProvider.YOCO)?.issues[0] ??
            'Available for this checkout.',
        available:
          (!args.selectionLocked ||
            args.selectedGateway === GatewayProvider.YOCO) &&
          Boolean(readinessByGateway.get(GatewayProvider.YOCO)?.ready),
        selected: args.selectedGateway === GatewayProvider.YOCO,
        recommended: args.autoSelectedGateway === GatewayProvider.YOCO,
        locked:
          args.selectionLocked && args.selectedGateway !== GatewayProvider.YOCO,
      },
      {
        value: GatewayProvider.OZOW,
        label: 'Ozow',
        description: 'Instant EFT checkout with Ozow.',
        detail: args.selectionLocked && args.selectedGateway !== GatewayProvider.OZOW
          ? `This checkout is locked to ${lockedToLabel}.`
          : readinessByGateway.get(GatewayProvider.OZOW)?.issues[0] ??
            'Available for this checkout.',
        available:
          (!args.selectionLocked ||
            args.selectedGateway === GatewayProvider.OZOW) &&
          Boolean(readinessByGateway.get(GatewayProvider.OZOW)?.ready),
        selected: args.selectedGateway === GatewayProvider.OZOW,
        recommended: args.autoSelectedGateway === GatewayProvider.OZOW,
        locked:
          args.selectionLocked && args.selectedGateway !== GatewayProvider.OZOW,
      },
      {
        value: GatewayProvider.PAYSTACK,
        label: 'Paystack',
        description: 'Redirect checkout with Paystack.',
        detail:
          args.selectionLocked &&
          args.selectedGateway !== GatewayProvider.PAYSTACK
            ? `This checkout is locked to ${lockedToLabel}.`
            : readinessByGateway.get(GatewayProvider.PAYSTACK)?.issues[0] ??
              'Available for this checkout.',
        available:
          (!args.selectionLocked ||
            args.selectedGateway === GatewayProvider.PAYSTACK) &&
          Boolean(readinessByGateway.get(GatewayProvider.PAYSTACK)?.ready),
        selected: args.selectedGateway === GatewayProvider.PAYSTACK,
        recommended: args.autoSelectedGateway === GatewayProvider.PAYSTACK,
        locked:
          args.selectionLocked &&
          args.selectedGateway !== GatewayProvider.PAYSTACK,
      },
    ];
  }

  async getHostedCheckoutPageContext(checkoutTokenPlain: string) {
    const payment = await this.getHostedCheckoutPaymentRecord(checkoutTokenPlain);
    const merchant = await this.getMerchantGatewayConfig(payment.merchantId);
    const routingPlan = this.resolveMerchantRoutingPlan(merchant);
    const routingState = this.extractStoredRoutingState(payment.rawGateway);
    const checkoutRequest = this.extractCheckoutRequestContext(payment.rawGateway);
    const selectedGateway = this.coerceCheckoutSelectableGateway(
      routingState.requestedGateway,
    );
    const selectionLocked =
      !routingPlan.manualGatewaySelection || selectedGateway !== 'AUTO';
    const readiness = this.routingEngine.getGatewayReadiness({
      merchant,
      mode: 'STRICT_PRIORITY',
      amountCents: payment.amountCents,
      currency: payment.currency,
      customerEmail: payment.customerEmail,
      paymentMethodPreference: checkoutRequest.paymentMethodPreference,
    });

    let autoSelectedGateway: GatewayProvider | null = null;
    try {
      autoSelectedGateway = this.routingEngine.decide({
        requestedGateway: 'AUTO',
        merchant,
        mode: 'STRICT_PRIORITY',
        amountCents: payment.amountCents,
        currency: payment.currency,
        customerEmail: payment.customerEmail,
        paymentMethodPreference: checkoutRequest.paymentMethodPreference,
      }).selectedGateway;
    } catch {
      autoSelectedGateway = null;
    }

    return {
      checkoutToken: payment.checkoutToken,
      merchantName: payment.merchant?.name ?? 'Merchant',
      reference: payment.reference,
      amountCents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      description: payment.description,
      customerEmail: payment.customerEmail,
      expiresAt: payment.expiresAt,
      currentGateway:
        payment.attempts[0]?.gateway ?? payment.gateway ?? autoSelectedGateway,
      selectedGateway,
      selectionLocked,
      gatewayOptions: this.buildHostedCheckoutGatewayOptions({
        selectedGateway,
        selectionLocked,
        readiness,
        autoSelectedGateway,
      }),
      recommendedGateway: autoSelectedGateway,
    };
  }

  async continueHostedCheckout(
    checkoutTokenPlain: string,
    gatewayPlain?: string | null,
  ) {
    const payment = await this.getHostedCheckoutPaymentRecord(checkoutTokenPlain);
    const merchant = await this.getMerchantGatewayConfig(payment.merchantId);
    const routingPlan = this.resolveMerchantRoutingPlan(merchant);
    const routingState = this.extractStoredRoutingState(payment.rawGateway);
    const checkoutRequest = this.extractCheckoutRequestContext(payment.rawGateway);
    const storedSelectableGateway = this.coerceCheckoutSelectableGateway(
      routingState.requestedGateway,
    );
    const requestedGateway =
      this.parseCheckoutSelectableGateway(gatewayPlain ?? null) ??
      storedSelectableGateway;

    if (storedSelectableGateway !== 'AUTO' && requestedGateway !== storedSelectableGateway) {
      throw new BadRequestException(
        `This checkout is locked to ${this.gatewayDisplayName(storedSelectableGateway)}`,
      );
    }

    if (storedSelectableGateway === 'AUTO') {
      this.assertRoutingPlanAllows({
        requestedGateway,
        routingPlan,
      });
    }

    if (payment.status === PaymentStatus.PAID) {
      throw new BadRequestException('Payment is already paid');
    }

    const routingDecision = this.resolveGatewayForCreate(
      requestedGateway,
      merchant,
      payment.amountCents,
      payment.currency,
      payment.customerEmail,
      checkoutRequest.paymentMethodPreference,
    );
    const selectedGateway = routingDecision.selectedGateway;
    const latestAttempt = payment.attempts[0] ?? null;
    const redirectState = this.extractRedirectState(
      payment.rawGateway,
      latestAttempt?.redirectUrl ?? null,
    );

    if (
      payment.gateway === selectedGateway &&
      (redirectState.redirectForm || redirectState.redirectUrl)
    ) {
      return {
        paymentId: payment.id,
        reference: payment.reference,
        gateway: selectedGateway,
        redirectUrl: redirectState.redirectUrl,
        redirectForm: redirectState.redirectForm,
        redirectMethod: redirectState.redirectMethod,
        reused: true,
      };
    }

    const feePolicy = this.resolveStoredFeePolicy({
      rawGateway: payment.rawGateway,
      merchant,
    });
    const monetizationSnapshot = this.buildMonetizationSnapshot({
      planCode: routingPlan.planCode,
      feePolicy,
      feeBreakdown: {
        platformFeeCents: payment.platformFeeCents,
        merchantNetCents: payment.merchantNetCents,
      },
    });
    const initialization = await this.initializePaymentGatewayWithFallback({
      payment: {
        id: payment.id,
        reference: payment.reference,
        amountCents: payment.amountCents,
        currency: payment.currency,
        description: payment.description,
        customerEmail: payment.customerEmail,
        status: payment.status as PaymentStatus,
        rawGateway: payment.rawGateway,
        checkoutToken: payment.checkoutToken,
      },
      merchant,
      checkoutRequest,
      routingDecision,
      routingPlan,
      monetizationSnapshot,
    });

    return {
      paymentId: payment.id,
      reference: payment.reference,
      gateway: initialization.gateway,
      redirectUrl: initialization.session.redirectUrl,
      redirectForm: initialization.session.redirectForm ?? null,
      redirectMethod: initialization.session.redirectForm?.method ?? null,
      reused: false,
    };
  }

  async initiatePublicOzowSignup(
    data: PublicOzowSignupInitiateDto,
    idempotencyKey?: string,
  ) {
    const merchant = await this.resolvePublicOzowSignupMerchant(data.signup);
    const amountCents =
      data.amountCents !== undefined
        ? this.parsePositiveInt(data.amountCents, 'amountCents')
        : this.publicOzowSignupAmountCents();
    const currency =
      typeof data.currency === 'string' && data.currency.trim()
        ? data.currency.trim().toUpperCase()
        : 'ZAR';
    const reference =
      typeof data.reference === 'string' && data.reference.trim()
        ? data.reference.trim()
        : this.buildPublicOzowSignupReference(merchant.id);
    const returnUrls = this.resolvePublicOzowReturnUrls(data.returnUrls);

    const payment = await this.initiateOzowPayment(
      merchant.id,
      {
        amountCents,
        currency,
        reference,
        customerEmail: this.normalizeEmail(data.signup.email),
        description: `Stackaura merchant signup - ${data.signup.businessName.trim()}`,
      },
      idempotencyKey,
    );

    const stored = await this.prisma.payment.findUnique({
      where: { id: payment.id },
      select: { rawGateway: true },
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        rawGateway: this.mergeGatewayPayload(
          stored?.rawGateway,
          this.buildPublicOzowFlowMetadata({
            merchantId: merchant.id,
            signup: data.signup,
            returnUrls,
          }),
        ),
      },
      select: { id: true },
    });

    return payment;
  }

  async fulfillPaidSignupPayment(paymentIdPlain: string) {
    const paymentId = paymentIdPlain?.trim();
    if (!paymentId) {
      throw new BadRequestException('paymentId is required');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        status: true,
        rawGateway: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status !== PaymentStatus.PAID) {
      const outcome = {
        paymentId: payment.id,
        reference: payment.reference,
        merchantId: payment.merchantId,
        fulfilled: false,
        reason: 'payment_not_paid' as const,
      };
      this.logger.log(
        JSON.stringify({ event: 'signup.fulfillment.skipped', ...outcome }),
      );
      return outcome;
    }

    const publicFlow = this.publicOzowSignupFlow(payment.rawGateway);
    if (!publicFlow) {
      return {
        paymentId: payment.id,
        reference: payment.reference,
        merchantId: payment.merchantId,
        fulfilled: false,
        reason: 'not_signup_payment' as const,
      };
    }

    const existingFulfillment = this.asRecord(publicFlow.fulfillment);
    if (existingFulfillment?.status === 'COMPLETED') {
      const outcome = {
        paymentId: payment.id,
        reference: payment.reference,
        merchantId: payment.merchantId,
        fulfilled: false,
        reason: 'already_fulfilled' as const,
        apiKeyId:
          typeof existingFulfillment.apiKeyId === 'string'
            ? existingFulfillment.apiKeyId
            : null,
      };
      this.logger.log(
        JSON.stringify({ event: 'signup.fulfillment.skipped', ...outcome }),
      );
      return outcome;
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { id: payment.merchantId },
      select: {
        id: true,
        isActive: true,
      },
    });

    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }

    const apiKey = await this.merchantsService.ensureInitialApiKey(
      payment.merchantId,
    );

    let merchantActivated = false;
    if (!merchant.isActive) {
      await this.prisma.merchant.update({
        where: { id: payment.merchantId },
        data: { isActive: true },
        select: { id: true },
      });
      merchantActivated = true;
    }

    await this.prisma.user.updateMany({
      where: {
        isActive: false,
        memberships: {
          some: {
            merchantId: payment.merchantId,
          },
        },
      },
      data: { isActive: true },
    });

    const fulfilledAt = new Date().toISOString();
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        rawGateway: this.mergeGatewayPayload(payment.rawGateway, {
          publicFlow: {
            ...publicFlow,
            fulfillment: {
              status: 'COMPLETED',
              fulfilledAt,
              merchantId: payment.merchantId,
              apiKeyId: apiKey.apiKeyId,
              apiKeyIssued: apiKey.created,
              merchantActivated,
            },
          },
        }),
      },
      select: { id: true },
    });

    const outcome = {
      paymentId: payment.id,
      reference: payment.reference,
      merchantId: payment.merchantId,
      fulfilled: true,
      reason: 'fulfilled' as const,
      merchantActivated,
      apiKeyIssued: apiKey.created,
      apiKeyId: apiKey.apiKeyId,
    };
    this.logger.log(
      JSON.stringify({ event: 'signup.fulfillment.completed', ...outcome }),
    );
    return outcome;
  }

  async getPublicOzowPaymentStatus(referencePlain: string) {
    const reference = referencePlain?.trim();
    if (!reference) throw new BadRequestException('reference is required');

    const payment = await this.prisma.payment.findFirst({
      where: { reference },
      select: {
        merchantId: true,
        rawGateway: true,
      },
    });

    if (!payment || !this.isPublicOzowSignupPayment(payment.rawGateway)) {
      throw new NotFoundException('Payment not found');
    }

    return this.getOzowPaymentStatus(payment.merchantId, reference);
  }

  async getOzowPaymentStatus(merchantIdPlain: string, referencePlain: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const reference = referencePlain?.trim();
    if (!reference) throw new BadRequestException('reference is required');

    const payment = await this.prisma.payment.findFirst({
      where: { merchantId, reference },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        amountCents: true,
        currency: true,
        status: true,
        gateway: true,
        gatewayRef: true,
        rawGateway: true,
        merchant: {
          select: {
            ozowSiteCode: true,
            ozowPrivateKey: true,
            ozowApiKey: true,
            ozowIsTest: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');

    if (payment.gateway && payment.gateway !== GatewayProvider.OZOW) {
      throw new BadRequestException('Payment is not an Ozow payment');
    }

    const ozowPrivateKey = decryptStoredSecret(payment.merchant.ozowPrivateKey);
    const ozowApiKey = decryptStoredSecret(payment.merchant.ozowApiKey);
    const ozowConfig = resolveOzowConfig({
      ozowSiteCode: payment.merchant.ozowSiteCode,
      ozowPrivateKey,
      ozowApiKey,
      ozowIsTest: payment.merchant.ozowIsTest,
    });
    const providerReference =
      this.extractOzowProviderReference(payment.rawGateway) ?? payment.reference;
    const providerTransactionId =
      payment.gatewayRef && payment.gatewayRef !== providerReference
        ? payment.gatewayRef
        : null;

    const transaction = await this.ozowGateway.getTransactionStatus({
      reference: providerReference,
      transactionId: providerTransactionId,
      config: {
        ozowSiteCode: ozowConfig.siteCode,
        ozowApiKey: ozowConfig.apiKey,
        ozowIsTest: ozowConfig.isTest,
      },
    });

    const nextStatus = this.mapGatewayLookupStatus(transaction.status);
    let localStatus = payment.status;
    let synced = false;

    if (
      canTransitionPaymentStatus(payment.status, nextStatus) &&
      payment.status !== nextStatus
    ) {
      await this.prisma.$transaction(async (tx) => {
        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: nextStatus,
            gateway: GatewayProvider.OZOW,
            gatewayRef: transaction.transactionId ?? payment.gatewayRef,
            rawGateway: this.mergeGatewayPayload(payment.rawGateway, {
              provider: 'OZOW',
              externalReference: providerReference,
              ozow: {
                transactionReference: providerReference,
              },
              statusLookup: {
                checkedAt: new Date().toISOString(),
                status: transaction.providerStatus,
                statusMessage: transaction.providerStatusMessage,
                transactionId: transaction.transactionId,
                amount: transaction.amount,
                currency: transaction.currency,
                raw: transaction.raw,
              },
            }),
          },
          select: { id: true },
        });

        const attemptStatus = this.mapPaymentStatusToAttemptStatus(nextStatus);
        if (
          latestAttempt &&
          attemptStatus &&
          latestAttempt.status !== attemptStatus
        ) {
          await tx.paymentAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: attemptStatus },
            select: { id: true },
          });
        }
      });

      localStatus = nextStatus;
      synced = true;

      if (
        payment.status !== nextStatus &&
        nextStatus === PaymentStatus.PAID
      ) {
        await this.recordSuccessfulPaymentLedgerByPaymentId(payment.id);
        await this.fulfillPaidSignupPayment(payment.id);
      }
    }

    return {
      paymentId: payment.id,
      reference: payment.reference,
      localStatus,
      providerStatus: transaction.providerStatus,
      providerStatusMessage: transaction.providerStatusMessage,
      gatewayRef: transaction.transactionId ?? providerTransactionId,
      amount: transaction.amount,
      currency: transaction.currency,
      synced,
      isTest: ozowConfig.isTest,
      providerReference,
      raw: transaction.raw,
    };
  }

  async getPaystackPaymentStatus(
    merchantIdPlain: string,
    referencePlain: string,
  ) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const reference = referencePlain?.trim();
    if (!reference) throw new BadRequestException('reference is required');

    const payment = await this.prisma.payment.findFirst({
      where: { merchantId, reference },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        amountCents: true,
        currency: true,
        status: true,
        gateway: true,
        gatewayRef: true,
        rawGateway: true,
        merchant: {
          select: {
            paystackSecretKey: true,
            paystackTestMode: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.gateway && payment.gateway !== GatewayProvider.PAYSTACK) {
      throw new BadRequestException('Payment is not a Paystack payment');
    }

    const snapshot = this.extractPaystackState(payment.rawGateway);
    const paystackSecretKey = decryptStoredSecret(
      payment.merchant.paystackSecretKey,
    );
    const paystackConfig = resolvePaystackConfig({
      paystackSecretKey,
      paystackTestMode: payment.merchant.paystackTestMode,
    });
    const providerSnapshot: PaystackVerifyStatus =
      await this.paystackGateway.verifyTransaction({
        reference: payment.reference,
        config: {
          paystackSecretKey: paystackConfig.secretKey,
          paystackTestMode: paystackConfig.testMode,
        },
      });

    if (providerSnapshot.reference !== payment.reference) {
      throw new BadRequestException('Paystack transaction reference mismatch');
    }

    const mappedFromWebhook = snapshot.eventType
      ? mapPaystackEventToPaymentStatus({
          eventType: snapshot.eventType,
          transactionStatus: snapshot.providerStatus,
        })
      : null;
    const nextStatus =
      mappedFromWebhook ??
      mapPaystackTransactionStatusToPaymentStatus(
        providerSnapshot.providerStatus ?? snapshot.providerStatus,
      );

    let localStatus = payment.status;
    let synced = false;

    if (
      payment.status === nextStatus ||
      canTransitionPaymentStatus(payment.status, nextStatus)
    ) {
      await this.prisma.$transaction(async (tx) => {
        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            ...(payment.status !== nextStatus ? { status: nextStatus } : {}),
            gateway: GatewayProvider.PAYSTACK,
            gatewayRef: providerSnapshot.accessCode ?? payment.gatewayRef,
            rawGateway: this.mergeGatewayPayload(payment.rawGateway, {
              provider: 'PAYSTACK',
              paystack: {
                reference: providerSnapshot.reference,
                accessCode: providerSnapshot.accessCode ?? payment.gatewayRef,
                providerStatus: providerSnapshot.providerStatus,
                eventType: snapshot.eventType,
                paidAt: providerSnapshot.paidAt,
                channel: providerSnapshot.channel,
                customerEmail: providerSnapshot.customerEmail,
                gatewayResponse: snapshot.gatewayResponse,
                checkedAt: new Date().toISOString(),
                rawLookup: providerSnapshot.raw,
                rawEvent: snapshot.raw,
                source: snapshot.eventType
                  ? 'provider_lookup_and_webhook'
                  : 'provider_lookup',
              },
            }),
          },
          select: { id: true },
        });

        const attemptStatus = this.mapPaymentStatusToAttemptStatus(nextStatus);
        if (
          latestAttempt &&
          attemptStatus &&
          latestAttempt.status !== attemptStatus
        ) {
          await tx.paymentAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: attemptStatus },
            select: { id: true },
          });
        }
      });

      localStatus = nextStatus;
      synced = true;

      if (
        payment.status !== nextStatus &&
        nextStatus === PaymentStatus.PAID
      ) {
        await this.recordSuccessfulPaymentLedgerByPaymentId(payment.id);
        await this.fulfillPaidSignupPayment(payment.id);
      }
    }

    return {
      paymentId: payment.id,
      reference: payment.reference,
      localStatus,
      providerStatus: providerSnapshot.providerStatus,
      gatewayRef: providerSnapshot.accessCode ?? payment.gatewayRef,
      paidAt: providerSnapshot.paidAt,
      channel: providerSnapshot.channel,
      amount: providerSnapshot.amount,
      currency: providerSnapshot.currency,
      synced,
      isTest: paystackConfig.testMode,
      raw: providerSnapshot.raw,
    };
  }

  async getYocoPaymentStatus(merchantIdPlain: string, referencePlain: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const reference = referencePlain?.trim();
    if (!reference) throw new BadRequestException('reference is required');

    const payment = await this.prisma.payment.findFirst({
      where: { merchantId, reference },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        amountCents: true,
        currency: true,
        status: true,
        gateway: true,
        gatewayRef: true,
        rawGateway: true,
        expiresAt: true,
        merchant: {
          select: {
            yocoPublicKey: true,
            yocoSecretKey: true,
            yocoTestMode: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.gateway && payment.gateway !== GatewayProvider.YOCO) {
      throw new BadRequestException('Payment is not a Yoco payment');
    }

    const snapshot = this.extractYocoState(payment.rawGateway);
    const expired = payment.expiresAt.getTime() <= Date.now();
    let providerLookupError: string | null = null;
    let providerSnapshot:
      | Awaited<ReturnType<YocoGateway['getCheckoutStatus']>>
      | null = null;

    const checkoutId = snapshot.checkoutId ?? payment.gatewayRef;
    if (checkoutId) {
      try {
        const yocoSecretKey = decryptStoredSecret(payment.merchant.yocoSecretKey);
        const yocoConfig = resolveYocoConfig({
          yocoPublicKey: payment.merchant.yocoPublicKey,
          yocoSecretKey,
          yocoTestMode: payment.merchant.yocoTestMode,
        });

        providerSnapshot = await this.yocoGateway.getCheckoutStatus({
          checkoutId,
          config: {
            yocoPublicKey: yocoConfig.publicKey,
            yocoSecretKey: yocoConfig.secretKey,
            yocoTestMode: yocoConfig.testMode,
          },
        });

        if (
          providerSnapshot.externalReference &&
          providerSnapshot.externalReference !== payment.reference
        ) {
          throw new BadRequestException('Yoco checkout reference mismatch');
        }
        if (
          providerSnapshot.clientReferenceId &&
          providerSnapshot.clientReferenceId !== payment.id
        ) {
          throw new BadRequestException('Yoco checkout payment id mismatch');
        }
      } catch (error) {
        providerLookupError =
          error instanceof Error ? error.message : 'Unknown Yoco lookup error';
        this.logger.warn(
          JSON.stringify({
            event: 'yoco.status_lookup.failed',
            paymentId: payment.id,
            reference: payment.reference,
            checkoutId,
            error: providerLookupError,
          }),
        );
      }
    }

    const checkoutStatus =
      providerSnapshot?.providerStatus ?? snapshot.checkoutStatus;
    const providerPaymentId = providerSnapshot?.paymentId ?? snapshot.paymentId;
    const processingMode =
      providerSnapshot?.processingMode ?? snapshot.processingMode;
    const mappedFromWebhook = mapYocoEventToPaymentStatus({
      eventType: snapshot.eventType,
      paymentStatus: snapshot.paymentStatus,
    });
    const nextStatus =
      mappedFromWebhook ??
      (checkoutStatus || providerPaymentId
        ? mapYocoCheckoutStatusToPaymentStatus({
            checkoutStatus,
            paymentId: providerPaymentId,
            expired,
          })
        : expired &&
            payment.status !== PaymentStatus.PAID &&
            payment.status !== PaymentStatus.FAILED &&
            payment.status !== PaymentStatus.CANCELLED
          ? PaymentStatus.CANCELLED
          : payment.status);

    let localStatus = payment.status;
    let synced = false;

    const shouldPersistLookup =
      providerSnapshot !== null ||
      providerLookupError !== null ||
      payment.status !== nextStatus;

    if (
      shouldPersistLookup &&
      (payment.status === nextStatus ||
        canTransitionPaymentStatus(payment.status, nextStatus))
    ) {
      await this.prisma.$transaction(async (tx) => {
        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            ...(payment.status !== nextStatus ? { status: nextStatus } : {}),
            gateway: GatewayProvider.YOCO,
            gatewayRef: providerSnapshot?.checkoutId ?? snapshot.checkoutId ?? payment.gatewayRef,
            rawGateway: this.mergeGatewayPayload(payment.rawGateway, {
              provider: 'YOCO',
              yoco: {
                checkoutId:
                  providerSnapshot?.checkoutId ??
                  snapshot.checkoutId ??
                  payment.gatewayRef,
                checkoutStatus,
                paymentId: providerPaymentId,
                paymentStatus: snapshot.paymentStatus,
                eventType: snapshot.eventType,
                processingMode,
                failureReason: snapshot.failureReason,
                checkedAt: new Date().toISOString(),
                lookupError: providerLookupError,
                externalReference:
                  providerSnapshot?.externalReference ?? payment.reference,
                clientReferenceId: providerSnapshot?.clientReferenceId ?? payment.id,
                source:
                  providerSnapshot !== null
                    ? 'provider_lookup_and_webhook'
                    : 'stored_checkout_and_webhook',
                expired,
                rawLookup: providerSnapshot?.raw ?? null,
                rawEvent: snapshot.raw,
              },
            }),
          },
          select: { id: true },
        });

        const attemptStatus = this.mapPaymentStatusToAttemptStatus(nextStatus);
        if (
          latestAttempt &&
          attemptStatus &&
          latestAttempt.status !== attemptStatus
        ) {
          await tx.paymentAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: attemptStatus },
            select: { id: true },
          });
        }
      });

      localStatus = nextStatus;
      synced = true;

      if (nextStatus === PaymentStatus.PAID) {
        await this.recordSuccessfulPaymentLedgerByPaymentId(payment.id);
        await this.fulfillPaidSignupPayment(payment.id);
      }
    }

    return {
      paymentId: payment.id,
      reference: payment.reference,
      localStatus,
      providerStatus: snapshot.paymentStatus ?? checkoutStatus,
      providerEventType: snapshot.eventType,
      checkoutId:
        providerSnapshot?.checkoutId ?? snapshot.checkoutId ?? payment.gatewayRef,
      providerPaymentId,
      processingMode,
      failureReason: snapshot.failureReason,
      gatewayRef:
        providerSnapshot?.checkoutId ?? snapshot.checkoutId ?? payment.gatewayRef,
      expired,
      synced,
      providerLookupError,
      raw: providerSnapshot?.raw ?? snapshot.raw,
    };
  }

  async failoverPayment(merchantIdPlain: string, referencePlain: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const result = await this.createFailoverAttempt({
      reference: referencePlain,
      merchantId,
      failSilently: false,
    });

    if (!result) {
      throw new BadRequestException('No failover gateway available');
    }

    return result;
  }

  async autoFailoverByReference(referencePlain: string) {
    try {
      return await this.createFailoverAttempt({
        reference: referencePlain,
        failSilently: true,
      });
    } catch {
      return null;
    }
  }

  private async createFailoverAttempt(args: {
    reference: string;
    merchantId?: string;
    failSilently: boolean;
  }) {
    const reference = args.reference?.trim();
    if (!reference) {
      if (args.failSilently) return null;
      throw new BadRequestException('reference is required');
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        reference,
        ...(args.merchantId ? { merchantId: args.merchantId } : {}),
      },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        amountCents: true,
        currency: true,
        status: true,
        gateway: true,
        checkoutToken: true,
        customerEmail: true,
        description: true,
        rawGateway: true,
        merchant: {
          select: {
            id: true,
            payfastMerchantId: true,
            payfastMerchantKey: true,
            payfastPassphrase: true,
            payfastIsSandbox: true,
            ozowSiteCode: true,
            ozowPrivateKey: true,
            ozowApiKey: true,
            ozowIsTest: true,
            yocoPublicKey: true,
            yocoSecretKey: true,
            yocoTestMode: true,
            paystackSecretKey: true,
            paystackTestMode: true,
            planCode: true,
            gatewayOrder: true,
            platformFeeBps: true,
            platformFeeFixedCents: true,
          },
        },
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            gateway: true,
            status: true,
            redirectUrl: true,
          },
        },
      },
    });

    if (!payment) {
      if (args.failSilently) return null;
      throw new NotFoundException('Payment not found');
    }

    if (payment.status === PaymentStatus.PAID) {
      if (args.failSilently) return null;
      throw new BadRequestException('Payment is already paid');
    }

    const routingState = this.extractStoredRoutingState(payment.rawGateway);
    if (routingState.explicitSelection) {
      if (args.failSilently) {
        return null;
      }

      throw new BadRequestException(
        `Automatic failover is disabled because this payment is locked to ${this.gatewayDisplayName(
          this.coerceCheckoutSelectableGateway(routingState.requestedGateway),
        )}`,
      );
    }

    if (
      this.hasProviderCheckoutStarted({
        rawGateway: payment.rawGateway,
        latestAttemptRedirectUrl: payment.attempts[0]?.redirectUrl ?? null,
      })
    ) {
      if (args.failSilently) {
        return null;
      }

      throw new BadRequestException(
        'Fallback is unavailable after provider checkout has already started',
      );
    }

    const merchantOzowConfig = resolveOzowConfig({
      ozowSiteCode: payment.merchant.ozowSiteCode,
      ozowPrivateKey: decryptStoredSecret(payment.merchant.ozowPrivateKey),
      ozowApiKey: decryptStoredSecret(payment.merchant.ozowApiKey),
      ozowIsTest: payment.merchant.ozowIsTest,
    });
    const merchantYocoConfig = resolveYocoConfig({
      yocoPublicKey: payment.merchant.yocoPublicKey,
      yocoSecretKey: decryptStoredSecret(payment.merchant.yocoSecretKey),
      yocoTestMode: payment.merchant.yocoTestMode,
    });
    const merchantPaystackConfig = resolvePaystackConfig({
      paystackSecretKey: decryptStoredSecret(payment.merchant.paystackSecretKey),
      paystackTestMode: payment.merchant.paystackTestMode,
    });
    const merchantConfig = {
      ...payment.merchant,
      payfastMerchantKey: decryptStoredSecret(payment.merchant.payfastMerchantKey),
      payfastPassphrase: decryptStoredSecret(payment.merchant.payfastPassphrase),
      ozowSiteCode: merchantOzowConfig.siteCode,
      ozowPrivateKey: merchantOzowConfig.privateKey,
      ozowApiKey: merchantOzowConfig.apiKey,
      ozowIsTest: merchantOzowConfig.isTest,
      yocoPublicKey: merchantYocoConfig.publicKey,
      yocoSecretKey: merchantYocoConfig.secretKey,
      yocoTestMode: merchantYocoConfig.testMode,
      paystackSecretKey: merchantPaystackConfig.secretKey,
      paystackTestMode: merchantPaystackConfig.testMode,
      planCode:
        typeof payment.merchant.planCode === 'string' &&
        payment.merchant.planCode.trim()
          ? payment.merchant.planCode.trim().toLowerCase()
          : 'growth',
      gatewayOrder: payment.merchant.gatewayOrder,
      platformFeeBps: payment.merchant.platformFeeBps,
      platformFeeFixedCents: payment.merchant.platformFeeFixedCents,
    };
    const routingPlan = this.resolveMerchantRoutingPlan(merchantConfig);
    if (!routingPlan.fallback) {
      if (args.failSilently) {
        return null;
      }

      throw new BadRequestException('Fallback is not enabled for this plan');
    }
    const checkoutRequest = this.extractCheckoutRequestContext(payment.rawGateway);
    const routingDecision = this.resolveNextFailoverDecision({
      paymentGateway: payment.gateway ?? null,
      attempts: payment.attempts,
      merchant: merchantConfig,
      amountCents: payment.amountCents,
      currency: payment.currency,
      customerEmail: payment.customerEmail,
      paymentMethodPreference: checkoutRequest.paymentMethodPreference,
    });
    const nextGateway = routingDecision.selectedGateway;

    if (!nextGateway) {
      if (args.failSilently) return null;
      throw new BadRequestException('No failover gateway available');
    }

    const gatewaySession = await this.createGatewayRedirect({
      gateway: nextGateway,
      payment,
      merchant: merchantConfig,
      ...checkoutRequest,
    });
    const redirectUrl = gatewaySession.redirectUrl;
    const externalReference = gatewaySession.externalReference ?? null;

    const attempt = await this.prisma.$transaction(async (tx) => {
      await this.cancelSupersededOpenAttempts({
        tx,
        paymentId: payment.id,
        nextGateway,
      });

      const createdAttempt = await tx.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          gateway: nextGateway,
          status: 'CREATED',
          redirectUrl,
        },
        select: { id: true },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          gateway: nextGateway,
          gatewayRef: externalReference,
          status: PaymentStatus.PENDING,
          rawGateway: this.mergeGatewayPayload(payment.rawGateway, {
            ...this.gatewayRequestSnapshot(nextGateway, gatewaySession),
            ...this.buildRoutingSnapshot({
              decision: routingDecision,
              routingPlan,
              fallbackCount: routingState.fallbackCount + 1,
              lastFallback: {
                fromGateway: payment.gateway,
                toGateway: nextGateway,
                reason: ['manual_failover'],
                triggeredAt: new Date().toISOString(),
              },
            }),
            ...this.buildCheckoutRequestSnapshot(checkoutRequest),
          }),
        },
        select: { id: true },
      });

      return createdAttempt;
    });

    return {
      paymentId: payment.id,
      reference: payment.reference,
      gateway: nextGateway,
      attemptId: attempt.id,
      redirectUrl,
      redirectForm: gatewaySession.redirectForm ?? null,
      redirectMethod: gatewaySession.redirectForm?.method ?? null,
      gatewayRef: externalReference,
      checkoutUrl: `${this.appUrl()}/v1/checkout/${payment.checkoutToken}`,
    };
  }

  async getPaymentByReference(merchantIdPlain: string, reference: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const payment = await this.prisma.payment.findFirst({
      where: { merchantId, reference },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        currency: true,
        amountCents: true,
        platformFeeCents: true,
        merchantNetCents: true,
        status: true,
        gateway: true,
        checkoutToken: true,
        expiresAt: true,
        customerEmail: true,
        description: true,
        gatewayRef: true,
        rawGateway: true,
        createdAt: true,
        updatedAt: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            gateway: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            redirectUrl: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');

    const { attempts, rawGateway, ...rest } = payment;
    const latestAttempt = attempts && attempts.length > 0 ? attempts[0] : null;
    const redirectState = this.extractRedirectState(
      rawGateway,
      latestAttempt?.redirectUrl ?? null,
    );
    const routingSummary = this.extractStoredRoutingSummary(
      rawGateway,
      rest.gateway,
    );
    const monetizationSummary = this.extractStoredMonetizationSummary(rawGateway);

    return {
      ...rest,
      checkoutUrl: `${this.appUrl()}/v1/checkout/${rest.checkoutToken}`,
      // Convenience field for clients: the redirect URL for the latest/current attempt
      redirectUrl: redirectState.redirectUrl,
      redirectForm: redirectState.redirectForm,
      redirectMethod: redirectState.redirectMethod,
      routingMode: routingSummary.routingMode,
      routingSelectionMode: routingSummary.routingSelectionMode,
      requestedGateway: routingSummary.requestedGateway,
      selectedGateway: routingSummary.selectedGateway,
      routingReason: routingSummary.routingReason,
      fallbackCount: routingSummary.fallbackCount,
      routingPlanCode: routingSummary.routingPlanCode,
      merchantPlanCode: monetizationSummary.merchantPlanCode,
      platformFeeRuleType: monetizationSummary.platformFeeRuleType,
      platformFeeSource: monetizationSummary.platformFeeSource,
      attempts: this.toAttemptSummaries(attempts, true),
      currentAttemptId: this.currentAttemptId(attempts),
    };
  }

  async listPaymentAttempts(merchantIdPlain: string, referencePlain: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const reference = referencePlain?.trim();
    if (!reference) throw new BadRequestException('reference is required');

    const payment = await this.prisma.payment.findFirst({
      where: { merchantId, reference },
      select: {
        id: true,
        reference: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            gateway: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            redirectUrl: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');

    return {
      paymentId: payment.id,
      reference: payment.reference,
      currentAttemptId: this.currentAttemptId(payment.attempts),
      attempts: this.toAttemptSummaries(payment.attempts, true),
    };
  }

  async listPayments(merchantIdPlain: string, query: ListPaymentsQuery = {}) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const status = this.parseStatusFilter(query.status);
    const gateway = this.parseGatewayFilter(query.gateway);
    const createdAt = this.parseCreatedAtFilter(query.from, query.to);
    const search = this.firstQueryValue(query.q)?.trim();
    const limit = this.parseListLimit(query.limit);
    const cursor = this.parseCursor(query.cursor);

    const andClauses: Prisma.PaymentWhereInput[] = [];
    if (cursor) {
      andClauses.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          {
            AND: [
              { createdAt: { equals: cursor.createdAt } },
              { id: { lt: cursor.id } },
            ],
          },
        ],
      });
    }

    const where: Prisma.PaymentWhereInput = {
      merchantId,
      ...(status ? { status } : {}),
      ...(gateway ? { gateway } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(search
        ? {
            OR: [
              { reference: { contains: search, mode: 'insensitive' } },
              { customerEmail: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(andClauses.length ? { AND: andClauses } : {}),
    };

    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: this.listSelect,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const data = page.map((row) => {
      const { checkoutToken, attempts, rawGateway: _rawGateway, ...payment } = row;
      const routingSummary = this.extractStoredRoutingSummary(
        row.rawGateway,
        row.gateway,
      );
      const monetizationSummary = this.extractStoredMonetizationSummary(
        row.rawGateway,
      );
      return {
        ...payment,
        checkoutUrl: `${this.appUrl()}/v1/checkout/${checkoutToken}`,
        routingMode: routingSummary.routingMode,
        routingSelectionMode: routingSummary.routingSelectionMode,
        requestedGateway: routingSummary.requestedGateway,
        selectedGateway: routingSummary.selectedGateway,
        fallbackCount: routingSummary.fallbackCount,
        routingPlanCode: routingSummary.routingPlanCode,
        merchantPlanCode: monetizationSummary.merchantPlanCode,
        platformFeeRuleType: monetizationSummary.platformFeeRuleType,
        platformFeeSource: monetizationSummary.platformFeeSource,
        attempts: this.toAttemptSummaries(attempts, false),
        currentAttemptId: this.currentAttemptId(attempts),
      };
    });

    if (!hasMore || page.length === 0) {
      return { data };
    }

    const last = page[page.length - 1];
    return {
      data,
      nextCursor: this.encodeCursor({
        id: last.id,
        createdAt: last.createdAt,
      }),
    };
  }

  private firstQueryValue(value: string | string[] | undefined) {
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private parseListLimit(value: string | string[] | undefined) {
    const raw = this.firstQueryValue(value);
    if (!raw?.trim()) return 25;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException('limit must be a positive integer');
    }

    return Math.min(100, Math.floor(parsed));
  }

  private parseStatusFilter(value: string | string[] | undefined) {
    const raw = this.firstQueryValue(value)?.trim().toUpperCase();
    if (!raw) return null;

    if (!Object.values(PaymentStatus).includes(raw as PaymentStatus)) {
      throw new BadRequestException(
        'status must be one of CREATED, PENDING, PAID, FAILED, CANCELLED',
      );
    }

    return raw as PaymentStatus;
  }

  private parseGatewayFilter(value: string | string[] | undefined) {
    const raw = this.firstQueryValue(value)?.trim().toUpperCase();
    if (!raw) return null;

    if (!Object.values(GatewayProvider).includes(raw as GatewayProvider)) {
      throw new BadRequestException(
        `gateway must be one of ${Object.values(GatewayProvider).join(', ')}`,
      );
    }

    return raw as GatewayProvider;
  }

  private parseCreatedAtFilter(
    fromValue: string | string[] | undefined,
    toValue: string | string[] | undefined,
  ) {
    const from = this.parseDateOrDateTime(fromValue, 'from', 'start');
    const to = this.parseDateOrDateTime(toValue, 'to', 'end');

    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be less than or equal to to');
    }

    if (!from && !to) return null;
    return {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  private parseDateOrDateTime(
    rawValue: string | string[] | undefined,
    fieldName: 'from' | 'to',
    edge: 'start' | 'end',
  ) {
    const value = this.firstQueryValue(rawValue)?.trim();
    if (!value) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      if (edge === 'start') {
        return new Date(`${value}T00:00:00.000Z`);
      }
      return new Date(`${value}T23:59:59.999Z`);
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${fieldName} must be an ISO date-time or date (YYYY-MM-DD)`,
      );
    }

    return date;
  }

  private parseCursor(value: string | string[] | undefined) {
    const raw = this.firstQueryValue(value)?.trim();
    if (!raw) return null;

    try {
      const decoded = Buffer.from(raw, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as { id?: string; createdAt?: string };
      if (!parsed.id || !parsed.createdAt) {
        throw new Error('missing fields');
      }

      const createdAt = new Date(parsed.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        throw new Error('invalid createdAt');
      }

      return { id: parsed.id, createdAt };
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }

  private encodeCursor(cursor: { id: string; createdAt: Date }) {
    return Buffer.from(
      JSON.stringify({
        id: cursor.id,
        createdAt: cursor.createdAt.toISOString(),
      }),
    ).toString('base64url');
  }

  async createSubscription(
    merchantIdPlain: string,
    data: CreateSubscriptionDto,
  ) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });

    if (!merchant) throw new NotFoundException('Merchant not found');

    const customerEmail = data?.customerEmail?.trim().toLowerCase();
    if (!customerEmail) {
      throw new BadRequestException('customerEmail is required');
    }

    const amountCents = this.parsePositiveInt(data?.amountCents, 'amountCents');
    const currency =
      typeof data?.currency === 'string' && data.currency.trim()
        ? data.currency.trim().toUpperCase()
        : 'ZAR';

    const interval = this.parseSubscriptionInterval(data?.interval);

    const nextBillingAt = data?.startAt?.trim()
      ? new Date(data.startAt)
      : new Date();

    if (Number.isNaN(nextBillingAt.getTime())) {
      throw new BadRequestException('startAt must be a valid ISO date-time');
    }

    return this.prisma.subscription.create({
      data: {
        merchantId,
        customerEmail,
        amountCents,
        currency,
        interval,
        status: SubscriptionStatus.ACTIVE,
        nextBillingAt,
      },
      select: {
        id: true,
        merchantId: true,
        customerEmail: true,
        amountCents: true,
        currency: true,
        interval: true,
        status: true,
        nextBillingAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async listSubscriptions(merchantIdPlain: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) throw new UnauthorizedException('Invalid API key');

    return this.prisma.subscription.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        merchantId: true,
        customerEmail: true,
        amountCents: true,
        currency: true,
        interval: true,
        status: true,
        nextBillingAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
