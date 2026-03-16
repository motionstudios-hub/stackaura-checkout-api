

import { Injectable, NotImplementedException } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  GatewayAdapter,
  GatewayCreatePaymentInput,
  GatewayCreatePaymentResult,
  GatewayRefundInput,
  GatewayRefundResult,
  GatewayStatusResult,
} from './gateway.types';

@Injectable()
export class PayfastGateway implements GatewayAdapter {
  async createPayment(
    input: GatewayCreatePaymentInput,
  ): Promise<GatewayCreatePaymentResult> {
    const merchantId =
      (typeof input.config?.payfastMerchantId === 'string'
        ? input.config.payfastMerchantId.trim()
        : '') || process.env.PAYFAST_MERCHANT_ID?.trim();
    const merchantKey =
      (typeof input.config?.payfastMerchantKey === 'string'
        ? input.config.payfastMerchantKey.trim()
        : '') || process.env.PAYFAST_MERCHANT_KEY?.trim();

    if (!merchantId || !merchantKey) {
      throw new Error('PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY are required');
    }

    const passphrase =
      (typeof input.config?.payfastPassphrase === 'string'
        ? input.config.payfastPassphrase.trim()
        : '') || process.env.PAYFAST_PASSPHRASE?.trim() || '';
    const isSandbox = this.resolveSandbox(input);

    const returnUrl =
      input.metadata?.returnUrl?.trim() ||
      process.env.PAYFAST_RETURN_URL?.trim() ||
      'http://127.0.0.1:3001/v1/checkout/success';

    const cancelUrl =
      input.metadata?.cancelUrl?.trim() ||
      process.env.PAYFAST_CANCEL_URL?.trim() ||
      'http://127.0.0.1:3001/v1/checkout/cancel';

    const notifyUrl =
      process.env.PAYFAST_NOTIFY_URL?.trim() ||
      'http://127.0.0.1:3001/v1/webhooks/payfast';

    const itemName =
      input.metadata?.itemName?.trim() ||
      input.description?.trim() ||
      `Payment ${input.reference}`;

    const params: Record<string, string> = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url: returnUrl,
      cancel_url: cancelUrl,
      notify_url: notifyUrl,
      m_payment_id: input.reference,
      amount: (input.amountCents / 100).toFixed(2),
      item_name: itemName,
    };

    if (input.customerEmail?.trim()) {
      params.email_address = input.customerEmail.trim();
    }

    const signature = this.generateSignature(params, passphrase || null);
    const query = Object.keys(params)
      .map((key) => `${key}=${this.phpUrlEncode(params[key])}`)
      .join('&');

    return {
      redirectUrl: `${this.processUrl(isSandbox)}?${query}&signature=${signature}`,
      externalReference: input.reference,
    };
  }

  async getPaymentStatus(
    externalReference: string,
  ): Promise<GatewayStatusResult> {
    return {
      status: 'pending',
      externalReference,
      raw: {
        provider: 'PAYFAST',
        note: 'Status polling not implemented yet in Stackaura',
      },
    };
  }

  async refund(_input: GatewayRefundInput): Promise<GatewayRefundResult> {
    throw new NotImplementedException('PayFast refunds not implemented yet');
  }

  private processUrl(isSandbox: boolean) {
    const explicit = process.env.PAYFAST_PROCESS_URL?.trim();
    if (explicit) return explicit;

    return isSandbox
      ? 'https://sandbox.payfast.co.za/eng/process'
      : 'https://www.payfast.co.za/eng/process';
  }

  private resolveSandbox(input: GatewayCreatePaymentInput) {
    if (typeof input.config?.payfastIsSandbox === 'boolean') {
      return input.config.payfastIsSandbox;
    }

    const raw =
      process.env.PAYFAST_IS_SANDBOX?.trim().toLowerCase() ??
      process.env.PAYFAST_SANDBOX?.trim().toLowerCase();

    if (raw === 'true') return true;
    if (raw === 'false') return false;

    if (process.env.PAYFAST_PROCESS_URL?.includes('www.payfast.co.za')) {
      return false;
    }

    if (process.env.PAYFAST_PROCESS_URL?.includes('sandbox.payfast.co.za')) {
      return true;
    }

    return process.env.NODE_ENV !== 'production';
  }

  private phpUrlEncode(value: string) {
    return encodeURIComponent(value)
      .replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      )
      .replace(/%20/g, '+');
  }

  private generateSignature(
    params: Record<string, string>,
    passphrase?: string | null,
  ) {
    const pairs = Object.keys(params)
      .filter((key) => params[key] !== undefined && params[key] !== null)
      .map((key) => `${key}=${this.phpUrlEncode(String(params[key]))}`);

    if (passphrase?.trim()) {
      pairs.push(`passphrase=${this.phpUrlEncode(passphrase.trim())}`);
    }

    return crypto.createHash('md5').update(pairs.join('&')).digest('hex');
  }
}
