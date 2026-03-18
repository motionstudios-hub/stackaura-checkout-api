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
import { GatewayRegistry } from '../gateways/gateway.registry';
import { OzowGateway } from '../gateways/ozow.gateway';
import { YocoGateway } from '../gateways/yoco.gateway';
import { MerchantsService } from '../merchants/merchants.service';
import {
  OZOW_CANCEL_URL,
  OZOW_ERROR_URL,
  OZOW_NOTIFY_URL,
  OZOW_SUCCESS_URL,
  resolveOzowConfig,
} from '../gateways/ozow.config';
import { resolveYocoConfig } from '../gateways/yoco.config';
import {
  mapYocoCheckoutStatusToPaymentStatus,
  mapYocoEventToPaymentStatus,
} from '../gateways/yoco.lifecycle';
import { canTransitionPaymentStatus } from './payment-status.transitions';
import * as crypto from 'crypto';
import type { PublicOzowSignupInitiateDto } from './ozow.dto';

export type CreatePaymentDto = {
  amountCents: number;
  currency?: string;
  gateway?: string;
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

type CheckoutSelectableGateway = 'AUTO' | 'YOCO' | 'OZOW';

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
      requested !== GatewayProvider.OZOW
    ) {
      throw new BadRequestException(
        'gateway must be one of AUTO, YOCO, OZOW',
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
    };
  }

  private buildRoutingSnapshot(args: {
    requestedGateway: RequestedGateway;
    selectedGateway: GatewayProvider;
    mode: string;
    rankedGateways: Array<{
      gateway: GatewayProvider;
      priority: number;
      reason: string[];
    }>;
  }): Prisma.InputJsonObject {
    return {
      routing: {
        requestedGateway: args.requestedGateway ?? 'AUTO',
        explicitSelection:
          args.requestedGateway !== null && args.requestedGateway !== 'AUTO',
        selectedGateway: args.selectedGateway,
        mode: args.mode,
        rankedGateways: args.rankedGateways.map((candidate) => ({
          gateway: candidate.gateway,
          priority: candidate.priority,
          reason: candidate.reason,
        })),
      },
    } as Prisma.InputJsonObject;
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
    };
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
        gatewayOrder: true,
        platformFeeBps: true,
        platformFeeFixedCents: true,
      },
    });

    if (!merchant) throw new NotFoundException('Merchant not found');

    const ozowConfig = resolveOzowConfig({
      ozowSiteCode: merchant.ozowSiteCode,
      ozowPrivateKey: merchant.ozowPrivateKey,
      ozowApiKey: merchant.ozowApiKey,
      ozowIsTest: merchant.ozowIsTest,
    });
    const yocoConfig = resolveYocoConfig({
      yocoPublicKey: merchant.yocoPublicKey,
      yocoSecretKey: merchant.yocoSecretKey,
      yocoTestMode: merchant.yocoTestMode,
    });

    return {
      ...merchant,
      ozowSiteCode: ozowConfig.siteCode,
      ozowPrivateKey: ozowConfig.privateKey,
      ozowApiKey: ozowConfig.apiKey,
      ozowIsTest: ozowConfig.isTest,
      yocoPublicKey: yocoConfig.publicKey,
      yocoSecretKey: yocoConfig.secretKey,
      yocoTestMode: yocoConfig.testMode,
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
  ) {
    return this.routingEngine.decide({
      requestedGateway,
      merchant,
      mode: 'STRICT_PRIORITY',
      amountCents,
      currency,
    });
  }

  private resolveNextFailoverGateway(args: {
    paymentGateway: GatewayProvider | null;
    attempts: Array<{ gateway: GatewayProvider }>;
    merchant: MerchantGatewayConfig;
    amountCents: number;
    currency: string;
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
    });

    return decision.selectedGateway;
  }


  private computeFeeAndNet(args: {
    amountCents: number;
    platformFeeBps: number;
    platformFeeFixedCents: number;
  }) {
    const bps = Number.isFinite(args.platformFeeBps)
      ? Math.trunc(args.platformFeeBps)
      : 0;
    const fixed = Number.isFinite(args.platformFeeFixedCents)
      ? Math.trunc(args.platformFeeFixedCents)
      : 0;

    const variableFee = Math.round((args.amountCents * bps) / 10000);
    const rawFee = fixed + variableFee;
    const platformFeeCents = Math.max(0, Math.min(args.amountCents, rawFee));
    const merchantNetCents = args.amountCents - platformFeeCents;
    return { platformFeeCents, merchantNetCents };
  }

  private mapPaymentStatusToAttemptStatus(status: PaymentStatus) {
    if (status === PaymentStatus.PAID) return 'SUCCEEDED';
    if (status === PaymentStatus.FAILED) return 'FAILED';
    if (status === PaymentStatus.CANCELLED) return 'CANCELLED';
    if (status === PaymentStatus.PENDING) return 'PENDING';
    return null;
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
    const routingDecision = this.resolveGatewayForCreate(
      requestedGateway,
      merchant,
      amountCents,
      currency,
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
            requestedGateway,
            selectedGateway: gateway,
            mode: routingDecision.mode,
            rankedGateways: routingDecision.rankedGateways,
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
    const { platformFeeCents, merchantNetCents } = this.computeFeeAndNet({
      amountCents,
      platformFeeBps: merchant.platformFeeBps,
      platformFeeFixedCents: merchant.platformFeeFixedCents,
    });
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
    const routingDecision = this.resolveGatewayForCreate(
      requestedGateway,
      merchant,
      amountCents,
      currency,
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

    const gatewaySession = await this.createGatewayRedirect({
      gateway,
      payment,
      merchant,
      itemName: data?.itemName,
      returnUrl: data?.returnUrl,
      cancelUrl: data?.cancelUrl,
      errorUrl: data?.errorUrl,
      notifyUrl: data?.notifyUrl,
      bankReference: data?.bankReference,
    });
    const redirectUrl = gatewaySession.redirectUrl;
    const externalReference = gatewaySession.externalReference ?? null;

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          gatewayRef: externalReference,
          rawGateway: {
            ...this.gatewayRequestSnapshot(gateway, gatewaySession),
            ...this.buildRoutingSnapshot({
              requestedGateway,
              selectedGateway: gateway,
              mode: routingDecision.mode,
              rankedGateways: routingDecision.rankedGateways,
            }),
            ...this.buildCheckoutRequestSnapshot({
              itemName: data?.itemName,
              returnUrl: data?.returnUrl,
              cancelUrl: data?.cancelUrl,
              errorUrl: data?.errorUrl,
              notifyUrl: data?.notifyUrl,
              bankReference: data?.bankReference,
            }),
          },
        },
        select: { id: true },
      }),
      this.prisma.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          gateway,
          status: 'CREATED',
          redirectUrl,
        },
        select: { id: true },
      }),
    ]);
      
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
      redirectForm: gatewaySession.redirectForm ?? null,
      redirectMethod: gatewaySession.redirectForm?.method ?? null,
      gatewayRef: externalReference,
      gateway: payment.gateway || gateway,
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
              requestedGateway: GatewayProvider.OZOW,
              selectedGateway: GatewayProvider.OZOW,
              mode: 'STRICT_PRIORITY',
              rankedGateways: [
                {
                  gateway: GatewayProvider.OZOW,
                  priority: 1,
                  reason: ['explicit_gateway_request'],
                },
              ],
            }),
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
    ];
  }

  async getHostedCheckoutPageContext(checkoutTokenPlain: string) {
    const payment = await this.getHostedCheckoutPaymentRecord(checkoutTokenPlain);
    const merchant = await this.getMerchantGatewayConfig(payment.merchantId);
    const routingState = this.extractStoredRoutingState(payment.rawGateway);
    const selectedGateway = this.coerceCheckoutSelectableGateway(
      routingState.requestedGateway,
    );
    const selectionLocked = selectedGateway !== 'AUTO';
    const readiness = this.routingEngine.getGatewayReadiness({
      merchant,
      mode: 'STRICT_PRIORITY',
      amountCents: payment.amountCents,
      currency: payment.currency,
    });

    let autoSelectedGateway: GatewayProvider | null = null;
    try {
      autoSelectedGateway = this.routingEngine.decide({
        requestedGateway: 'AUTO',
        merchant,
        mode: 'STRICT_PRIORITY',
        amountCents: payment.amountCents,
        currency: payment.currency,
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
    const routingState = this.extractStoredRoutingState(payment.rawGateway);
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

    if (payment.status === PaymentStatus.PAID) {
      throw new BadRequestException('Payment is already paid');
    }

    const routingDecision = this.resolveGatewayForCreate(
      requestedGateway,
      merchant,
      payment.amountCents,
      payment.currency,
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

    const checkoutRequest = this.extractCheckoutRequestContext(payment.rawGateway);
    const gatewaySession = await this.createGatewayRedirect({
      gateway: selectedGateway,
      payment: {
        id: payment.id,
        reference: payment.reference,
        amountCents: payment.amountCents,
        currency: payment.currency,
        description: payment.description,
        customerEmail: payment.customerEmail,
      },
      merchant,
      ...checkoutRequest,
    });
    const redirectUrl = gatewaySession.redirectUrl;
    const externalReference = gatewaySession.externalReference ?? null;

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          gateway: selectedGateway,
          status: 'CREATED',
          redirectUrl,
        },
        select: { id: true },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          gateway: selectedGateway,
          gatewayRef: externalReference,
          status:
            payment.status === PaymentStatus.CREATED
              ? PaymentStatus.CREATED
              : PaymentStatus.PENDING,
          rawGateway: this.mergeGatewayPayload(payment.rawGateway, {
            ...this.gatewayRequestSnapshot(selectedGateway, gatewaySession),
            ...this.buildRoutingSnapshot({
              requestedGateway,
              selectedGateway,
              mode: routingDecision.mode,
              rankedGateways: routingDecision.rankedGateways,
            }),
            ...this.buildCheckoutRequestSnapshot(checkoutRequest),
          }),
        },
        select: { id: true },
      });
    });

    return {
      paymentId: payment.id,
      reference: payment.reference,
      gateway: selectedGateway,
      redirectUrl,
      redirectForm: gatewaySession.redirectForm ?? null,
      redirectMethod: gatewaySession.redirectForm?.method ?? null,
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

    const ozowConfig = resolveOzowConfig({
      ozowSiteCode: payment.merchant.ozowSiteCode,
      ozowPrivateKey: payment.merchant.ozowPrivateKey,
      ozowApiKey: payment.merchant.ozowApiKey,
      ozowIsTest: payment.merchant.ozowIsTest,
    });

    const transaction = await this.ozowGateway.getTransactionStatus({
      reference: payment.reference,
      transactionId: payment.gatewayRef,
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
      gatewayRef: transaction.transactionId ?? payment.gatewayRef,
      amount: transaction.amount,
      currency: transaction.currency,
      synced,
      isTest: ozowConfig.isTest,
      raw: transaction.raw,
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
        const yocoConfig = resolveYocoConfig({
          yocoPublicKey: payment.merchant.yocoPublicKey,
          yocoSecretKey: payment.merchant.yocoSecretKey,
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
            gatewayOrder: true,
            platformFeeBps: true,
            platformFeeFixedCents: true,
          },
        },
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            gateway: true,
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

    const merchantOzowConfig = resolveOzowConfig({
      ozowSiteCode: payment.merchant.ozowSiteCode,
      ozowPrivateKey: payment.merchant.ozowPrivateKey,
      ozowApiKey: payment.merchant.ozowApiKey,
      ozowIsTest: payment.merchant.ozowIsTest,
    });
    const merchantYocoConfig = resolveYocoConfig({
      yocoPublicKey: payment.merchant.yocoPublicKey,
      yocoSecretKey: payment.merchant.yocoSecretKey,
      yocoTestMode: payment.merchant.yocoTestMode,
    });
    const merchantConfig = {
      ...payment.merchant,
      ozowSiteCode: merchantOzowConfig.siteCode,
      ozowPrivateKey: merchantOzowConfig.privateKey,
      ozowApiKey: merchantOzowConfig.apiKey,
      ozowIsTest: merchantOzowConfig.isTest,
      yocoPublicKey: merchantYocoConfig.publicKey,
      yocoSecretKey: merchantYocoConfig.secretKey,
      yocoTestMode: merchantYocoConfig.testMode,
    };

    const nextGateway = this.resolveNextFailoverGateway({
      paymentGateway: payment.gateway ?? null,
      attempts: payment.attempts,
      merchant: merchantConfig,
      amountCents: payment.amountCents,
      currency: payment.currency,
    });

    if (!nextGateway) {
      if (args.failSilently) return null;
      throw new BadRequestException('No failover gateway available');
    }

    const checkoutRequest = this.extractCheckoutRequestContext(payment.rawGateway);
    const gatewaySession = await this.createGatewayRedirect({
      gateway: nextGateway,
      payment,
      merchant: merchantConfig,
      ...checkoutRequest,
    });
    const redirectUrl = gatewaySession.redirectUrl;
    const externalReference = gatewaySession.externalReference ?? null;

    const attempt = await this.prisma.$transaction(async (tx) => {
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
              requestedGateway: 'AUTO',
              selectedGateway: nextGateway,
              mode: 'FAILOVER_PRIORITY',
              rankedGateways: [
                {
                  gateway: nextGateway,
                  priority: 1,
                  reason: ['failover_selected'],
                },
              ],
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

    return {
      ...rest,
      checkoutUrl: `${this.appUrl()}/v1/checkout/${rest.checkoutToken}`,
      // Convenience field for clients: the redirect URL for the latest/current attempt
      redirectUrl: redirectState.redirectUrl,
      redirectForm: redirectState.redirectForm,
      redirectMethod: redirectState.redirectMethod,
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
      return {
        ...payment,
        checkoutUrl: `${this.appUrl()}/v1/checkout/${checkoutToken}`,
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
