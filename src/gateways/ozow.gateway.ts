import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import {
  GatewayAdapter,
  GatewayCreatePaymentInput,
  GatewayCreatePaymentResult,
  GatewayRefundInput,
  GatewayRefundResult,
  GatewayStatusResult,
} from './gateway.types';
import {
  buildOzowHashMaterial,
  buildOzowPaymentForm,
  normalizeOzowTransactionReference,
  OZOW_REQUEST_HASH_FIELDS,
  resolveOzowConfig,
  resolveOzowRedirectUrls,
  type ResolvedOzowConfig,
} from './ozow.config';

type OzowStatusLookupArgs = {
  reference: string;
  transactionId?: string | null;
  config?: Record<string, string | boolean | null | undefined>;
};

type OzowTransactionStatus = {
  status: 'pending' | 'succeeded' | 'failed';
  externalReference: string;
  transactionId: string | null;
  providerStatus: string | null;
  providerStatusMessage: string | null;
  amount: string | null;
  currency: string | null;
  raw: unknown;
};

@Injectable()
export class OzowGateway implements GatewayAdapter {
  private readonly logger = new Logger(OzowGateway.name);

  async createPayment(
    input: GatewayCreatePaymentInput,
  ): Promise<GatewayCreatePaymentResult> {
    const config = resolveOzowConfig(this.configOverrides(input.config));
    const redirectUrls = resolveOzowRedirectUrls({
      successUrl: input.metadata?.returnUrl ?? config.successUrl,
      cancelUrl: input.metadata?.cancelUrl ?? config.cancelUrl,
      errorUrl: input.metadata?.errorUrl ?? config.errorUrl,
      notifyUrl: input.metadata?.notifyUrl ?? config.notifyUrl,
    });
    const trackedRedirectUrls = this.decorateRedirectUrls(redirectUrls, {
      reference: input.reference,
      paymentId: input.paymentId,
      gateway: 'OZOW',
    });

    const redirectForm = buildOzowPaymentForm({
      siteCode: config.siteCode,
      privateKey: config.privateKey,
      reference: input.reference,
      amountCents: input.amountCents,
      currency: input.currency,
      bankReference: input.metadata?.bankReference ?? null,
      customer: input.metadata?.customer ?? input.customerEmail ?? null,
      optional1: input.paymentId,
      successUrl: trackedRedirectUrls.successUrl,
      cancelUrl: trackedRedirectUrls.cancelUrl,
      errorUrl: trackedRedirectUrls.errorUrl,
      notifyUrl: trackedRedirectUrls.notifyUrl,
      isTest: config.isTest,
    });

    if (config.source === 'merchant' && config.hasPartialMerchantConfig) {
      this.logger.warn(
        JSON.stringify({
          event: 'ozow.config.partial',
          merchantId: input.merchantId,
          reference: input.reference,
          configSource: config.source,
          modeSource: config.modeSource,
          testMode: config.isTest,
          siteCode: config.siteCode,
          hasPrivateKey: Boolean(config.privateKey),
          hasApiKey: Boolean(config.apiKey),
        }),
      );
    }

    this.logRedirectFormDebug({
      merchantId: input.merchantId,
      reference: input.reference,
      config,
      redirectUrls: trackedRedirectUrls,
      fields: redirectForm.fields,
      privateKey: config.privateKey,
    });

    return {
      redirectUrl: redirectForm.action,
      redirectForm,
      externalReference: normalizeOzowTransactionReference(input.reference),
      raw: {
        transactionReference: redirectForm.fields.TransactionReference ?? null,
        bankReference: redirectForm.fields.BankReference ?? null,
      },
    };
  }

  async getPaymentStatus(
    externalReference: string,
  ): Promise<GatewayStatusResult> {
    const transaction = await this.getTransactionStatus({
      reference: externalReference,
    });

    return {
      status: transaction.status,
      externalReference: transaction.externalReference,
      raw: transaction.raw,
    };
  }

  async refund(_input: GatewayRefundInput): Promise<GatewayRefundResult> {
    throw new NotImplementedException('Ozow refunds not implemented yet');
  }

