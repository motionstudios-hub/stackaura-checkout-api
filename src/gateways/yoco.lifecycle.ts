import { PaymentStatus } from '@prisma/client';
import type { GatewayStatusResult } from './gateway.types';

const normalizeYocoState = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;

const hasValue = (value: unknown) =>
  typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;

export function mapYocoCheckoutStatusToPaymentStatus(args: {
  checkoutStatus: unknown;
  paymentId?: unknown;
  expired?: boolean;
}): PaymentStatus {
  const checkoutStatus = normalizeYocoState(args.checkoutStatus);
  const expired = Boolean(args.expired);
  const hasPaymentId = hasValue(args.paymentId);

  if (checkoutStatus === 'completed' && hasPaymentId) {
    return PaymentStatus.PAID;
  }

  if (expired) {
    return PaymentStatus.CANCELLED;
  }

  if (checkoutStatus === 'created') {
    return PaymentStatus.CREATED;
  }

  if (
    checkoutStatus === 'started' ||
    checkoutStatus === 'processing' ||
    checkoutStatus === 'completed'
  ) {
    return PaymentStatus.PENDING;
  }

  return PaymentStatus.PENDING;
}

export function mapYocoCheckoutStatusToGatewayStatus(args: {
  checkoutStatus: unknown;
  paymentId?: unknown;
  expired?: boolean;
}): GatewayStatusResult['status'] {
  const mapped = mapYocoCheckoutStatusToPaymentStatus(args);
  if (mapped === PaymentStatus.PAID) return 'succeeded';
  if (mapped === PaymentStatus.FAILED || mapped === PaymentStatus.CANCELLED) {
    return 'failed';
  }
  return 'pending';
}

export function mapYocoEventToPaymentStatus(args: {
  eventType?: unknown;
  paymentStatus?: unknown;
}): PaymentStatus | null {
  const eventType = normalizeYocoState(args.eventType);
  const paymentStatus = normalizeYocoState(args.paymentStatus);

  if (eventType === 'payment.succeeded' || paymentStatus === 'succeeded') {
    return PaymentStatus.PAID;
  }

  if (eventType === 'payment.failed' || paymentStatus === 'failed') {
    return PaymentStatus.FAILED;
  }

  if (eventType === 'payment.cancelled' || paymentStatus === 'cancelled') {
    return PaymentStatus.CANCELLED;
  }

  return null;
}
