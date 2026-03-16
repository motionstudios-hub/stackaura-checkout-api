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
  OZOW_REQUEST_HASH_FIELDS,
  resolveOzowConfig,
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
    const redirectForm = buildOzowPaymentForm({
      siteCode: config.siteCode,
      privateKey: config.privateKey,
      reference: input.reference,
      amountCents: input.amountCents,
      currency: input.currency,
      bankReference: input.metadata?.bankReference ?? null,
      customer: input.metadata?.customer ?? input.customerEmail ?? null,
      optional1: input.paymentId,
      successUrl: input.metadata?.returnUrl ?? config.successUrl,
      cancelUrl: input.metadata?.cancelUrl ?? config.cancelUrl,
      errorUrl: input.metadata?.errorUrl ?? config.errorUrl,
      notifyUrl: input.metadata?.notifyUrl ?? config.notifyUrl,
      isTest: config.isTest,
    });
    this.logRedirectFormDebug(input.reference, redirectForm.fields, config.privateKey);

    return {
      redirectUrl: redirectForm.action,
      redirectForm,
      externalReference: input.reference,
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

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ApiKey: config.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Ozow status lookup failed with status ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const record = this.pickTransactionRecord(payload, reference, transactionId);
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

  private logRedirectFormDebug(
    reference: string,
    fields: Record<string, string>,
    privateKey: string | null,
  ) {
    const shouldLog =
      process.env.OZOW_DEBUG_LOGS?.trim().toLowerCase() === 'true';
    if (!shouldLog) {
      return;
    }

    const hashMaterial = buildOzowHashMaterial(
      fields,
      privateKey,
      OZOW_REQUEST_HASH_FIELDS,
    );

    this.logger.log(
      JSON.stringify({
        event: 'ozow.redirect_form.generated',
        reference,
        fields,
        hashFieldOrder: hashMaterial.orderedFields.map((field) => field.key),
        hashInput: hashMaterial.hashInput,
        hashCheck: fields.HashCheck,
      }),
    );
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

      for (const key of ['data', 'result', 'results', 'items', 'transactions']) {
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
