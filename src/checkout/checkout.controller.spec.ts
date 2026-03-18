import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { CheckoutController } from './checkout.controller';

describe('CheckoutController', () => {
  let controller: CheckoutController;
  let prisma: {
    payment: {
      findFirst: jest.Mock;
    };
    merchant: {
      findUnique: jest.Mock;
    };
    paymentAttempt: {
      findFirst: jest.Mock;
    };
  };
  let paymentsService: {
    autoFailoverByReference: jest.Mock;
    getHostedCheckoutPageContext: jest.Mock;
    continueHostedCheckout: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      payment: {
        findFirst: jest.fn(),
      },
      merchant: {
        findUnique: jest.fn(),
      },
      paymentAttempt: {
        findFirst: jest.fn(),
      },
    };

    paymentsService = {
      autoFailoverByReference: jest.fn(),
      getHostedCheckoutPageContext: jest.fn(),
      continueHostedCheckout: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentsService, useValue: paymentsService },
      ],
    }).compile();

    controller = module.get<CheckoutController>(CheckoutController);
  });

  it('redirects to next gateway on cancel when failover is available', async () => {
    paymentsService.autoFailoverByReference.mockResolvedValue({
      redirectUrl: 'https://www.payfast.co.za/eng/process?x=1',
    });

    const redirect = jest.fn();
    const status = jest.fn();
    const json = jest.fn();
    const res = {
      redirect,
      status,
      json,
    } as unknown as Response;

    await controller.cancel({ m_payment_id: 'INV-1' }, res);

    expect(paymentsService.autoFailoverByReference).toHaveBeenCalledWith(
      'INV-1',
    );
    expect(redirect).toHaveBeenCalledWith(
      302,
      'https://www.payfast.co.za/eng/process?x=1',
    );
    expect(status).not.toHaveBeenCalled();
  });

  it('returns non-redirect payload on error route when failover is unavailable', async () => {
    paymentsService.autoFailoverByReference.mockResolvedValue(null);

    const send = jest.fn();
    const type = jest.fn().mockReturnValue({ send });
    const status = jest.fn().mockReturnValue({ type });
    const res = {
      status,
      type,
      send,
    } as unknown as Response;

    await controller.error({ TransactionReference: 'INV-2' }, res);

    expect(paymentsService.autoFailoverByReference).toHaveBeenCalledWith(
      'INV-2',
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(type).toHaveBeenCalledWith('html');
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Payment failed'));
    expect(send).toHaveBeenCalledWith(expect.stringContaining('INV-2'));
  });

  it('renders payment-specific success copy for normal checkout flows', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      reference: 'INV-success',
      gateway: 'YOCO',
      rawGateway: {
        provider: 'YOCO',
      },
    });

    const send = jest.fn();
    const type = jest.fn().mockReturnValue({ send });
    const status = jest.fn().mockReturnValue({ type });
    const res = {
      status,
      type,
      send,
    } as unknown as Response;

    await controller.success({ reference: 'INV-success' }, res);

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Payment successful'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Your payment was completed successfully.'),
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining('YOCO'));
  });

  it('renders activation-specific success copy for merchant signup flows', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      reference: 'SIGNUP-123',
      gateway: 'OZOW',
      rawGateway: {
        publicFlow: {
          flow: 'merchant_signup',
        },
      },
    });

    const send = jest.fn();
    const type = jest.fn().mockReturnValue({ send });
    const status = jest.fn().mockReturnValue({ type });
    const res = {
      status,
      type,
      send,
    } as unknown as Response;

    await controller.success({ reference: 'SIGNUP-123' }, res);

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Merchant activation successful'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining(
        'Your activation payment was completed successfully.',
      ),
    );
  });

  it('renders payment-specific cancel copy for normal checkout flows without failover', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      reference: 'INV-cancel',
      gateway: 'YOCO',
      rawGateway: {
        provider: 'YOCO',
      },
    });
    paymentsService.autoFailoverByReference.mockResolvedValue(null);

    const send = jest.fn();
    const type = jest.fn().mockReturnValue({ send });
    const status = jest.fn().mockReturnValue({ type });
    const res = {
      status,
      type,
      send,
    } as unknown as Response;

    await controller.cancel({ reference: 'INV-cancel' }, res);

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Payment cancelled'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('The payment was cancelled before completion.'),
    );
  });

  it('renders the hosted checkout page with premium summary details and gateway CTA', async () => {
    paymentsService.getHostedCheckoutPageContext.mockResolvedValue({
      checkoutToken: 'checkout-token-1',
      merchantName: 'Stackaura Labs',
      reference: 'INV-CHECKOUT-1',
      amountCents: 9900,
      currency: 'ZAR',
      status: 'CREATED',
      description: 'Premium infrastructure payment',
      customerEmail: 'buyer@example.com',
      expiresAt: new Date('2026-03-19T10:15:00.000Z'),
      currentGateway: 'YOCO',
      selectedGateway: 'AUTO',
      selectionLocked: false,
      recommendedGateway: 'YOCO',
      gatewayOptions: [
        {
          value: 'AUTO',
          label: 'Auto',
          description: 'Let Stackaura pick the best available rail for this payment.',
          detail: 'Stackaura will start with Yoco.',
          available: true,
          selected: true,
          recommended: true,
          locked: false,
        },
        {
          value: 'YOCO',
          label: 'Yoco',
          description: 'Fast card checkout with Yoco.',
          detail: 'Available for this checkout.',
          available: true,
          selected: false,
          recommended: true,
          locked: false,
        },
        {
          value: 'OZOW',
          label: 'Ozow',
          description: 'Instant EFT checkout with Ozow.',
          detail: 'Available for this checkout.',
          available: true,
          selected: false,
          recommended: false,
          locked: false,
        },
      ],
    });

    const send = jest.fn();
    const type = jest.fn().mockReturnValue({ send });
    const status = jest.fn().mockReturnValue({ type });
    const res = {
      status,
      type,
      send,
    } as unknown as Response;

    await controller.getCheckout('checkout-token-1', res);

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Secure merchant payment handoff'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Stackaura Labs'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Continue with Auto'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Checkout expires in'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('INV-CHECKOUT-1'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('value="YOCO"'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('value="OZOW"'),
    );
  });

  it('shows Yoco as unavailable on hosted checkout when the amount is below minimum', async () => {
    paymentsService.getHostedCheckoutPageContext.mockResolvedValue({
      checkoutToken: 'checkout-token-low',
      merchantName: 'Stackaura Labs',
      reference: 'INV-LOW-1',
      amountCents: 150,
      currency: 'ZAR',
      status: 'CREATED',
      description: 'Low amount payment',
      customerEmail: 'buyer@example.com',
      expiresAt: new Date('2026-03-19T10:15:00.000Z'),
      currentGateway: 'OZOW',
      selectedGateway: 'AUTO',
      selectionLocked: false,
      recommendedGateway: 'OZOW',
      gatewayOptions: [
        {
          value: 'AUTO',
          label: 'Auto',
          description: 'Let Stackaura pick the best available rail for this payment.',
          detail: 'Stackaura will start with Ozow.',
          available: true,
          selected: true,
          recommended: true,
          locked: false,
        },
        {
          value: 'YOCO',
          label: 'Yoco',
          description: 'Fast card checkout with Yoco.',
          detail: 'Yoco requires a minimum amount of 200 cents',
          available: false,
          selected: false,
          recommended: false,
          locked: false,
        },
        {
          value: 'OZOW',
          label: 'Ozow',
          description: 'Instant EFT checkout with Ozow.',
          detail: 'Available for this checkout.',
          available: true,
          selected: false,
          recommended: true,
          locked: false,
        },
      ],
    });

    const send = jest.fn();
    const type = jest.fn().mockReturnValue({ send });
    const status = jest.fn().mockReturnValue({ type });
    const res = {
      status,
      type,
      send,
    } as unknown as Response;

    await controller.getCheckout('checkout-token-low', res);

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Yoco requires a minimum amount of 200 cents'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Gateway unavailable'),
    );
  });

  it('redirects directly for Yoco checkout continuation', async () => {
    paymentsService.continueHostedCheckout.mockResolvedValue({
      gateway: 'YOCO',
      redirectUrl: 'https://c.yoco.com/checkout/ch_123',
      redirectForm: null,
    });

    const redirect = jest.fn();
    const res = {
      redirect,
    } as unknown as Response;

    await controller.continueCheckout('checkout-token-1', 'YOCO', res);

    expect(paymentsService.continueHostedCheckout).toHaveBeenCalledWith(
      'checkout-token-1',
      'YOCO',
    );
    expect(redirect).toHaveBeenCalledWith(
      302,
      'https://c.yoco.com/checkout/ch_123',
    );
  });

  it('returns an auto-submitting form page for Ozow checkout continuation', async () => {
    paymentsService.continueHostedCheckout.mockResolvedValue({
      gateway: 'OZOW',
      redirectUrl: 'https://pay.ozow.com',
      redirectForm: {
        action: 'https://pay.ozow.com',
        method: 'POST',
        fields: {
          SiteCode: 'SITE',
          HashCheck: 'hash',
        },
      },
    });

    const send = jest.fn();
    const type = jest.fn().mockReturnValue({ send });
    const status = jest.fn().mockReturnValue({ type });
    const res = {
      status,
      type,
      send,
    } as unknown as Response;

    await controller.continueCheckout('checkout-token-2', 'OZOW', res);

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('Redirecting to Ozow'),
    );
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('form.submit()'),
    );
  });
});
