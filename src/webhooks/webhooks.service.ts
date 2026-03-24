import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  GatewayProvider,
  PaymentStatus,
  PayoutProvider,
  PayoutStatus,
  Prisma,
  WebhookDeliveryStatus,
} from '@prisma/client';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { OzowGateway } from '../gateways/ozow.gateway';
import {
  OZOW_REQUEST_HASH_FIELDS,
  OZOW_RESPONSE_HASH_FIELDS,
  resolveOzowConfig,
} from '../gateways/ozow.config';
import { resolvePaystackConfig } from '../gateways/paystack.config';
import { mapPaystackEventToPaymentStatus } from '../gateways/paystack.lifecycle';
import { YOCO_DEFAULT_WEBHOOK_TOLERANCE_SECONDS } from '../gateways/yoco.config';
import { mapYocoEventToPaymentStatus } from '../gateways/yoco.lifecycle';
import { canTransitionPaymentStatus } from '../payments/payment-status.transitions';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { decryptStoredSecret } from '../security/secrets';

type PayfastPayload = Record<string, string | string[]>;
type NormalizedPayfastPayload = Record<string, string>;
type OzowPayload = Record<string, string | string[]>;
type NormalizedOzowPayload = Record<string, string>;
type PaystackWebhookPayload = Record<string, unknown>;
type PaystackWebhookMeta = {
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: string | Buffer;
  requestId?: string;
};
type YocoWebhookPayload = Record<string, unknown>;
type YocoWebhookMeta = {
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: string | Buffer;
  requestId?: string;
};
type DerivWebhookMeta = {
  signature?: string;
  timestamp?: string;
  rawBody?: string | Buffer;
  requestId?: string;
};

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private deliveryWorkerRunning = false;
  private readonly payoutSelect = {
    id: true,
    merchantId: true,
    reference: true,
    currency: true,
    amountCents: true,
    status: true,
    rail: true,
    provider: true,
    providerRef: true,
    failureCode: true,
    failureMessage: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly ozowGateway: OzowGateway,
  ) {}

  async handlePayfastWebhook(
    payload: PayfastPayload,
    meta: { requestId?: string; rawBody?: string | Buffer } = {},
  ) {
    const requestId = this.resolveRequestId(meta.requestId);
    const normalized = this.normalizePayfastPayload(payload);
    this.logStructured('log', 'webhook.received', {
      requestId,
      provider: 'PAYFAST_ITN',
      mPaymentId: normalized.m_payment_id ?? null,
      paymentStatus: normalized.payment_status ?? null,
      pfPaymentId: normalized.pf_payment_id ?? null,
    });

    const reference = normalized.m_payment_id;
    if (!reference) {
      throw new BadRequestException('Missing m_payment_id');
    }
    this.logStructured('log', 'payfast.itn.reference', {
      requestId,
      mPaymentId: reference,
      pfPaymentId: normalized.pf_payment_id ?? null,
      paymentStatus: normalized.payment_status ?? null,
    });

    const payment = await this.prisma.payment.findUnique({
      where: { reference },
      select: {
        id: true,
        merchantId: true,
        status: true,
        merchant: {
          select: {
            payfastPassphrase: true,
            payfastIsSandbox: true,
          },
        },
      },
    });
    this.logStructured('log', 'payfast.payment_lookup', {
      requestId,
      mPaymentId: reference,
      paymentFound: Boolean(payment),
      paymentId: payment?.id ?? null,
      currentStatus: payment?.status ?? null,
    });

    if (!payment) {
      this.logStructured('warn', 'payment.not_found', {
        requestId,
        provider: 'PAYFAST_ITN',
        reference,
      });
      return { ok: true };
    }

    const payfastPassphrase = decryptStoredSecret(
      payment.merchant.payfastPassphrase,
    );
    this.assertPayfastSignature(
      normalized,
      payfastPassphrase,
      meta.rawBody,
    );
    await this.verifyPayfastPostback(
      normalized,
      payment.merchant.payfastIsSandbox,
    );

    const mappedStatus = this.mapPayfastStatus(normalized.payment_status);
    const providerEventId = this.derivePayfastProviderEventId(normalized);
    const payloadForStorage = JSON.parse(
      JSON.stringify(normalized),
    ) as Prisma.InputJsonValue;
    const outcome = await this.persistAndApplyPayfastWebhook({
      requestId,
      providerEventId,
      paymentReference: reference,
      mappedStatus,
      gatewayRef: normalized.pf_payment_id || null,
      signature: normalized.signature ?? null,
      payload: payloadForStorage,
      rawGateway: payloadForStorage,
    });
    this.logStructured('log', 'payfast.update_result', {
      requestId,
      mPaymentId: reference,
      pfPaymentId: normalized.pf_payment_id ?? null,
      deduplicated: outcome.deduplicated,
      statusChanged: outcome.statusChanged,
      updatedStatus: outcome.updatedPayment?.status ?? null,
      updatedPaymentId: outcome.updatedPayment?.id ?? null,
    });

    if (
      outcome.updatedPayment &&
      outcome.statusChanged &&
      outcome.updatedPayment.status === PaymentStatus.PAID
    ) {
      void this.paymentsService.recordSuccessfulPaymentLedgerByPaymentId(
        outcome.updatedPayment.id,
      );

      void this.deliverEvent(
        outcome.updatedPayment.merchantId,
        'payment_intent.succeeded',
        {
          payment: {
            id: outcome.updatedPayment.id,
            reference: outcome.updatedPayment.reference,
            status: outcome.updatedPayment.status,
          },
        },
      );
    }

    return { ok: true };
  }

  async handleOzowWebhook(
    payload: OzowPayload,
    meta: { requestId?: string } = {},
  ) {
    const requestId = this.resolveRequestId(meta.requestId);
    const normalized = this.normalizeOzowPayload(payload);
    const reference =
      this.getNormalizedPayloadValue(normalized, ['TransactionReference']) ??
      null;
    const paymentId =
      this.getNormalizedPayloadValue(normalized, ['Optional1']) ?? null;
    const transactionId =
      this.getNormalizedPayloadValue(normalized, ['TransactionId']) ?? null;
    const rawStatus =
      this.getNormalizedPayloadValue(normalized, ['Status']) ?? null;

    this.logStructured('log', 'webhook.received', {
      requestId,
      provider: 'OZOW',
      reference,
      paymentId,
      transactionId,
      status: rawStatus,
    });

    if (!reference && !paymentId) {
      throw new BadRequestException('Missing TransactionReference');
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          ...(paymentId ? [{ id: paymentId }] : []),
          ...(reference ? [{ reference }] : []),
        ],
      },
      select: {
        id: true,
        merchantId: true,
        status: true,
        reference: true,
        amountCents: true,
        currency: true,
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

    if (!payment) {
      this.logStructured('warn', 'payment.not_found', {
        requestId,
        provider: 'OZOW',
        reference,
        paymentId,
      });
      return { ok: true };
    }

    const ozowPrivateKey = decryptStoredSecret(payment.merchant.ozowPrivateKey);
    const ozowApiKey = decryptStoredSecret(payment.merchant.ozowApiKey);
    const ozowConfig = resolveOzowConfig({
      ozowSiteCode: payment.merchant.ozowSiteCode,
      ozowPrivateKey,
      ozowApiKey,
      ozowIsTest: payment.merchant.ozowIsTest,
    });

    this.assertOzowSignature(
      normalized,
      ozowConfig.privateKey ?? process.env.OZOW_PRIVATE_KEY ?? null,
      ozowConfig.siteCode,
    );

    const verifiedTransaction = ozowConfig.apiKey
      ? await this.verifyOzowTransactionStatus(
          payment,
          {
            reference: reference ?? payment.reference,
            transactionId,
          },
          ozowConfig,
        )
      : null;

    const mappedStatus = this.mapOzowStatus(
      verifiedTransaction?.providerStatus ?? rawStatus,
    );
    const providerEventId = this.deriveOzowProviderEventId(normalized);
    const payloadForStorage = JSON.parse(
      JSON.stringify(normalized),
    ) as Prisma.InputJsonValue;
    const outcome = await this.persistAndApplyOzowWebhook({
      requestId,
      providerEventId,
      paymentReference: payment.reference,
      mappedStatus,
      gatewayRef: transactionId,
      signature:
        this.getNormalizedPayloadValue(normalized, ['HashCheck', 'Hash']) ??
        null,
      payload: payloadForStorage,
      rawGateway: this.mergeJsonObjects(payment.rawGateway, {
        provider: 'OZOW',
        callback: payloadForStorage,
        ...(verifiedTransaction
          ? {
              statusLookup: {
                checkedAt: new Date().toISOString(),
                status: verifiedTransaction.providerStatus,
                statusMessage: verifiedTransaction.providerStatusMessage,
                transactionId: verifiedTransaction.transactionId,
                amount: verifiedTransaction.amount,
                currency: verifiedTransaction.currency,
                raw: verifiedTransaction.raw,
              },
            }
          : {}),
      }),
    });

    const paidPaymentId =
      mappedStatus === PaymentStatus.PAID &&
      (outcome.updatedPayment?.status === PaymentStatus.PAID ||
        payment.status === PaymentStatus.PAID)
        ? (outcome.updatedPayment?.id ?? payment.id)
        : null;

    if (paidPaymentId) {
      void this.paymentsService.recordSuccessfulPaymentLedgerByPaymentId(
        paidPaymentId,
      );
      void this.paymentsService.fulfillPaidSignupPayment(paidPaymentId);
    }

    if (outcome.updatedPayment && outcome.statusChanged) {
      const eventName = this.paymentStatusToWebhookEvent(
        outcome.updatedPayment.status,
      );
      if (eventName) {
        void this.deliverEvent(outcome.updatedPayment.merchantId, eventName, {
          payment: {
            id: outcome.updatedPayment.id,
            reference: outcome.updatedPayment.reference,
            status: outcome.updatedPayment.status,
          },
        });
      }
    }

    return { ok: true };
  }

  async handlePaystackWebhook(
    body: PaystackWebhookPayload,
    meta: PaystackWebhookMeta = {},
  ) {
    const requestId = this.resolveRequestId(meta.requestId);
    const root = this.asRecord(body) ?? {};
    const data = this.asRecord(root.data);
    const metadata = this.asRecord(data?.metadata);
    const candidates = [metadata ?? {}, data ?? {}, root];

    const eventType = this.extractStringFromCandidates(candidates, ['event']);
    const reference = this.extractStringFromCandidates(candidates, ['reference']);
    const paymentId = this.extractStringFromCandidates(candidates, [
      'paymentId',
      'payment_id',
    ]);
    const providerTransactionId = this.extractStringFromCandidates(candidates, [
      'id',
    ]);
    const providerStatus = this.extractStringFromCandidates(candidates, [
      'status',
    ]);
    const accessCode = this.extractStringFromCandidates(candidates, [
      'access_code',
      'accessCode',
    ]);
    const providerEventId =
      providerTransactionId && eventType
        ? `${eventType}:${providerTransactionId}`
        : reference
          ? `reference:${reference}`
          : null;

    this.logStructured('log', 'webhook.received', {
      requestId,
      provider: 'PAYSTACK',
      providerEventId,
      eventType,
      reference,
      paymentId,
      status: providerStatus,
    });

    if (!reference || !providerEventId) {
      throw new BadRequestException('Missing Paystack reference metadata');
    }

    const normalizedEventType = eventType?.trim().toLowerCase() ?? null;
    if (
      normalizedEventType &&
      normalizedEventType !== 'charge.success' &&
      normalizedEventType !== 'charge.failed'
    ) {
      return { ok: true };
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          ...(paymentId ? [{ id: paymentId }] : []),
          { reference },
        ],
      },
      select: {
        id: true,
        merchantId: true,
        reference: true,
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

    if (!payment) {
      this.logStructured('warn', 'payment.not_found', {
        requestId,
        provider: 'PAYSTACK',
        providerEventId,
        reference,
        paymentId,
      });
      return { ok: true };
    }

    const paystackConfig = resolvePaystackConfig({
      paystackSecretKey: decryptStoredSecret(payment.merchant.paystackSecretKey),
      paystackTestMode: payment.merchant.paystackTestMode,
    });
    const secretKey = paystackConfig.secretKey?.trim() || null;
    if (!secretKey) {
      throw new UnauthorizedException('Paystack secret key is not configured');
    }

    const rawBody = this.stringifyWebhookBody(body, meta.rawBody);
    this.assertPaystackWebhookSignature(meta.headers, rawBody, secretKey);

    const mappedStatus = mapPaystackEventToPaymentStatus({
      eventType: normalizedEventType,
      transactionStatus: providerStatus,
    });

    const payloadForStorage = JSON.parse(
      JSON.stringify(body ?? {}),
    ) as Prisma.InputJsonValue;
    const outcome = await this.persistAndApplyPaystackWebhook({
      requestId,
      providerEventId,
      eventType: normalizedEventType,
      paymentReference: payment.reference,
      mappedStatus,
      accessCode: accessCode ?? payment.gatewayRef ?? null,
      providerTransactionId,
      signature: this.getHeaderValue(meta.headers, 'x-paystack-signature'),
      payload: payloadForStorage,
      rawGateway: this.mergeJsonObjects(payment.rawGateway, {
        provider: 'PAYSTACK',
        paystack: {
          reference: payment.reference,
          accessCode: accessCode ?? payment.gatewayRef ?? null,
          providerStatus,
          eventType: normalizedEventType,
          paidAt: this.extractStringFromCandidates(candidates, [
            'paid_at',
            'paidAt',
          ]),
          channel: this.extractStringFromCandidates(candidates, ['channel']),
          customerEmail: this.extractStringFromCandidates(candidates, [
            'email',
          ]),
          gatewayResponse: this.extractStringFromCandidates(candidates, [
            'gateway_response',
            'gatewayResponse',
            'message',
          ]),
          metadata: metadata ?? null,
          rawEvent: payloadForStorage,
          checkedAt: new Date().toISOString(),
          source: 'webhook',
        },
      }),
    });

    const paidPaymentId =
      mappedStatus === PaymentStatus.PAID &&
      (outcome.updatedPayment?.status === PaymentStatus.PAID ||
        payment.status === PaymentStatus.PAID)
        ? (outcome.updatedPayment?.id ?? payment.id)
        : null;

    if (paidPaymentId) {
      void this.paymentsService.recordSuccessfulPaymentLedgerByPaymentId(
        paidPaymentId,
      );
      void this.paymentsService.fulfillPaidSignupPayment(paidPaymentId);
    }

    if (outcome.updatedPayment && outcome.statusChanged) {
      const eventName = this.paymentStatusToWebhookEvent(
        outcome.updatedPayment.status,
      );
      if (eventName) {
        void this.deliverEvent(outcome.updatedPayment.merchantId, eventName, {
          payment: {
            id: outcome.updatedPayment.id,
            reference: outcome.updatedPayment.reference,
            status: outcome.updatedPayment.status,
          },
        });
      }
    }

    return { ok: true };
  }

  async handleYocoWebhook(
    body: YocoWebhookPayload,
    meta: YocoWebhookMeta = {},
  ) {
    const requestId = this.resolveRequestId(meta.requestId);
    const root = this.asRecord(body) ?? {};
    const payload = this.asRecord(root.payload);
    const metadata = this.asRecord(payload?.metadata);
    const candidates = [metadata ?? {}, payload ?? {}, root];

    const providerEventId = this.extractStringFromCandidates(candidates, ['id']);
    const eventType = this.extractStringFromCandidates(candidates, ['type']);
    const checkoutId = this.extractStringFromCandidates(candidates, [
      'checkoutId',
      'checkout_id',
    ]);
    const reference = this.extractStringFromCandidates(candidates, [
      'reference',
      'externalId',
      'external_id',
    ]);
    const paymentId = this.extractStringFromCandidates(candidates, [
      'paymentId',
      'payment_id',
      'clientReferenceId',
      'client_reference_id',
    ]);
    const rawPaymentStatus = this.extractStringFromCandidates(candidates, [
      'status',
    ]);
    const providerPaymentId = this.extractStringFromCandidates(candidates, [
      'paymentId',
      'payment_id',
    ]);
    const mode = this.extractStringFromCandidates(candidates, ['mode']);

    this.logStructured('log', 'webhook.received', {
      requestId,
      provider: 'YOCO',
      providerEventId,
      eventType,
      checkoutId,
      reference,
      paymentId,
      paymentStatus: rawPaymentStatus,
      mode,
    });

    if (!providerEventId) {
      throw new BadRequestException('Missing Yoco event id');
    }

    if (!checkoutId && !reference && !paymentId) {
      throw new BadRequestException(
        'Missing Yoco checkout or payment reference metadata',
      );
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          ...(paymentId ? [{ id: paymentId }] : []),
          ...(reference ? [{ reference }] : []),
          ...(checkoutId ? [{ gatewayRef: checkoutId }] : []),
        ],
      },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        status: true,
        gateway: true,
        gatewayRef: true,
        rawGateway: true,
        merchant: {
          select: {
            yocoWebhookSecret: true,
          },
        },
      },
    });

    if (!payment) {
      this.logStructured('warn', 'payment.not_found', {
        requestId,
        provider: 'YOCO',
        providerEventId,
        checkoutId,
        reference,
        paymentId,
      });
      return { ok: true };
    }

    const webhookSecret =
      decryptStoredSecret(payment.merchant.yocoWebhookSecret)?.trim() ||
      process.env.YOCO_WEBHOOK_SECRET?.trim() ||
      null;
    if (!webhookSecret) {
      throw new UnauthorizedException('Yoco webhook secret is not configured');
    }

    const rawBody = this.stringifyWebhookBody(body, meta.rawBody);
    this.assertYocoWebhookSignature(meta.headers, rawBody, webhookSecret);

    const mappedStatus = mapYocoEventToPaymentStatus({
      eventType,
      paymentStatus: rawPaymentStatus,
    });
    if (!mappedStatus) {
      throw new BadRequestException('Unsupported Yoco payment status');
    }

    const payloadForStorage = JSON.parse(
      JSON.stringify(body ?? {}),
    ) as Prisma.InputJsonValue;
    const outcome = await this.persistAndApplyYocoWebhook({
      requestId,
      providerEventId,
      eventType,
      paymentReference: payment.reference,
      mappedStatus,
      checkoutId: checkoutId ?? payment.gatewayRef ?? null,
      providerPaymentId,
      signature: this.getHeaderValue(meta.headers, 'webhook-signature'),
      payload: payloadForStorage,
      rawGateway: this.mergeJsonObjects(payment.rawGateway, {
        provider: 'YOCO',
        yoco: {
          checkoutId: checkoutId ?? payment.gatewayRef ?? null,
          checkoutStatus: mappedStatus === PaymentStatus.PAID ? 'completed' : null,
          paymentId: providerPaymentId,
          paymentStatus: rawPaymentStatus,
          eventType,
          processingMode: mode,
          metadata: metadata ?? null,
          paymentMethodDetails: this.asRecord(payload?.paymentMethodDetails),
          failureReason:
            this.extractStringFromCandidates(candidates, [
              'failureReason',
              'failure_reason',
              'reason',
              'message',
            ]) ?? null,
          rawEvent: payloadForStorage,
          verified: true,
          checkedAt: new Date().toISOString(),
          source: 'webhook',
        },
      }),
    });

    const paidPaymentId =
      mappedStatus === PaymentStatus.PAID &&
      (outcome.updatedPayment?.status === PaymentStatus.PAID ||
        payment.status === PaymentStatus.PAID)
        ? (outcome.updatedPayment?.id ?? payment.id)
        : null;

    if (paidPaymentId) {
      void this.paymentsService.recordSuccessfulPaymentLedgerByPaymentId(
        paidPaymentId,
      );
      void this.paymentsService.fulfillPaidSignupPayment(paidPaymentId);
    }

    if (outcome.updatedPayment && outcome.statusChanged) {
      const eventName = this.paymentStatusToWebhookEvent(
        outcome.updatedPayment.status,
      );
      if (eventName) {
        void this.deliverEvent(outcome.updatedPayment.merchantId, eventName, {
          payment: {
            id: outcome.updatedPayment.id,
            reference: outcome.updatedPayment.reference,
            status: outcome.updatedPayment.status,
          },
        });
      }
    }

    return { ok: true };
  }

  async handleDerivPaWebhook(
    body: Record<string, unknown>,
    meta: DerivWebhookMeta = {},
  ) {
    const requestId = this.resolveRequestId(meta.requestId);
    this.logStructured('log', 'webhook.received', {
      requestId,
      provider: 'DERIV_PA',
    });

    const secret = process.env.WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new UnauthorizedException('WEBHOOK_SECRET is not set');
    }

    const signature = this.normalizeSignature(meta.signature);
    if (!signature) {
      throw new UnauthorizedException('Missing webhook signature');
    }

    const payload = this.stringifyWebhookBody(body, meta.rawBody);
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    const expectedWithTimestamp =
      meta.timestamp?.trim() && meta.timestamp.trim().length > 0
        ? createHmac('sha256', secret)
            .update(`${meta.timestamp.trim()}.${payload}`)
            .digest('hex')
        : null;

    const isValid =
      this.constantTimeEquals(signature, expected) ||
      (expectedWithTimestamp !== null &&
        this.constantTimeEquals(signature, expectedWithTimestamp));

    if (!isValid) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const candidates = this.derivPayloadCandidates(body);
    const providerEventId = this.extractStringFromCandidates(candidates, [
      'providerEventId',
      'provider_event_id',
      'eventId',
      'event_id',
      'webhookId',
      'webhook_id',
      'id',
    ]);
    if (!providerEventId) {
      throw new BadRequestException('Missing provider event id');
    }

    const reference = this.extractStringFromCandidates(candidates, [
      'reference',
      'merchantReference',
      'merchant_reference',
      'payoutReference',
      'payout_reference',
      'externalReference',
      'external_reference',
    ]);
    if (!reference) {
      throw new BadRequestException('Missing payout reference');
    }

    const rawStatus = this.extractStringFromCandidates(candidates, [
      'status',
      'payoutStatus',
      'payout_status',
      'state',
    ]);
    const mappedStatus = this.mapDerivPayoutStatus(rawStatus);
    if (!mappedStatus) {
      throw new BadRequestException('Missing or invalid payout status');
    }

    const eventType = this.extractStringFromCandidates(candidates, [
      'event',
      'eventType',
      'event_type',
      'type',
    ]);

    const providerRef = this.extractStringFromCandidates(candidates, [
      'providerRef',
      'provider_ref',
      'transactionId',
      'transaction_id',
      'payoutId',
      'payout_id',
      'id',
    ]);

    const failureCode = this.extractStringFromCandidates(candidates, [
      'failureCode',
      'failure_code',
      'errorCode',
      'error_code',
    ]);
    const failureMessage = this.extractStringFromCandidates(candidates, [
      'failureMessage',
      'failure_message',
      'errorMessage',
      'error_message',
      'message',
      'reason',
    ]);

    const payloadForStorage = JSON.parse(
      JSON.stringify(body ?? {}),
    ) as Prisma.InputJsonValue;

    const outcome = await this.persistAndApplyDerivWebhook({
      requestId,
      providerEventId,
      eventType,
      payoutReference: reference,
      mappedStatus,
      providerRef,
      failureCode,
      failureMessage,
      signature,
      payload: payloadForStorage,
    });

    if (outcome.updatedPayout && outcome.statusChanged) {
      const updatedPayout = outcome.updatedPayout;
      const payoutPayload = {
        id: updatedPayout.id,
        merchantId: updatedPayout.merchantId,
        reference: updatedPayout.reference,
        currency: updatedPayout.currency,
        amountCents: updatedPayout.amountCents,
        status: updatedPayout.status,
        rail: updatedPayout.rail,
        provider: updatedPayout.provider,
        providerRef: updatedPayout.providerRef,
        failureCode: updatedPayout.failureCode,
        failureMessage: updatedPayout.failureMessage,
        createdAt: updatedPayout.createdAt,
        updatedAt: updatedPayout.updatedAt,
      };
      void this.deliverEvent(
        updatedPayout.merchantId,
        'payout.updated',
        payoutPayload,
      );
    }

    return { ok: true, deduplicated: outcome.deduplicated };
  }

  private async persistAndApplyDerivWebhook(args: {
    requestId: string;
    providerEventId: string;
    eventType: string | null;
    payoutReference: string;
    mappedStatus: PayoutStatus;
    providerRef: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    signature: string;
    payload: Prisma.InputJsonValue;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingEvent = await tx.webhookEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: 'DERIV_PA',
              providerEventId: args.providerEventId,
            },
          },
          select: { id: true, processedAt: true },
        });

        if (existingEvent?.processedAt) {
          this.logStructured('log', 'webhook.deduplicated', {
            requestId: args.requestId,
            provider: 'DERIV_PA',
            providerEventId: args.providerEventId,
          });
          return {
            deduplicated: true,
            statusChanged: false,
            updatedPayout: null,
          };
        }

        const webhookEventId =
          existingEvent?.id ??
          (
            await tx.webhookEvent.create({
              data: {
                provider: 'DERIV_PA',
                providerEventId: args.providerEventId,
                eventType: args.eventType,
                payoutReference: args.payoutReference,
                payload: args.payload,
                signature: args.signature,
              },
              select: { id: true },
            })
          ).id;

        if (existingEvent?.id) {
          await tx.webhookEvent.update({
            where: { id: existingEvent.id },
            data: {
              eventType: args.eventType,
              payoutReference: args.payoutReference,
              payload: args.payload,
              signature: args.signature,
            },
          });
        }

        const payout = await tx.payout.findUnique({
          where: { reference: args.payoutReference },
          select: this.payoutSelect,
        });

        if (!payout) {
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });
          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayout: null,
          };
        }

        if (!this.canTransitionPayoutStatus(payout.status, args.mappedStatus)) {
          this.logStructured('warn', 'payout.transition_ignored', {
            requestId: args.requestId,
            payoutId: payout.id,
            from: payout.status,
            to: args.mappedStatus,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayout: null,
          };
        }

        const updatedPayout = await tx.payout.update({
          where: { id: payout.id },
          data: {
            status: args.mappedStatus,
            provider: PayoutProvider.DERIV_PA,
            ...(args.providerRef ? { providerRef: args.providerRef } : {}),
            ...(args.mappedStatus === PayoutStatus.FAILED
              ? {
                  failureCode: args.failureCode ?? null,
                  failureMessage: args.failureMessage ?? null,
                }
              : {
                  failureCode: null,
                  failureMessage: null,
                }),
            rawProvider: args.payload,
          },
          select: this.payoutSelect,
        });

        await tx.webhookEvent.update({
          where: { id: webhookEventId },
          data: { processedAt: new Date() },
        });

        return {
          deduplicated: false,
          statusChanged: updatedPayout.status !== payout.status,
          updatedPayout,
        };
      });
    } catch (error) {
      if (this.isWebhookEventDuplicateError(error)) {
        this.logStructured('log', 'webhook.deduplicated', {
          requestId: args.requestId,
          provider: 'DERIV_PA',
          providerEventId: args.providerEventId,
        });
        return {
          deduplicated: true,
          statusChanged: false,
          updatedPayout: null,
        };
      }
      throw error;
    }
  }

  private async persistAndApplyPayfastWebhook(args: {
    requestId: string;
    providerEventId: string;
    paymentReference: string;
    mappedStatus: PaymentStatus;
    gatewayRef: string | null;
    signature: string | null;
    payload: Prisma.InputJsonValue;
    rawGateway: Prisma.InputJsonValue;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingEvent = await tx.webhookEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: 'PAYFAST_ITN',
              providerEventId: args.providerEventId,
            },
          },
          select: { id: true, processedAt: true },
        });

        if (existingEvent?.processedAt) {
          this.logStructured('log', 'webhook.deduplicated', {
            requestId: args.requestId,
            provider: 'PAYFAST_ITN',
            providerEventId: args.providerEventId,
          });
          return {
            deduplicated: true,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const webhookEventId =
          existingEvent?.id ??
          (
            await tx.webhookEvent.create({
              data: {
                provider: 'PAYFAST_ITN',
                providerEventId: args.providerEventId,
                eventType: 'itn',
                payoutReference: args.paymentReference,
                payload: args.payload,
                signature: args.signature,
              },
              select: { id: true },
            })
          ).id;

        if (existingEvent?.id) {
          await tx.webhookEvent.update({
            where: { id: existingEvent.id },
            data: {
              eventType: 'itn',
              payoutReference: args.paymentReference,
              payload: args.payload,
              signature: args.signature,
            },
          });
        }

        const payment = await tx.payment.findUnique({
          where: { reference: args.paymentReference },
          select: {
            id: true,
            merchantId: true,
            reference: true,
            status: true,
          },
        });

        if (!payment) {
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });
          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (
          payment.status === PaymentStatus.PAID &&
          args.mappedStatus === PaymentStatus.PAID
        ) {
          this.logStructured('log', 'payment.idempotent_paid', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (
          payment.status !== args.mappedStatus &&
          !canTransitionPaymentStatus(payment.status, args.mappedStatus)
        ) {
          this.logStructured('warn', 'payment.transition_ignored', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
            from: payment.status,
            to: args.mappedStatus,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: args.mappedStatus,
            gateway: GatewayProvider.PAYFAST,
            gatewayRef: args.gatewayRef,
            rawGateway: args.rawGateway,
          },
          select: { id: true, merchantId: true, reference: true, status: true },
        });
        const targetAttemptStatus = this.mapPaymentStatusToAttemptStatus(
          args.mappedStatus,
        );
        if (
          latestAttempt &&
          targetAttemptStatus &&
          latestAttempt.status !== targetAttemptStatus
        ) {
          await tx.paymentAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: targetAttemptStatus },
            select: { id: true },
          });
        }

        this.logStructured('log', 'payment.updated', {
          requestId: args.requestId,
          paymentId: updatedPayment.id,
          reference: updatedPayment.reference,
          from: payment.status,
          to: updatedPayment.status,
        });

        await tx.webhookEvent.update({
          where: { id: webhookEventId },
          data: { processedAt: new Date() },
        });

        return {
          deduplicated: false,
          statusChanged: updatedPayment.status !== payment.status,
          updatedPayment,
        };
      });
    } catch (error) {
      if (this.isWebhookEventDuplicateError(error)) {
        this.logStructured('log', 'webhook.deduplicated', {
          requestId: args.requestId,
          provider: 'PAYFAST_ITN',
          providerEventId: args.providerEventId,
        });
        return {
          deduplicated: true,
          statusChanged: false,
          updatedPayment: null,
        };
      }
      throw error;
    }
  }

  private async persistAndApplyOzowWebhook(args: {
    requestId: string;
    providerEventId: string;
    paymentReference: string;
    mappedStatus: PaymentStatus;
    gatewayRef: string | null;
    signature: string | null;
    payload: Prisma.InputJsonValue;
    rawGateway: Prisma.InputJsonValue;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingEvent = await tx.webhookEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: 'OZOW',
              providerEventId: args.providerEventId,
            },
          },
          select: { id: true, processedAt: true },
        });

        if (existingEvent?.processedAt) {
          this.logStructured('log', 'webhook.deduplicated', {
            requestId: args.requestId,
            provider: 'OZOW',
            providerEventId: args.providerEventId,
          });
          return {
            deduplicated: true,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const webhookEventId =
          existingEvent?.id ??
          (
            await tx.webhookEvent.create({
              data: {
                provider: 'OZOW',
                providerEventId: args.providerEventId,
                eventType: 'notify',
                payoutReference: args.paymentReference,
                payload: args.payload,
                signature: args.signature,
              },
              select: { id: true },
            })
          ).id;

        if (existingEvent?.id) {
          await tx.webhookEvent.update({
            where: { id: existingEvent.id },
            data: {
              eventType: 'notify',
              payoutReference: args.paymentReference,
              payload: args.payload,
              signature: args.signature,
            },
          });
        }

        const payment = await tx.payment.findUnique({
          where: { reference: args.paymentReference },
          select: { id: true, merchantId: true, reference: true, status: true },
        });

        if (!payment) {
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });
          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (
          payment.status === PaymentStatus.PAID &&
          args.mappedStatus === PaymentStatus.PAID
        ) {
          this.logStructured('log', 'payment.idempotent_paid', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (!canTransitionPaymentStatus(payment.status, args.mappedStatus)) {
          this.logStructured('warn', 'payment.transition_ignored', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
            from: payment.status,
            to: args.mappedStatus,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: args.mappedStatus,
            gateway: GatewayProvider.OZOW,
            gatewayRef: args.gatewayRef,
            rawGateway: args.rawGateway,
          },
          select: { id: true, merchantId: true, reference: true, status: true },
        });
        const targetAttemptStatus = this.mapPaymentStatusToAttemptStatus(
          args.mappedStatus,
        );
        if (
          latestAttempt &&
          targetAttemptStatus &&
          latestAttempt.status !== targetAttemptStatus
        ) {
          await tx.paymentAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: targetAttemptStatus },
            select: { id: true },
          });
        }

        this.logStructured('log', 'payment.updated', {
          requestId: args.requestId,
          paymentId: updatedPayment.id,
          reference: updatedPayment.reference,
          from: payment.status,
          to: updatedPayment.status,
        });

        await tx.webhookEvent.update({
          where: { id: webhookEventId },
          data: { processedAt: new Date() },
        });

        return {
          deduplicated: false,
          statusChanged: updatedPayment.status !== payment.status,
          updatedPayment,
        };
      });
    } catch (error) {
      if (this.isWebhookEventDuplicateError(error)) {
        this.logStructured('log', 'webhook.deduplicated', {
          requestId: args.requestId,
          provider: 'OZOW',
          providerEventId: args.providerEventId,
        });
        return {
          deduplicated: true,
          statusChanged: false,
          updatedPayment: null,
        };
      }
      throw error;
    }
  }

  private async persistAndApplyYocoWebhook(args: {
    requestId: string;
    providerEventId: string;
    eventType: string | null;
    paymentReference: string;
    mappedStatus: PaymentStatus;
    checkoutId: string | null;
    providerPaymentId: string | null;
    signature: string | null;
    payload: Prisma.InputJsonValue;
    rawGateway: Prisma.InputJsonValue;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingEvent = await tx.webhookEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: 'YOCO',
              providerEventId: args.providerEventId,
            },
          },
          select: { id: true, processedAt: true },
        });

        if (existingEvent?.processedAt) {
          this.logStructured('log', 'webhook.deduplicated', {
            requestId: args.requestId,
            provider: 'YOCO',
            providerEventId: args.providerEventId,
          });
          return {
            deduplicated: true,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const webhookEventId =
          existingEvent?.id ??
          (
            await tx.webhookEvent.create({
              data: {
                provider: 'YOCO',
                providerEventId: args.providerEventId,
                eventType: args.eventType,
                payoutReference: args.paymentReference,
                payload: args.payload,
                signature: args.signature,
              },
              select: { id: true },
            })
          ).id;

        if (existingEvent?.id) {
          await tx.webhookEvent.update({
            where: { id: existingEvent.id },
            data: {
              eventType: args.eventType,
              payoutReference: args.paymentReference,
              payload: args.payload,
              signature: args.signature,
            },
          });
        }

        const payment = await tx.payment.findUnique({
          where: { reference: args.paymentReference },
          select: { id: true, merchantId: true, reference: true, status: true },
        });

        if (!payment) {
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });
          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (
          payment.status === PaymentStatus.PAID &&
          args.mappedStatus === PaymentStatus.PAID
        ) {
          this.logStructured('log', 'payment.idempotent_paid', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (!canTransitionPaymentStatus(payment.status, args.mappedStatus)) {
          this.logStructured('warn', 'payment.transition_ignored', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
            from: payment.status,
            to: args.mappedStatus,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            ...(payment.status !== args.mappedStatus
              ? { status: args.mappedStatus }
              : {}),
            gateway: GatewayProvider.YOCO,
            gatewayRef: args.checkoutId ?? undefined,
            rawGateway: args.rawGateway,
          },
          select: { id: true, merchantId: true, reference: true, status: true },
        });
        const targetAttemptStatus = this.mapPaymentStatusToAttemptStatus(
          args.mappedStatus,
        );
        if (
          latestAttempt &&
          targetAttemptStatus &&
          latestAttempt.status !== targetAttemptStatus
        ) {
          await tx.paymentAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: targetAttemptStatus },
            select: { id: true },
          });
        }

        this.logStructured('log', 'payment.updated', {
          requestId: args.requestId,
          paymentId: updatedPayment.id,
          reference: updatedPayment.reference,
          from: payment.status,
          to: updatedPayment.status,
        });

        await tx.webhookEvent.update({
          where: { id: webhookEventId },
          data: { processedAt: new Date() },
        });

        return {
          deduplicated: false,
          statusChanged: args.mappedStatus !== payment.status,
          updatedPayment,
        };
      });
    } catch (error) {
      if (this.isWebhookEventDuplicateError(error)) {
        this.logStructured('log', 'webhook.deduplicated', {
          requestId: args.requestId,
          provider: 'YOCO',
          providerEventId: args.providerEventId,
        });
        return {
          deduplicated: true,
          statusChanged: false,
          updatedPayment: null,
        };
      }
      throw error;
    }
  }

  private async persistAndApplyPaystackWebhook(args: {
    requestId: string;
    providerEventId: string;
    eventType: string | null;
    paymentReference: string;
    mappedStatus: PaymentStatus;
    accessCode: string | null;
    providerTransactionId: string | null;
    signature: string | null;
    payload: Prisma.InputJsonValue;
    rawGateway: Prisma.InputJsonValue;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingEvent = await tx.webhookEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: 'PAYSTACK',
              providerEventId: args.providerEventId,
            },
          },
          select: { id: true, processedAt: true },
        });

        if (existingEvent?.processedAt) {
          this.logStructured('log', 'webhook.deduplicated', {
            requestId: args.requestId,
            provider: 'PAYSTACK',
            providerEventId: args.providerEventId,
          });
          return {
            deduplicated: true,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const webhookEventId =
          existingEvent?.id ??
          (
            await tx.webhookEvent.create({
              data: {
                provider: 'PAYSTACK',
                providerEventId: args.providerEventId,
                eventType: args.eventType,
                payoutReference: args.paymentReference,
                payload: args.payload,
                signature: args.signature,
              },
              select: { id: true },
            })
          ).id;

        if (existingEvent?.id) {
          await tx.webhookEvent.update({
            where: { id: existingEvent.id },
            data: {
              eventType: args.eventType,
              payoutReference: args.paymentReference,
              payload: args.payload,
              signature: args.signature,
            },
          });
        }

        const payment = await tx.payment.findUnique({
          where: { reference: args.paymentReference },
          select: { id: true, merchantId: true, reference: true, status: true },
        });

        if (!payment) {
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });
          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (
          payment.status === PaymentStatus.PAID &&
          args.mappedStatus === PaymentStatus.PAID
        ) {
          this.logStructured('log', 'payment.idempotent_paid', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        if (!canTransitionPaymentStatus(payment.status, args.mappedStatus)) {
          this.logStructured('warn', 'payment.transition_ignored', {
            requestId: args.requestId,
            paymentId: payment.id,
            reference: payment.reference,
            from: payment.status,
            to: args.mappedStatus,
          });
          await tx.webhookEvent.update({
            where: { id: webhookEventId },
            data: { processedAt: new Date() },
          });

          return {
            deduplicated: false,
            statusChanged: false,
            updatedPayment: null,
          };
        }

        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            ...(payment.status !== args.mappedStatus
              ? { status: args.mappedStatus }
              : {}),
            gateway: GatewayProvider.PAYSTACK,
            gatewayRef: args.accessCode ?? undefined,
            rawGateway: args.rawGateway,
          },
          select: { id: true, merchantId: true, reference: true, status: true },
        });
        const targetAttemptStatus = this.mapPaymentStatusToAttemptStatus(
          args.mappedStatus,
        );
        if (
          latestAttempt &&
          targetAttemptStatus &&
          latestAttempt.status !== targetAttemptStatus
        ) {
          await tx.paymentAttempt.update({
            where: { id: latestAttempt.id },
            data: { status: targetAttemptStatus },
            select: { id: true },
          });
        }

        this.logStructured('log', 'payment.updated', {
          requestId: args.requestId,
          paymentId: updatedPayment.id,
          reference: updatedPayment.reference,
          from: payment.status,
          to: updatedPayment.status,
          providerTransactionId: args.providerTransactionId,
        });

        await tx.webhookEvent.update({
          where: { id: webhookEventId },
          data: { processedAt: new Date() },
        });

        return {
          deduplicated: false,
          statusChanged: args.mappedStatus !== payment.status,
          updatedPayment,
        };
      });
    } catch (error) {
      if (this.isWebhookEventDuplicateError(error)) {
        this.logStructured('log', 'webhook.deduplicated', {
          requestId: args.requestId,
          provider: 'PAYSTACK',
          providerEventId: args.providerEventId,
        });
        return {
          deduplicated: true,
          statusChanged: false,
          updatedPayment: null,
        };
      }
      throw error;
    }
  }

  private mergeJsonObjects(
    existing: Prisma.JsonValue | null | undefined,
    patch: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    const existingRecord = this.asRecord(existing);
    return {
      ...(existingRecord ?? {}),
      ...patch,
    } as Prisma.InputJsonObject;
  }

  private async verifyOzowTransactionStatus(
    payment: {
      id: string;
      reference: string;
      amountCents: number;
      currency: string;
    },
    lookup: {
      reference: string;
      transactionId: string | null;
    },
    config: ReturnType<typeof resolveOzowConfig>,
  ) {
    const transaction = await this.ozowGateway.getTransactionStatus({
      reference: lookup.reference,
      transactionId: lookup.transactionId,
      config: {
        ozowSiteCode: config.siteCode,
        ozowApiKey: config.apiKey,
        ozowIsTest: config.isTest,
      },
    });

    if (transaction.externalReference !== lookup.reference) {
      throw new UnauthorizedException('Ozow status lookup reference mismatch');
    }

    if (
      transaction.currency &&
      transaction.currency.trim().toUpperCase() !== payment.currency
    ) {
      throw new UnauthorizedException('Ozow status lookup currency mismatch');
    }

    if (transaction.amount) {
      const parsedAmount = Number(transaction.amount);
      if (
        Number.isFinite(parsedAmount) &&
        Math.round(parsedAmount * 100) !== payment.amountCents
      ) {
        throw new UnauthorizedException('Ozow status lookup amount mismatch');
      }
    }

    return transaction;
  }

  async createWebhookEndpoint(
    merchantId: string,
    body: { url: string; secret?: string; isActive?: boolean },
  ) {
    const merchant = merchantId?.trim();
    const url = body?.url?.trim();
    if (!merchant) throw new BadRequestException('merchantId is required');
    if (!url) throw new BadRequestException('url is required');

    return this.prisma.webhookEndpoint.create({
      data: {
        merchantId: merchant,
        url,
        secret: body.secret?.trim() || randomBytes(24).toString('hex'),
        isActive: body.isActive ?? true,
      },
      select: {
        id: true,
        merchantId: true,
        url: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async listWebhookEndpoints(merchantId: string, active?: boolean) {
    const merchant = merchantId?.trim();
    if (!merchant) throw new BadRequestException('merchantId is required');

    return this.prisma.webhookEndpoint.findMany({
      where: {
        merchantId: merchant,
        ...(active === undefined ? {} : { isActive: active }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        merchantId: true,
        url: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async setWebhookEndpointActive(
    endpointId: string,
    isActive: boolean,
    merchantId?: string,
  ) {
    const id = endpointId?.trim();
    if (!id) throw new BadRequestException('endpointId is required');
    if (merchantId?.trim()) {
      await this.assertWebhookEndpointOwnership(id, merchantId.trim());
    }

    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: { isActive },
      select: {
        id: true,
        merchantId: true,
        url: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async listWebhookDeliveries(
    endpointId: string,
    limit?: number,
    merchantId?: string,
  ) {
    const id = endpointId?.trim();
    if (!id) throw new BadRequestException('endpointId is required');
    if (merchantId?.trim()) {
      await this.assertWebhookEndpointOwnership(id, merchantId.trim());
    }

    const parsedLimit =
      typeof limit === 'number' && Number.isFinite(limit)
        ? Math.floor(limit)
        : 50;
    const take = Math.max(1, Math.min(200, parsedLimit));

    return this.prisma.webhookDelivery.findMany({
      where: { webhookEndpointId: id },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async rotateWebhookEndpointSecret(endpointId: string, merchantId: string) {
    const id = endpointId?.trim();
    if (!id) throw new BadRequestException('endpointId is required');
    const merchant = merchantId?.trim();
    if (!merchant) throw new BadRequestException('merchantId is required');

    await this.assertWebhookEndpointOwnership(id, merchant);
    const secret = randomBytes(24).toString('hex');

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { secret },
      select: {
        id: true,
        merchantId: true,
        url: true,
        isActive: true,
        secret: true,
        updatedAt: true,
      },
    });

    return {
      id: updated.id,
      merchantId: updated.merchantId,
      url: updated.url,
      isActive: updated.isActive,
      secret: updated.secret,
      updatedAt: updated.updatedAt,
    };
  }

  async retryWebhookDelivery(deliveryId: string, merchantId: string) {
    const id = deliveryId?.trim();
    if (!id) throw new BadRequestException('deliveryId is required');
    const merchant = merchantId?.trim();
    if (!merchant) throw new BadRequestException('merchantId is required');

    await this.assertWebhookDeliveryOwnership(id, merchant);
    await this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: WebhookDeliveryStatus.PENDING,
        nextAttemptAt: new Date(),
      },
    });

    return { ok: true, deliveryId: id, status: WebhookDeliveryStatus.PENDING };
  }

  async deliverEvent(
    merchantId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ) {
    const merchant = merchantId?.trim();
    const event = eventName?.trim();
    if (!merchant) throw new BadRequestException('merchantId is required');
    if (!event) throw new BadRequestException('eventName is required');

    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { merchantId: merchant, isActive: true },
      select: { id: true, url: true },
    });

    if (!endpoints.length) return;

    const serializedPayload = JSON.stringify(payload ?? {});
    const persistedPayload = JSON.parse(
      serializedPayload,
    ) as Prisma.InputJsonValue;
    const now = new Date();
    await Promise.all(
      endpoints.map((endpoint) =>
        this.prisma.webhookDelivery.create({
          data: {
            webhookEndpointId: endpoint.id,
            event,
            payload: persistedPayload,
            status: WebhookDeliveryStatus.PENDING,
            attempts: 0,
            nextAttemptAt: now,
          },
        }),
      ),
    );

    this.logStructured('log', 'delivery.enqueued', {
      merchantId: merchant,
      event,
      endpoints: endpoints.length,
    });
  }

  async processPendingDeliveries(
    options: {
      limit?: number;
      concurrency?: number;
      requestId?: string;
    } = {},
  ) {
    if (this.deliveryWorkerRunning) return;
    this.deliveryWorkerRunning = true;
    const requestId = this.resolveRequestId(options.requestId);
    const now = new Date();
    const batchSize =
      options.limit ??
      this.parsePositiveInt(process.env.WEBHOOK_WORKER_BATCH_SIZE, 25);
    const take = Math.max(1, Math.min(200, batchSize));
    const configuredConcurrency = this.parsePositiveInt(
      process.env.WEBHOOK_WORKER_CONCURRENCY,
      5,
    );
    const concurrency = Math.max(
      1,
      Math.min(50, options.concurrency ?? configuredConcurrency),
    );

    try {
      const deliveries = await this.prisma.webhookDelivery.findMany({
        where: {
          status: WebhookDeliveryStatus.PENDING,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        take,
        select: {
          id: true,
          event: true,
          payload: true,
          attempts: true,
          webhookEndpoint: {
            select: {
              id: true,
              merchantId: true,
              url: true,
              isActive: true,
              secret: true,
            },
          },
        },
      });

      await this.processDeliveriesWithConcurrency(
        deliveries.map((delivery) => ({
          id: delivery.id,
          event: delivery.event,
          payload: delivery.payload,
          attempts: delivery.attempts,
          webhookEndpointId: delivery.webhookEndpoint.id,
          merchantId: delivery.webhookEndpoint.merchantId,
          endpointUrl: delivery.webhookEndpoint.url,
          endpointActive: delivery.webhookEndpoint.isActive,
          endpointSecret: delivery.webhookEndpoint.secret,
        })),
        concurrency,
        requestId,
      );
    } finally {
      this.deliveryWorkerRunning = false;
    }
  }

  private async processDeliveriesWithConcurrency(
    deliveries: Array<{
      id: string;
      event: string;
      payload: Prisma.JsonValue;
      attempts: number;
      webhookEndpointId: string;
      merchantId: string;
      endpointUrl: string;
      endpointActive: boolean;
      endpointSecret: string;
    }>,
    concurrency: number,
    requestId: string,
  ) {
    if (deliveries.length === 0) return;

    let index = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, deliveries.length) },
      async () => {
        while (true) {
          const currentIndex = index;
          index += 1;
          if (currentIndex >= deliveries.length) return;

          const delivery = deliveries[currentIndex];
          await this.attemptWebhookDelivery(delivery, requestId);
        }
      },
    );

    await Promise.all(workers);
  }

  private async attemptWebhookDelivery(
    delivery: {
      id: string;
      event: string;
      payload: Prisma.JsonValue;
      attempts: number;
      webhookEndpointId: string;
      merchantId: string;
      endpointUrl: string;
      endpointActive: boolean;
      endpointSecret: string;
    },
    requestId: string,
  ) {
    if (!delivery.endpointActive) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.SKIPPED,
          lastError: 'Endpoint is disabled',
          nextAttemptAt: null,
        },
      });
      this.logStructured('warn', 'delivery.skipped', {
        requestId,
        deliveryId: delivery.id,
        endpointId: delivery.webhookEndpointId,
        merchantId: delivery.merchantId,
        reason: 'endpoint_disabled',
      });
      return;
    }

    const nextAttemptNumber = delivery.attempts + 1;
    this.logStructured('log', 'delivery.attempted', {
      requestId,
      deliveryId: delivery.id,
      endpointId: delivery.webhookEndpointId,
      merchantId: delivery.merchantId,
      attempt: nextAttemptNumber,
    });

    try {
      const body = JSON.stringify({
        deliveryId: delivery.id,
        event: delivery.event,
        attempt: nextAttemptNumber,
        data: delivery.payload ?? {},
      });
      const timestamp = new Date().toISOString();
      const signature = this.signWebhookDelivery(
        delivery.endpointSecret,
        timestamp,
        body,
      );
      const response = await fetch(delivery.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Checkout-Event': delivery.event,
          'X-Checkout-Delivery-Id': delivery.id,
          'X-Checkout-Timestamp': timestamp,
          'X-Checkout-Signature': `sha256=${signature}`,
        },
        body,
      });

      const responseSnippet = await this.readResponseSnippet(response);
      if (response.ok) {
        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: WebhookDeliveryStatus.SUCCESS,
            attempts: nextAttemptNumber,
            lastStatusCode: response.status,
            lastError: responseSnippet,
            nextAttemptAt: null,
          },
        });
        this.logStructured('log', 'delivery.succeeded', {
          requestId,
          deliveryId: delivery.id,
          endpointId: delivery.webhookEndpointId,
          merchantId: delivery.merchantId,
          attempt: nextAttemptNumber,
          statusCode: response.status,
        });
        return;
      }

      const failureMessage = this.formatHttpFailure(
        response.status,
        responseSnippet,
      );
      await this.handleDeliveryFailure({
        requestId,
        deliveryId: delivery.id,
        endpointId: delivery.webhookEndpointId,
        merchantId: delivery.merchantId,
        nextAttemptNumber,
        statusCode: response.status,
        errorMessage: failureMessage,
      });
    } catch (error) {
      await this.handleDeliveryFailure({
        requestId,
        deliveryId: delivery.id,
        endpointId: delivery.webhookEndpointId,
        merchantId: delivery.merchantId,
        nextAttemptNumber,
        statusCode: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleDeliveryFailure(args: {
    requestId: string;
    deliveryId: string;
    endpointId: string;
    merchantId: string;
    nextAttemptNumber: number;
    statusCode: number | null;
    errorMessage: string;
  }) {
    const maxAttempts = this.parsePositiveInt(
      process.env.WEBHOOK_MAX_ATTEMPTS,
      5,
    );

    const isClientError =
      args.statusCode !== null &&
      args.statusCode >= 400 &&
      args.statusCode < 500;

    const shouldRetry = !isClientError && args.nextAttemptNumber < maxAttempts;

    const nextAttemptAt = shouldRetry
      ? this.nextRetryAt(args.nextAttemptNumber)
      : null;

    await this.prisma.webhookDelivery.update({
      where: { id: args.deliveryId },
      data: {
        status: shouldRetry
          ? WebhookDeliveryStatus.PENDING
          : WebhookDeliveryStatus.FAILED,
        attempts: args.nextAttemptNumber,
        lastStatusCode: args.statusCode,
        lastError: args.errorMessage,
        nextAttemptAt,
      },
    });

    this.logStructured(shouldRetry ? 'warn' : 'error', 'delivery.failed', {
      requestId: args.requestId,
      deliveryId: args.deliveryId,
      endpointId: args.endpointId,
      merchantId: args.merchantId,
      attempt: args.nextAttemptNumber,
      statusCode: args.statusCode,
      error: args.errorMessage,
      retryScheduled: shouldRetry,
      nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    });
  }

  private async readResponseSnippet(response: Response) {
    try {
      const text = await response.text();
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized) return null;
      const maxChars = this.parsePositiveInt(
        process.env.WEBHOOK_RESPONSE_SNIPPET_CHARS,
        500,
      );
      return normalized.slice(0, maxChars);
    } catch {
      return null;
    }
  }

  private formatHttpFailure(statusCode: number, snippet: string | null) {
    return snippet ? `HTTP ${statusCode}: ${snippet}` : `HTTP ${statusCode}`;
  }

  private mapPayfastStatus(rawStatus: string | undefined): PaymentStatus {
    const value = rawStatus?.trim().toUpperCase();
    if (value === 'COMPLETE') return PaymentStatus.PAID;
    if (value === 'FAILED') return PaymentStatus.FAILED;
    if (value === 'CANCELLED') return PaymentStatus.CANCELLED;
    return PaymentStatus.PENDING;
  }

  private mapOzowStatus(rawStatus: string | null): PaymentStatus {
    const value = rawStatus?.trim().toUpperCase();
    if (!value) return PaymentStatus.PENDING;

    if (
      ['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL', 'PAID'].includes(value)
    ) {
      return PaymentStatus.PAID;
    }
    if (['CANCELLED', 'CANCELED', 'ABANDONED'].includes(value)) {
      return PaymentStatus.CANCELLED;
    }
    if (
      ['FAILED', 'FAILURE', 'ERROR', 'REJECTED', 'DECLINED'].includes(value)
    ) {
      return PaymentStatus.FAILED;
    }
    return PaymentStatus.PENDING;
  }

  private mapPaymentStatusToAttemptStatus(status: PaymentStatus) {
    if (status === PaymentStatus.PAID) return 'SUCCEEDED';
    if (status === PaymentStatus.FAILED) return 'FAILED';
    if (status === PaymentStatus.CANCELLED) return 'CANCELLED';
    if (status === PaymentStatus.PENDING) return 'PENDING';
    return null;
  }

   private paymentStatusToWebhookEvent(status: PaymentStatus) {
  if (status === PaymentStatus.PAID) return 'payment_intent.succeeded';
  if (status === PaymentStatus.FAILED) return 'payment_intent.failed';
  if (status === PaymentStatus.CANCELLED) return 'payment_intent.cancelled';
  if (status === PaymentStatus.PENDING) return 'payment_intent.processing';
  return null;
}

  private mapDerivPayoutStatus(rawStatus: string | null): PayoutStatus | null {
    const normalized = rawStatus
      ?.trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    if (!normalized) return null;

    if (
      ['PAID', 'SUCCESS', 'SUCCESSFUL', 'COMPLETE', 'COMPLETED'].includes(
        normalized,
      )
    ) {
      return PayoutStatus.SUCCESS;
    }
    if (
      ['PROCESSING', 'PENDING', 'IN_PROGRESS', 'INPROGRESS'].includes(
        normalized,
      )
    ) {
      return PayoutStatus.PENDING;
    }
    if (
      ['FAILED', 'FAILURE', 'ERROR', 'DECLINED', 'REJECTED'].includes(
        normalized,
      )
    ) {
      return PayoutStatus.FAILED;
    }
    if (['CANCELLED', 'CANCELED', 'VOIDED', 'REVERSED'].includes(normalized)) {
      return PayoutStatus.FAILED;
    }
    if (['CREATED', 'INITIATED', 'NEW'].includes(normalized)) {
      return PayoutStatus.CREATED;
    }
    return null;
  }

  private canTransitionPayoutStatus(current: PayoutStatus, next: PayoutStatus) {
    if (current === next) return true;
    if (current === PayoutStatus.CREATED && next === PayoutStatus.PENDING) {
      return true;
    }
    if (
      current === PayoutStatus.PENDING &&
      (next === PayoutStatus.SUCCESS || next === PayoutStatus.FAILED)
    ) {
      return true;
    }
    return false;
  }

  private isWebhookEventDuplicateError(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code !== 'P2002') return false;

    const target = error.meta?.target;
    const values =
      typeof target === 'string'
        ? [target]
        : Array.isArray(target)
          ? target.map((item) => String(item))
          : [];

    return values.some(
      (value) =>
        value.includes('providerEventId') ||
        value.includes('provider_providerEventId') ||
        value.includes('WebhookEvent'),
    );
  }

  private derivPayloadCandidates(body: Record<string, unknown>) {
    const candidates: Record<string, unknown>[] = [body];
    const data = this.asRecord(body.data);
    if (data) candidates.push(data);

    const payout = this.asRecord(body.payout);
    if (payout) candidates.push(payout);

    if (data) {
      const nestedPayout = this.asRecord(data.payout);
      if (nestedPayout) candidates.push(nestedPayout);
    }

    return candidates;
  }

  private extractStringFromCandidates(
    candidates: Record<string, unknown>[],
    keys: string[],
  ) {
    for (const key of keys) {
      for (const candidate of candidates) {
        const value = candidate[key];
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed) return trimmed;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
          return String(value);
        }
      }
    }

    return null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private getNormalizedPayloadValue(
    payload: Record<string, string>,
    keys: string[],
  ) {
    for (const key of keys) {
      const direct = payload[key];
      if (direct?.trim()) return direct.trim();
    }

    const lookup = new Map(
      Object.entries(payload).map(([key, value]) => [key.toLowerCase(), value]),
    );
    for (const key of keys) {
      const fromLookup = lookup.get(key.toLowerCase());
      if (fromLookup?.trim()) return fromLookup.trim();
    }

    return null;
  }

  private encodePayfast(value: string) {
    return encodeURIComponent(value)
      .replace(/%20/g, '+')
      .replace(/%[0-9a-f]{2}/gi, (match) => match.toUpperCase());
  }

  private normalizeOzowPayload(payload: OzowPayload): NormalizedOzowPayload {
    const normalized: NormalizedOzowPayload = {};

    for (const [key, value] of Object.entries(payload ?? {})) {
      const rawValue = Array.isArray(value) ? value[0] : value;
      if (rawValue === undefined || rawValue === null) continue;
      normalized[key] = String(rawValue).trim();
    }

    return normalized;
  }

  private computeOzowHashCheck(
    payload: NormalizedOzowPayload,
    privateKey: string | null | undefined,
    orderedKeys: readonly string[],
  ) {
    const normalizedPrivateKey = privateKey?.trim();
    if (!normalizedPrivateKey) {
      throw new UnauthorizedException(
        'Merchant Ozow credentials not configured',
      );
    }

    const joined = orderedKeys
      .map((key) => this.getNormalizedPayloadValue(payload, [key]))
      .filter((value) => value !== null && value !== '')
      .join('');

    return createHash('sha512')
      .update(`${joined}${normalizedPrivateKey}`.toLowerCase())
      .digest('hex');
  }

  private assertOzowSignature(
    payload: NormalizedOzowPayload,
    privateKey: string | null | undefined,
    siteCode?: string | null,
  ) {
    const received =
      this.getNormalizedPayloadValue(payload, ['HashCheck', 'Hash'])
        ?.trim()
        .toLowerCase() ?? '';

    if (siteCode?.trim()) {
      const incomingSiteCode =
        this.getNormalizedPayloadValue(payload, ['SiteCode']) ?? null;
      if (incomingSiteCode !== siteCode.trim()) {
        throw new UnauthorizedException('Unexpected Ozow site code');
      }
    }

    const expectedResponse = this.computeOzowHashCheck(
      payload,
      privateKey,
      OZOW_RESPONSE_HASH_FIELDS,
    ).toLowerCase();
    const expectedRequest = this.computeOzowHashCheck(
      payload,
      privateKey,
      OZOW_REQUEST_HASH_FIELDS,
    ).toLowerCase();
    const isValid =
      !!received &&
      (this.constantTimeEquals(received, expectedResponse) ||
        this.constantTimeEquals(received, expectedRequest));
    if (!isValid) {
      throw new UnauthorizedException('Invalid signature');
    }
  }

  private deriveOzowProviderEventId(payload: NormalizedOzowPayload) {
    const transactionId = this.getNormalizedPayloadValue(payload, [
      'TransactionId',
    ]);
    if (transactionId) return `transaction_id:${transactionId}`;

    const hashFields = new Set(['hash', 'hashcheck']);
    const canonical = Object.entries(payload)
      .filter(([key]) => !hashFields.has(key.toLowerCase()))
      .map(([key, value]) => [key, value.trim()] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    const reference =
      this.getNormalizedPayloadValue(payload, ['TransactionReference']) ?? '';
    const status = this.getNormalizedPayloadValue(payload, ['Status']) ?? '';

    const digest = createHash('sha256')
      .update(`${canonical}|${reference}|${status}`)
      .digest('hex');
    return `hash:${digest}`;
  }

  private normalizePayfastPayload(
    payload: PayfastPayload,
  ): NormalizedPayfastPayload {
    const normalized: NormalizedPayfastPayload = {};

    for (const [key, value] of Object.entries(payload ?? {})) {
      const rawValue = Array.isArray(value) ? value[0] : value;
      if (rawValue === undefined || rawValue === null) continue;
      normalized[key] = String(rawValue).trim();
    }

    return normalized;
  }

  private normalizePayfastEntries(payload: NormalizedPayfastPayload) {
    return Object.entries(payload)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value).trim()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }

  private buildPayfastParamString(
    payload: NormalizedPayfastPayload,
    options: { includeSignature: boolean },
  ) {
    return this.normalizePayfastEntries(payload)
      .filter(([key]) => options.includeSignature || key !== 'signature')
      .map(([key, value]) => `${key}=${this.encodePayfast(value)}`)
      .join('&');
  }

  private computePayfastSignature(
    payload: NormalizedPayfastPayload,
    passphrase?: string | null,
    rawBody?: string | Buffer,
  ) {
    const rawBodyString = this.normalizeRawBodyString(rawBody);
    const signatureBaseString = this.payfastSignatureBaseString(
      payload,
      passphrase,
      rawBodyString,
    );
    return createHash('md5').update(signatureBaseString).digest('hex');
  }

  private assertPayfastSignature(
    payload: NormalizedPayfastPayload,
    passphrase?: string | null,
    rawBody?: string | Buffer,
  ) {
    const rawBodyString = this.normalizeRawBodyString(rawBody);
    const parsedParams =
      rawBodyString !== null
        ? this.parsePayfastParamsFromRawBody(rawBodyString)
        : Object.fromEntries(
            Object.entries(payload).filter(([key]) => key !== 'signature'),
          );
    const received = payload?.signature?.trim().toLowerCase();
    const signatureBaseString = this.payfastSignatureBaseString(
      payload,
      passphrase,
      rawBodyString,
    );
    const expected = createHash('md5')
      .update(signatureBaseString)
      .digest('hex')
      .toLowerCase();

    this.logStructured('log', 'payfast.signature.debug', {
      rawBody: rawBodyString,
      parsedParams,
      signatureBaseString,
      computedSignature: expected,
      receivedSignature: received ?? null,
    });

    if (!received || !this.constantTimeEquals(received, expected)) {
      throw new UnauthorizedException('Invalid signature');
    }
  }

  private payfastSignatureBaseString(
    payload: NormalizedPayfastPayload,
    passphrase?: string | null,
    rawBodyString?: string | null,
  ) {
    if (rawBodyString) {
      const fromRawBody = this.payfastSignatureBaseFromRawBody(
        rawBodyString,
        passphrase,
      );
      if (fromRawBody) return fromRawBody;
    }
    return this.payfastSignatureBaseFromPayload(payload, passphrase);
  }

  private payfastSignatureBaseFromPayload(
    payload: NormalizedPayfastPayload,
    passphrase?: string | null,
  ) {
    const entries = Object.entries(payload)
      .filter(([key]) => key.toLowerCase() !== 'signature')
      .map(
        ([key, value]) => `${key}=${this.encodePayfast(String(value).trim())}`,
      );
    const normalizedPassphrase = passphrase?.trim();
    if (normalizedPassphrase) {
      entries.push(`passphrase=${this.encodePayfast(normalizedPassphrase)}`);
    }
    return entries.join('&');
  }

  private payfastSignatureBaseFromRawBody(
    rawBodyString: string,
    passphrase?: string | null,
  ) {
    const segments = rawBodyString
      .split('&')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (!segments.length) return null;

    const filtered = segments.filter((segment) => {
      const [rawKey] = segment.split('=', 1);
      return rawKey.trim().toLowerCase() !== 'signature';
    });
    const normalizedPassphrase = passphrase?.trim();
    if (normalizedPassphrase) {
      filtered.push(`passphrase=${this.encodePayfast(normalizedPassphrase)}`);
    }

    return filtered.join('&');
  }

  private parsePayfastParamsFromRawBody(rawBodyString: string) {
    const entries = rawBodyString
      .split('&')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        const separatorIndex = segment.indexOf('=');
        const rawKey =
          separatorIndex === -1 ? segment : segment.slice(0, separatorIndex);
        const rawValue =
          separatorIndex === -1 ? '' : segment.slice(separatorIndex + 1);
        return [rawKey, rawValue] as const;
      })
      .filter(([rawKey]) => rawKey.trim().toLowerCase() !== 'signature')
      .map(
        ([rawKey, rawValue]) =>
          [
            this.decodeFormUrlComponent(rawKey),
            this.decodeFormUrlComponent(rawValue),
          ] as const,
      );
    return Object.fromEntries(entries);
  }

  private normalizeRawBodyString(rawBody?: string | Buffer) {
    if (typeof rawBody === 'string') return rawBody;
    if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
    return null;
  }

  private decodeFormUrlComponent(value: string) {
    const normalized = value.replace(/\+/g, '%20');
    try {
      return decodeURIComponent(normalized);
    } catch {
      return value;
    }
  }

  private async verifyPayfastPostback(
    payload: NormalizedPayfastPayload,
    isSandbox: boolean,
  ) {
    if (process.env.PAYFAST_VERIFY_POSTBACK?.trim().toLowerCase() === 'false') {
      if (process.env.NODE_ENV?.trim().toLowerCase() === 'production') {
        throw new UnauthorizedException(
          'PAYFAST_VERIFY_POSTBACK=false is not allowed in production',
        );
      }
      return;
    }

    const verifyUrl = this.payfastValidateUrl(isSandbox);
    const timeoutMs = this.parsePositiveInt(
      process.env.PAYFAST_VERIFY_TIMEOUT_MS,
      5000,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: this.buildPayfastParamString(payload, { includeSignature: true }),
        signal: controller.signal,
      });

      const text = (await response.text()).trim().toUpperCase();
      if (!response.ok || text !== 'VALID') {
        throw new UnauthorizedException('Invalid postback');
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid postback');
    } finally {
      clearTimeout(timeout);
    }
  }

  private payfastValidateUrl(isSandbox: boolean) {
    return isSandbox
      ? 'https://sandbox.payfast.co.za/eng/query/validate'
      : 'https://www.payfast.co.za/eng/query/validate';
  }

  private parsePositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }

  private nextRetryAt(attemptNumber = 1) {
    const initialDelayMs = this.parsePositiveInt(
      process.env.WEBHOOK_INITIAL_DELAY_MS,
      30_000,
    );
    const maxDelayMs = this.parsePositiveInt(
      process.env.WEBHOOK_MAX_DELAY_MS,
      15 * 60_000,
    );
    const exponentialDelay = Math.min(
      maxDelayMs,
      initialDelayMs * Math.max(1, 2 ** (attemptNumber - 1)),
    );
    const jitterMs = Math.floor(exponentialDelay * 0.2 * Math.random());
    return new Date(Date.now() + exponentialDelay + jitterMs);
  }

  private normalizeSignature(value: string | undefined) {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase().startsWith('sha256=')) {
      return trimmed.slice('sha256='.length);
    }
    return trimmed;
  }

  private stringifyWebhookBody(
    body: Record<string, unknown>,
    rawBody?: string | Buffer,
  ) {
    if (typeof rawBody === 'string') return rawBody;
    if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
    return JSON.stringify(body ?? {});
  }

  private getHeaderValue(
    headers: Record<string, string | string[] | undefined> | undefined,
    key: string,
  ) {
    if (!headers) return null;

    const direct = headers[key];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (Array.isArray(direct) && direct[0]?.trim()) return direct[0].trim();

    const lowerKey = key.toLowerCase();
    for (const [headerKey, value] of Object.entries(headers)) {
      if (headerKey.toLowerCase() !== lowerKey) continue;
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
    }

    return null;
  }

  private assertYocoWebhookSignature(
    headers: Record<string, string | string[] | undefined> | undefined,
    rawBody: string,
    secret: string,
  ) {
    const webhookId = this.getHeaderValue(headers, 'webhook-id');
    const webhookTimestamp = this.getHeaderValue(headers, 'webhook-timestamp');
    const signatureHeader = this.getHeaderValue(headers, 'webhook-signature');

    if (!webhookId || !webhookTimestamp || !signatureHeader) {
      throw new UnauthorizedException('Missing Yoco webhook signature headers');
    }

    const toleranceSeconds = this.parsePositiveInt(
      process.env.YOCO_WEBHOOK_TOLERANCE_SECONDS,
      YOCO_DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    );
    const timestampMs = Number(webhookTimestamp) * 1000;
    if (!Number.isFinite(timestampMs)) {
      throw new UnauthorizedException('Invalid Yoco webhook timestamp');
    }

    if (Math.abs(Date.now() - timestampMs) > toleranceSeconds * 1000) {
      throw new UnauthorizedException('Stale Yoco webhook timestamp');
    }

    const trimmedSecret = secret.trim();
    const secretPayload = trimmedSecret.startsWith('whsec_')
      ? trimmedSecret.slice('whsec_'.length)
      : trimmedSecret;
    const secretBytes = Buffer.from(secretPayload, 'base64');
    const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
    const expectedSignature = createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    const providedSignatures = signatureHeader
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const [, signature] = value.split(',', 2);
        return signature?.trim() ?? null;
      })
      .filter((value): value is string => Boolean(value));

    const hasMatch = providedSignatures.some((signature) =>
      this.constantTimeEquals(signature, expectedSignature),
    );

    if (!hasMatch) {
      throw new UnauthorizedException('Invalid Yoco webhook signature');
    }
  }

  private assertPaystackWebhookSignature(
    headers: Record<string, string | string[] | undefined> | undefined,
    rawBody: string,
    secret: string,
  ) {
    const signature = this.getHeaderValue(headers, 'x-paystack-signature');
    if (!signature) {
      throw new UnauthorizedException('Missing Paystack webhook signature');
    }

    const expected = createHmac('sha512', secret.trim())
      .update(rawBody)
      .digest('hex');

    if (!this.constantTimeEquals(signature, expected)) {
      throw new UnauthorizedException('Invalid Paystack webhook signature');
    }
  }

  private signWebhookDelivery(
    secret: string,
    timestamp: string,
    rawBody: string,
  ) {
    return createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
  }

  private constantTimeEquals(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  private derivePayfastProviderEventId(payload: NormalizedPayfastPayload) {
    const providerRef = payload.pf_payment_id?.trim();
    if (providerRef) return `pf_payment_id:${providerRef}`;

    const canonical = this.buildPayfastParamString(payload, {
      includeSignature: false,
    });
    const digest = createHash('sha256')
      .update(
        `${canonical}|${payload.m_payment_id ?? ''}|${payload.payment_status ?? ''}`,
      )
      .digest('hex');
    return `hash:${digest}`;
  }

  private resolveRequestId(value?: string | null) {
    const requestId = value?.trim();
    if (requestId) return requestId;
    return randomUUID();
  }

  private logStructured(
    level: 'log' | 'warn' | 'error',
    event: string,
    details: Record<string, unknown>,
  ) {
    const payload = JSON.stringify({ event, ...details });
    if (level === 'log') this.logger.log(payload);
    if (level === 'warn') this.logger.warn(payload);
    if (level === 'error') this.logger.error(payload);
  }

  private async assertWebhookEndpointOwnership(
    endpointId: string,
    merchantId: string,
  ) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, merchantId: true },
    });

    if (!endpoint || endpoint.merchantId !== merchantId) {
      throw new NotFoundException('Webhook endpoint not found');
    }
  }

  private async assertWebhookDeliveryOwnership(
    deliveryId: string,
    merchantId: string,
  ) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        webhookEndpoint: { select: { merchantId: true } },
      },
    });

    if (!delivery || delivery.webhookEndpoint.merchantId !== merchantId) {
      throw new NotFoundException('Webhook delivery not found');
    }
  }
}
