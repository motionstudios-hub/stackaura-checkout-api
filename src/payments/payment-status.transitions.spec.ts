import { PaymentStatus } from '@prisma/client';
import { canTransitionPaymentStatus } from './payment-status.transitions';

describe('canTransitionPaymentStatus', () => {
  it('allows duplicate status transitions', () => {
    expect(
      canTransitionPaymentStatus(PaymentStatus.PENDING, PaymentStatus.PENDING),
    ).toBe(true);
  });

  it('rejects illegal transitions from terminal statuses', () => {
    expect(
      canTransitionPaymentStatus(PaymentStatus.PAID, PaymentStatus.FAILED),
    ).toBe(false);
    expect(
      canTransitionPaymentStatus(PaymentStatus.CANCELLED, PaymentStatus.PAID),
    ).toBe(false);
  });

  it('allows monotonic progression to terminal states', () => {
    expect(
      canTransitionPaymentStatus(PaymentStatus.CREATED, PaymentStatus.PENDING),
    ).toBe(true);
    expect(
      canTransitionPaymentStatus(PaymentStatus.PENDING, PaymentStatus.PAID),
    ).toBe(true);
  });
});
