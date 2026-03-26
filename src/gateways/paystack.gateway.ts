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
  assertPaystackConfigConsistency,
  resolvePaystackConfig,
  resolvePaystackRedirectUrls,
} from './paystack.config';
import { mapPaystackTransactionStatusToGatewayStatus } from './paystack.lifecycle';

export type PaystackVerifyStatus = {
  reference: string;
  accessCode: string | null;
  providerStatus: string | null;
  gatewayStatus: GatewayStatusResult['status'];
  amount: string | null;
  currency: string | null;
  paidAt: string | null;
  channel: string | null;
  customerEmail: string | null;
  raw: Record<string, unknown>;
};

@Injectable()
export class PaystackGateway implements GatewayAdapter {
  private readonly logger = new Logger(PaystackGateway.name);

  async createPayment(
    input: GatewayCreatePaymentInput,
  ): Promise<GatewayCreatePaymentResult> {
    const config = resolvePaystackConfig(this.configOverrides(input.config));
    assertPaystackConfigConsistency(config);

    if (!config.secretKey) {
      throw new Error('Paystack secretKey is required');
    }

    const customerEmail = input.customerEmail?.trim();
    if (!customerEmail) {
      throw new BadRequestException('Paystack requires customerEmail');
    }

    const currency = input.currency.trim().toUpperCase();
    const redirectUrls = resolvePaystackRedirectUrls({
      callbackUrl: input.metadata?.returnUrl,
      cancelUrl: input.metadata?.cancelUrl,
      errorUrl: input.metadata?.errorUrl,
    });
    const trackedRedirectUrls = this.decorateRedirectUrls(redirectUrls, {
      reference: input.reference,
      paymentId: input.paymentId,
      gateway: 'PAYSTACK',
    });

    const requestPayload = {
      email: customerEmail,
      amount: input.amountCents,
      currency,
      reference: input.reference,
      callback_url: trackedRedirectUrls.callbackUrl,
      metadata: {
        merchantId: input.merchantId,
        paymentId: input.paymentId,
        reference: input.reference,
        cancel_action: trackedRedirectUrls.cancelUrl,
        error_action: trackedRedirectUrls.errorUrl,
        description: input.description?.trim() || null,
      },
    };

    this.logger.log(
      JSON.stringify({
        event: 'paystack.transaction.initialize.request',
        endpoint: config.initializeUrl,
        testMode: config.testMode,
        merchantId: input.merchantId,
        reference: input.reference,
        requestPayload: this.sanitizeValue(requestPayload),
      }),
    );

    const response = await fetch(config.initializeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    const payload = await this.readJsonRecord(response);
    if (!response.ok || payload.status !== true) {
      const message =
        this.pickString(payload, ['message']) ??
        `Paystack initialize failed with status ${response.status}`;
      throw new BadRequestException(`Paystack initialize failed: ${message}`);
    }

    const data = this.asRecord(payload.data);
    const redirectUrl = this.pickString(data, ['authorization_url']);
    const accessCode = this.pickString(data, ['access_code']);
    const reference = this.pickString(data, ['reference']) ?? input.reference;

    if (!redirectUrl) {
      throw new Error(
        'Paystack initialize did not return an authorization_url',
      );
    }

    return {
      redirectUrl,
      externalReference: accessCode,
      raw: {
        reference,
        accessCode,
        authorizationUrl: redirectUrl,
        payload,
      },
    };
  }

  async getPaymentStatus(
    externalReference: string,
    config?: Record<string, string | boolean | null | undefined>,
  ): Promise<GatewayStatusResult> {
    const transaction = await this.verifyTransaction({
      reference: externalReference,
      config,
    });

    return {
      status: transaction.gatewayStatus,
      externalReference: transaction.reference,
      raw: transaction.raw,
    };
  }

  async refund(_input: GatewayRefundInput): Promise<GatewayRefundResult> {
    throw new NotImplementedException('Paystack refunds not implemented yet');
  }

  async verifyTransaction(args: {
    reference: string;
    config?: Record<string, string | boolean | null | undefined>;
  }): Promise<PaystackVerifyStatus> {
    const reference = args.reference?.trim();
    if (!reference) {
      throw new Error('Paystack reference is required');
    }

    const config = resolvePaystackConfig(this.configOverrides(args.config));
    assertPaystackConfigConsistency(config);

    if (!config.secretKey) {
      throw new Error('Paystack secretKey is required');
    }

    const response = await fetch(
      `${config.verifyUrlBase}/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          Accept: 'application/json',
        },
      },
    );

    const payload = await this.readJsonRecord(response);
    if (!response.ok || payload.status !== true) {
      const message =
        this.pickString(payload, ['message']) ??
        `Paystack verify failed with status ${response.status}`;
      throw new BadRequestException(`Paystack verify failed: ${message}`);
    }

    const data = this.asRecord(payload.data);
    const providerStatus = this.pickString(data, ['status']);
    const resolvedReference = this.pickString(data, ['reference']) ?? reference;

    return {
      reference: resolvedReference,
      accessCode: this.pickString(data, ['access_code']),
      providerStatus,
      gatewayStatus:
        mapPaystackTransactionStatusToGatewayStatus(providerStatus),
      amount: this.pickString(data, ['amount']),
      currency: this.pickString(data, ['currency']),
      paidAt: this.pickString(data, ['paid_at', 'paidAt']),
      channel: this.pickString(data, ['channel']),
      customerEmail: this.pickString(this.asRecord(data?.customer), ['email']),
      raw: payload,
    };
  }

  private configOverrides(
    config: Record<string, string | boolean | null | undefined> | undefined,
  ) {
    return {
      paystackSecretKey:
        typeof config?.paystackSecretKey === 'string'
          ? config.paystackSecretKey
          : null,
      paystackTestMode:
        typeof config?.paystackTestMode === 'boolean'
          ? config.paystackTestMode
          : null,
    };
  }

  private decorateRedirectUrls(
    urls: {
      callbackUrl: string;
      cancelUrl: string;
      errorUrl: string;
    },
    params: {
      reference: string;
      paymentId: string;
      gateway: string;
    },
  ) {
    return {
      callbackUrl: this.appendRedirectTrackingParams(urls.callbackUrl, params),
      cancelUrl: this.appendRedirectTrackingParams(urls.cancelUrl, params),
      errorUrl: this.appendRedirectTrackingParams(urls.errorUrl, params),
    };
  }

  private appendRedirectTrackingParams(
    url: string,
    params: {
      reference: string;
      paymentId: string;
      gateway: string;
    },
  ) {
    const resolved = new URL(url);
    resolved.searchParams.set('reference', params.reference);
    resolved.searchParams.set('paymentId', params.paymentId);
    resolved.searchParams.set('gateway', params.gateway);
    return resolved.toString();
  }

  private async readJsonRecord(response: Response) {
    const payload = (await response.json()) as unknown;
    const record = this.asRecord(payload);
    if (!record) {
      throw new Error('Paystack returned an invalid JSON response');
    }
    return record;
  }

  private asRecord(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private pickString(
    record: Record<string, unknown> | null | undefined,
    keys: string[],
  ) {
    if (!record) return null;

    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }

    return null;
  }

  private sanitizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.sanitizeValue(entry));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        key === 'secretKey' ? '[redacted]' : this.sanitizeValue(entry),
      ]),
    );
  }
}
