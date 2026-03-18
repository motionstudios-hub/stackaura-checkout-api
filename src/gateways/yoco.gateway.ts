import {
  BadRequestException,
  Injectable,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import {
  GatewayAdapter,
  GatewayCreatePaymentInput,
  GatewayCreatePaymentResult,
  GatewayRefundInput,
  GatewayRefundResult,
  GatewayStatusResult,
} from './gateway.types';
import {
  YOCO_WEBHOOKS_API_URL,
  assertYocoConfigConsistency,
  resolveYocoConfig,
} from './yoco.config';
import { mapYocoCheckoutStatusToGatewayStatus } from './yoco.lifecycle';

export type YocoWebhookSubscription = {
  id: string;
  name: string;
  url: string;
  mode: string | null;
  secret: string | null;
  raw: Record<string, unknown>;
};

export type YocoCheckoutStatus = {
  checkoutId: string;
  externalReference: string | null;
  clientReferenceId: string | null;
  paymentId: string | null;
  providerStatus: string | null;
  processingMode: string | null;
  status: GatewayStatusResult['status'];
  raw: Record<string, unknown>;
};

@Injectable()
export class YocoGateway implements GatewayAdapter {
  private readonly logger = new Logger(YocoGateway.name);

  async createPayment(
    input: GatewayCreatePaymentInput,
  ): Promise<GatewayCreatePaymentResult> {
    const config = resolveYocoConfig(this.configOverrides(input.config));
    assertYocoConfigConsistency(config);

    if (!config.publicKey || !config.secretKey) {
      throw new Error('Yoco publicKey and secretKey are required');
    }

    const currency = input.currency.trim().toUpperCase();
    if (currency !== 'ZAR') {
      throw new Error('Yoco currently supports ZAR only');
    }

    if (!Number.isInteger(input.amountCents) || input.amountCents < 200) {
      throw new BadRequestException(
        'Yoco requires amountCents to be at least 200 (R2.00)',
      );
    }

    const requestPayload = {
      amount: input.amountCents,
      currency,
      successUrl:
        input.metadata?.returnUrl?.trim() ?? this.defaultRedirectUrl('success'),
      cancelUrl:
        input.metadata?.cancelUrl?.trim() ?? this.defaultRedirectUrl('cancel'),
      failureUrl:
        input.metadata?.errorUrl?.trim() ?? this.defaultRedirectUrl('error'),
      clientReferenceId: input.paymentId,
      externalId: input.reference,
      metadata: {
        merchantId: input.merchantId,
        paymentId: input.paymentId,
        reference: input.reference,
      },
    };

    this.logger.log(
      JSON.stringify({
        event: 'yoco.checkout.create.request',
        endpoint: config.checkoutApiUrl,
        testMode: config.testMode,
        merchantId: input.merchantId,
        reference: input.reference,
        requestPayload: this.sanitizeValue(requestPayload),
      }),
    );

    let response: Response;
    try {
      response = await fetch(config.checkoutApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Idempotency-Key': input.paymentId,
        },
        body: JSON.stringify(requestPayload),
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'yoco.checkout.create.request_error',
          endpoint: config.checkoutApiUrl,
          testMode: config.testMode,
          merchantId: input.merchantId,
          reference: input.reference,
          requestPayload: this.sanitizeValue(requestPayload),
          errorMessage:
            error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack ?? null : null,
        }),
      );
      throw error;
    }

    if (!response.ok) {
      const responseBody = await this.readJsonOrTextPayload(response);
      const responseHeaders = this.pickResponseHeaders(response.headers);
      this.logger.error(
        JSON.stringify({
          event: 'yoco.checkout.create.failed',
          endpoint: config.checkoutApiUrl,
          testMode: config.testMode,
          merchantId: input.merchantId,
          reference: input.reference,
          statusCode: response.status,
          requestPayload: this.sanitizeValue(requestPayload),
          responseHeaders,
          responseBody: this.sanitizeValue(responseBody),
        }),
      );

      const providerMessage = this.extractProviderErrorMessage(responseBody);
      throw new BadRequestException(
        providerMessage
          ? `Yoco checkout creation failed: ${providerMessage}`
          : `Yoco checkout creation failed with status ${response.status}`,
      );
    }

    const payload = await this.readJsonRecord(response);
    const redirectUrl =
      typeof payload.redirectUrl === 'string' ? payload.redirectUrl.trim() : '';
    const checkoutId = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (!redirectUrl) {
      throw new Error('Yoco checkout did not return a redirectUrl');
    }
    if (!checkoutId) {
      throw new Error('Yoco checkout did not return an id');
    }

    return {
      redirectUrl,
      externalReference: checkoutId,
      raw: payload,
    };
  }

  async getPaymentStatus(
    externalReference: string,
    config?: Record<string, string | boolean | null | undefined>,
  ): Promise<GatewayStatusResult> {
    const checkout = await this.getCheckoutStatus({
      checkoutId: externalReference,
      config,
    });

    return {
      status: checkout.status,
      externalReference: checkout.externalReference ?? checkout.checkoutId,
      raw: checkout.raw,
    };
  }

  async refund(_input: GatewayRefundInput): Promise<GatewayRefundResult> {
    throw new NotImplementedException('Yoco refunds not implemented yet');
  }

  async listWebhookSubscriptions(args: {
    config?: Record<string, string | boolean | null | undefined>;
  }): Promise<YocoWebhookSubscription[]> {
    const config = resolveYocoConfig(this.configOverrides(args.config));
    assertYocoConfigConsistency(config);

    if (!config.secretKey) {
      throw new Error('Yoco secretKey is required');
    }

    const response = await fetch(YOCO_WEBHOOKS_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Yoco webhook listing failed with status ${response.status}: ${
          (await this.readErrorSnippet(response)) ?? 'Unknown error'
        }`,
      );
    }

    const payload = await this.readJsonRecord(response);
    const subscriptions = Array.isArray(payload.subscriptions)
      ? payload.subscriptions
      : [];

    return subscriptions
      .map((subscription) => this.parseWebhookSubscription(subscription, false))
      .filter((subscription): subscription is YocoWebhookSubscription =>
        subscription !== null,
      );
  }

  async registerWebhookSubscription(args: {
    config?: Record<string, string | boolean | null | undefined>;
    name: string;
    url: string;
  }): Promise<YocoWebhookSubscription> {
    const config = resolveYocoConfig(this.configOverrides(args.config));
    assertYocoConfigConsistency(config);

    if (!config.secretKey) {
      throw new Error('Yoco secretKey is required');
    }

    const name = args.name?.trim();
    const url = args.url?.trim();
    if (!name) {
      throw new Error('Yoco webhook name is required');
    }
    if (!url) {
      throw new Error('Yoco webhook url is required');
    }

    const response = await fetch(YOCO_WEBHOOKS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        name,
        url,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Yoco webhook registration failed with status ${response.status}: ${
          (await this.readErrorSnippet(response)) ?? 'Unknown error'
        }`,
      );
    }

    const payload = await this.readJsonRecord(response);
    const subscription = this.parseWebhookSubscription(payload, true);
    if (!subscription || !subscription.secret) {
      throw new Error('Yoco webhook registration did not return a secret');
    }

    return subscription;
  }

  resolveWebhookUrl() {
    const explicit = process.env.YOCO_WEBHOOK_URL?.trim();
    if (explicit) return explicit;

    const baseUrl =
      process.env.APP_URL?.trim() ||
      process.env.PUBLIC_APP_URL?.trim() ||
      'http://127.0.0.1:3001';

    return `${baseUrl.replace(/\/$/, '')}/v1/webhooks/yoco`;
  }

  async getCheckoutStatus(args: {
    checkoutId: string;
    config?: Record<string, string | boolean | null | undefined>;
  }): Promise<YocoCheckoutStatus> {
    const checkoutId = args.checkoutId?.trim();
    if (!checkoutId) {
      throw new Error('Yoco checkout id is required');
    }

    const config = resolveYocoConfig(this.configOverrides(args.config));
    assertYocoConfigConsistency(config);

    if (!config.secretKey) {
      throw new Error('Yoco secretKey is required');
    }

    const response = await fetch(
      `${config.checkoutApiUrl}/${encodeURIComponent(checkoutId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Yoco checkout status lookup failed with status ${response.status}: ${
          (await this.readErrorSnippet(response)) ?? 'Unknown error'
        }`,
      );
    }

    const payload = await this.readJsonRecord(response);
    const providerStatus = this.pickString(payload, ['status']);
    const paymentId = this.pickString(payload, ['paymentId', 'payment_id']);

    return {
      checkoutId:
        this.pickString(payload, ['id', 'checkoutId', 'checkout_id']) ??
        checkoutId,
      externalReference: this.pickString(payload, [
        'externalId',
        'external_id',
      ]),
      clientReferenceId: this.pickString(payload, [
        'clientReferenceId',
        'client_reference_id',
      ]),
      paymentId,
      providerStatus,
      processingMode: this.pickString(payload, [
        'processingMode',
        'processing_mode',
        'mode',
      ]),
      status: mapYocoCheckoutStatusToGatewayStatus({
        checkoutStatus: providerStatus,
        paymentId,
      }),
      raw: payload,
    };
  }

  private configOverrides(
    config: Record<string, string | boolean | null | undefined> | undefined,
  ) {
    return {
      yocoPublicKey:
        typeof config?.yocoPublicKey === 'string' ? config.yocoPublicKey : null,
      yocoSecretKey:
        typeof config?.yocoSecretKey === 'string' ? config.yocoSecretKey : null,
      yocoTestMode:
        typeof config?.yocoTestMode === 'boolean' ? config.yocoTestMode : null,
    };
  }

  private defaultRedirectUrl(
    route: 'success' | 'cancel' | 'error',
  ) {
    const baseUrl =
      process.env.APP_URL?.trim() ||
      process.env.PUBLIC_APP_URL?.trim() ||
      'http://127.0.0.1:3001';

    return `${baseUrl}/v1/checkout/${route}`;
  }

  private async readJsonRecord(response: Response) {
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Yoco API did not return a JSON object');
    }

    return payload as Record<string, unknown>;
  }

  private parseWebhookSubscription(
    payload: unknown,
    requireSecret: boolean,
  ): YocoWebhookSubscription | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    const mode = typeof record.mode === 'string' ? record.mode.trim() : null;
    const secret =
      typeof record.secret === 'string' && record.secret.trim().length > 0
        ? record.secret.trim()
        : null;

    if (!id || !name || !url) {
      return null;
    }
    if (requireSecret && !secret) {
      return null;
    }

    return {
      id,
      name,
      url,
      mode,
      secret,
      raw: record,
    };
  }

  private pickString(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }

    return null;
  }

  private async readJsonOrTextPayload(response: Response) {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json')) {
      try {
        return (await response.json()) as unknown;
      } catch {
        return null;
      }
    }

    try {
      const text = await response.text();
      const normalized = text.trim();
      return normalized || null;
    } catch {
      return null;
    }
  }

  private extractProviderErrorMessage(payload: unknown) {
    if (typeof payload === 'string' && payload.trim()) {
      return payload.trim();
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    for (const key of ['description', 'message', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return null;
  }

  private pickResponseHeaders(headers: Headers) {
    const keys = [
      'content-type',
      'idempotency-key',
      'x-correlation-id',
      'x-request-id',
    ];

    return Object.fromEntries(
      keys
        .map((key) => [key, headers.get(key)] as const)
        .filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
    );
  }

  private sanitizeValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value ?? null;
    }

    if (typeof value === 'string') {
      return value.length > 500 ? `${value.slice(0, 500)}...` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }

    if (typeof value !== 'object') {
      return String(value);
    }

    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entryValue]) => {
        if (['publicKey', 'secretKey', 'apiKey', 'privateKey'].includes(key)) {
          return [key, '<redacted>'];
        }
        return [key, this.sanitizeValue(entryValue)];
      }),
    );
  }

  private async readErrorSnippet(response: Response) {
    try {
      const text = await response.text();
      const normalized = text.replace(/\s+/g, ' ').trim();
      return normalized || null;
    } catch {
      return null;
    }
  }
}