  async getTransactionStatus(
    args: OzowStatusLookupArgs,
  ): Promise<OzowTransactionStatus> {
    const reference = args.reference?.trim();
    if (!reference) {
      throw new Error('Ozow transaction reference is required');
    }

    const transactionId = args.transactionId?.trim() || null;
    const config = resolveOzowConfig(this.configOverrides(args.config));

    if (!config.siteCode || !config.apiKey) {
      throw new Error('Ozow site code and api key are required');
    }

    const url = new URL(
      transactionId
        ? `${config.apiBaseUrl}/GetTransaction`
        : `${config.apiBaseUrl}/GetTransactionByReference`,
    );
    url.searchParams.set('SiteCode', config.siteCode);
    if (transactionId) {
      url.searchParams.set('TransactionId', transactionId);
    } else {
      url.searchParams.set('TransactionReference', reference);
    }
    if (config.isTest) {
      url.searchParams.set('IsTest', 'true');
    }

    this.logStatusLookupRequest({
      endpoint: url.toString(),
      reference,
      transactionId,
      config,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          ApiKey: config.apiKey,
        },
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'ozow.status_lookup.request_error',
          endpoint: url.toString(),
          configSource: config.source,
          modeSource: config.modeSource,
          testMode: config.isTest,
          reference,
          transactionId,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? (error.stack ?? null) : null,
        }),
      );
      throw error;
    }

    const payload = await this.readJsonOrTextPayload(response);
    if (!response.ok) {
      this.logger.error(
        JSON.stringify({
          event: 'ozow.status_lookup.failed',
          endpoint: url.toString(),
          configSource: config.source,
          modeSource: config.modeSource,
          testMode: config.isTest,
          reference,
          transactionId,
          statusCode: response.status,
          responseBody: this.sanitizeValue(payload),
        }),
      );

      const providerMessage = this.extractProviderErrorMessage(payload);
      throw new Error(
        providerMessage
          ? `Ozow status lookup failed: ${providerMessage}`
          : `Ozow status lookup failed with status ${response.status}`,
      );
    }

    const record = this.pickTransactionRecord(
      payload,
      reference,
      transactionId,
    );
    const providerStatus = this.pickString(record, ['Status']);

    return {
      status: this.mapProviderStatus(providerStatus),
      externalReference:
        this.pickString(record, ['TransactionReference']) ?? reference,
      transactionId: this.pickString(record, ['TransactionId']),
      providerStatus,
      providerStatusMessage: this.pickString(record, ['StatusMessage']),
      amount: this.pickString(record, ['Amount']),
      currency: this.pickString(record, ['CurrencyCode']),
      raw: payload,
    };
  }

  private configOverrides(
    config: Record<string, string | boolean | null | undefined> | undefined,
  ) {
    return {
      ozowSiteCode:
        typeof config?.ozowSiteCode === 'string' ? config.ozowSiteCode : null,
      ozowPrivateKey:
        typeof config?.ozowPrivateKey === 'string'
          ? config.ozowPrivateKey
          : null,
      ozowApiKey:
        typeof config?.ozowApiKey === 'string' ? config.ozowApiKey : null,
      ozowIsTest:
        typeof config?.ozowIsTest === 'boolean' ? config.ozowIsTest : null,
    };
  }

  private decorateRedirectUrls(
    urls: {
      successUrl: string;
      cancelUrl: string;
      errorUrl: string;
      notifyUrl: string;
    },
    params: {
      reference: string;
      paymentId: string;
      gateway: string;
    },
  ) {
    return {
      successUrl: this.appendRedirectTrackingParams(urls.successUrl, params),
      cancelUrl: this.appendRedirectTrackingParams(urls.cancelUrl, params),
      errorUrl: this.appendRedirectTrackingParams(urls.errorUrl, params),
      notifyUrl: this.appendRedirectTrackingParams(urls.notifyUrl, params),
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

  private logStatusLookupRequest(args: {
    endpoint: string;
    reference: string;
    transactionId: string | null;
    config: ResolvedOzowConfig;
  }) {
    if (!this.shouldDebugLog()) {
      return;
    }

    this.logger.log(
      JSON.stringify({
        event: 'ozow.status_lookup.request',
        endpoint: args.endpoint,
        configSource: args.config.source,
        modeSource: args.config.modeSource,
        testMode: args.config.isTest,
        siteCode: args.config.siteCode,
        hasApiKey: Boolean(args.config.apiKey),
        reference: args.reference,
        transactionId: args.transactionId,
      }),
    );
  }

  private logRedirectFormDebug(args: {
    merchantId: string;
    reference: string;
    config: ResolvedOzowConfig;
    redirectUrls: {
      successUrl: string;
      cancelUrl: string;
      errorUrl: string;
      notifyUrl: string;
    };
    fields: Record<string, string>;
    privateKey: string | null;
  }) {
    if (!this.shouldDebugLog()) {
      return;
    }

    const hashMaterial = buildOzowHashMaterial(
      args.fields,
      args.privateKey,
      OZOW_REQUEST_HASH_FIELDS,
    );

    this.logger.log(
      JSON.stringify({
        event: 'ozow.redirect_form.generated',
        endpoint: args.config.paymentUrl,
        merchantId: args.merchantId,
        reference: args.reference,
        configSource: args.config.source,
        modeSource: args.config.modeSource,
        testMode: args.config.isTest,
        siteCode: args.config.siteCode,
        hasApiKey: Boolean(args.config.apiKey),
        hasPrivateKey: Boolean(args.config.privateKey),
        hasPartialMerchantConfig: args.config.hasPartialMerchantConfig,
        redirectUrls: args.redirectUrls,
        outboundFields: this.sanitizeOutboundFields(args.fields),
        hashFieldOrder: hashMaterial.orderedFields.map((field) => field.key),
        hashFieldCount: hashMaterial.orderedFields.length,
        hashInputLength: hashMaterial.hashInput.length,
      }),
    );
  }

  private shouldDebugLog() {
    return process.env.OZOW_DEBUG_LOGS?.trim().toLowerCase() === 'true';
  }

  private sanitizeOutboundFields(fields: Record<string, string>) {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (key.toLowerCase() === 'hashcheck' || key.toLowerCase() === 'hash') {
        sanitized[key] = '[generated]';
        continue;
      }

      sanitized[key] = value;
    }

    return sanitized;
  }

  private sanitizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
        const normalizedKey = key.trim().toLowerCase();
        if (
          normalizedKey.includes('apikey') ||
          normalizedKey.includes('privatekey') ||
          normalizedKey === 'hashcheck' ||
          normalizedKey === 'hash'
        ) {
          return [key, '[redacted]'];
        }

        return [key, this.sanitizeValue(nested)];
      }),
    );
  }

  private extractProviderErrorMessage(payload: unknown) {
    if (typeof payload === 'string' && payload.trim()) {
      return payload.trim();
    }

    const record = this.asRecord(payload);
    if (!record) {
      return null;
    }

    return (
      this.pickString(record, ['Message', 'message', 'Error', 'error']) ?? null
    );
  }

  private async readJsonOrTextPayload(response: Response) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) {
      try {
        return (await response.json()) as unknown;
      } catch {
        return null;
      }
    }

    const text = await response.text();
    return text.trim() ? text : null;
  }

  private mapProviderStatus(providerStatus: string | null) {
    const normalized = providerStatus?.trim().toUpperCase();
    if (
      normalized &&
      ['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL', 'PAID'].includes(
        normalized,
      )
    ) {
      return 'succeeded' as const;
    }

    if (
      normalized &&
      ['FAILED', 'FAILURE', 'ERROR', 'DECLINED', 'REJECTED'].includes(
        normalized,
      )
    ) {
      return 'failed' as const;
    }

    return 'pending' as const;
  }

  private pickTransactionRecord(
    payload: unknown,
    reference: string,
    transactionId: string | null,
  ) {
    const records = this.collectRecords(payload);
    if (!records.length) {
      throw new Error('Ozow status lookup returned no transactions');
    }

    const exactMatch = records.find((record) => {
      const recordReference = this.pickString(record, ['TransactionReference']);
      const recordTransactionId = this.pickString(record, ['TransactionId']);
      if (transactionId && recordTransactionId === transactionId) {
        return true;
      }
      return recordReference === reference;
    });

    return exactMatch ?? records[0];
  }

  private collectRecords(payload: unknown) {
    const records: Array<Record<string, unknown>> = [];
    const topLevel = this.asRecord(payload);

    if (Array.isArray(payload)) {
      for (const item of payload) {
        const record = this.asRecord(item);
        if (record) records.push(record);
      }
      return records;
    }

    if (topLevel) {
      records.push(topLevel);

      for (const key of [
        'data',
        'result',
        'results',
        'items',
        'transactions',
      ]) {
        const value = topLevel[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            const record = this.asRecord(item);
            if (record) records.push(record);
          }
        } else {
          const record = this.asRecord(value);
          if (record) records.push(record);
        }
      }
    }

    return records;
  }

  private asRecord(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private pickString(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }

    return null;
  }
}
