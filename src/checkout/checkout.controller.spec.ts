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
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Payment error'));
    expect(send).toHaveBeenCalledWith(expect.stringContaining('INV-2'));
  });
});
