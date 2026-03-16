export type GatewayRedirectForm = {
  action: string;
  method: 'POST';
  fields: Record<string, string>;
};

export type GatewayCreatePaymentInput = {
  merchantId: string;
  paymentId: string;
  reference: string;
  amountCents: number;
  currency: string;
  description?: string | null;
  customerEmail?: string | null;
  metadata?: Record<string, string>;
  config?: Record<string, string | boolean | null | undefined>;
};

export type GatewayCreatePaymentResult = {
  redirectUrl: string;
  externalReference?: string | null;
  redirectForm?: GatewayRedirectForm | null;
};

export type GatewayStatusResult = {
  status: 'pending' | 'succeeded' | 'failed';
  externalReference?: string | null;
  raw?: unknown;
};

export type GatewayRefundInput = {
  paymentId: string;
  amountCents?: number;
  reason?: string;
};

export type GatewayRefundResult = {
  success: boolean;
  externalReference?: string | null;
};

export interface GatewayAdapter {
  /**
   * Creates a payment session with the gateway
   * Usually returns a redirect URL
   */
  createPayment(
    input: GatewayCreatePaymentInput,
  ): Promise<GatewayCreatePaymentResult>;

  /**
   * Optional: query gateway for latest payment state
   */
  getPaymentStatus?(externalReference: string): Promise<GatewayStatusResult>;

  /**
   * Optional: perform refund
   */
  refund?(input: GatewayRefundInput): Promise<GatewayRefundResult>;
}
