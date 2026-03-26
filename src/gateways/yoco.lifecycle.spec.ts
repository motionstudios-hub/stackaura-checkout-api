import { PaymentStatus } from '@prisma/client';
import {
  mapYocoCheckoutStatusToGatewayStatus,
  mapYocoCheckoutStatusToPaymentStatus,
  mapYocoEventToPaymentStatus,
} from './yoco.lifecycle';

describe('yoco lifecycle mapping', () => {
  it('maps checkout created to internal CREATED', () => {
    expect(
      mapYocoCheckoutStatusToPaymentStatus({ checkoutStatus: 'created' }),
    ).toBe(PaymentStatus.CREATED);
  });

  it('maps checkout started and processing to internal PENDING', () => {
    expect(
      mapYocoCheckoutStatusToPaymentStatus({ checkoutStatus: 'started' }),
    ).toBe(PaymentStatus.PENDING);
    expect(
      mapYocoCheckoutStatusToPaymentStatus({ checkoutStatus: 'processing' }),
    ).toBe(PaymentStatus.PENDING);
  });

  it('maps completed checkout with payment id to internal PAID', () => {
    expect(
      mapYocoCheckoutStatusToPaymentStatus({
        checkoutStatus: 'completed',
        paymentId: 'pay_123',
      }),
    ).toBe(PaymentStatus.PAID);
  });

  it('maps unresolved expired checkout to internal CANCELLED', () => {
    expect(
      mapYocoCheckoutStatusToPaymentStatus({
        checkoutStatus: 'started',
        expired: true,
      }),
    ).toBe(PaymentStatus.CANCELLED);
  });

  it('maps webhook success and failure states explicitly', () => {
    expect(
      mapYocoEventToPaymentStatus({ eventType: 'payment.succeeded' }),
    ).toBe(PaymentStatus.PAID);
    expect(mapYocoEventToPaymentStatus({ paymentStatus: 'failed' })).toBe(
      PaymentStatus.FAILED,
    );
  });

  it('maps checkout state to gateway lookup state', () => {
    expect(
      mapYocoCheckoutStatusToGatewayStatus({
        checkoutStatus: 'completed',
        paymentId: 'pay_123',
      }),
    ).toBe('succeeded');
    expect(
      mapYocoCheckoutStatusToGatewayStatus({ checkoutStatus: 'processing' }),
    ).toBe('pending');
    expect(
      mapYocoCheckoutStatusToGatewayStatus({
        checkoutStatus: 'started',
        expired: true,
      }),
    ).toBe('failed');
  });
});
