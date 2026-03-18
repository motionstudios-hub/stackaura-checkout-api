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
  };
  let paymentsService: {
    autoFailoverByReference: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      payment: {
        findFirst: jest.fn(),
      },
    };

    paymentsService = {
      autoFailoverByReference: jest.fn(),
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
});
