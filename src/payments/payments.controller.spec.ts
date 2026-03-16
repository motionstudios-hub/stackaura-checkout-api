import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { ApiKeyRequest } from '../payouts/api-key.guard';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let paymentsService: {
    createPayment: jest.Mock;
    initiateOzowPayment: jest.Mock;
    getOzowPaymentStatus: jest.Mock;
    listPayments: jest.Mock;
    listPaymentAttempts: jest.Mock;
    getPaymentByReference: jest.Mock;
    failoverPayment: jest.Mock;
  };

  beforeEach(async () => {
    paymentsService = {
      createPayment: jest.fn(),
      initiateOzowPayment: jest.fn(),
      getOzowPaymentStatus: jest.fn(),
      listPayments: jest.fn(),
      listPaymentAttempts: jest.fn(),
      getPaymentByReference: jest.fn(),
      failoverPayment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        {
          provide: PaymentsService,
          useValue: paymentsService,
        },
      ],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .compile();

    controller = module.get<PaymentsController>(PaymentsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('POST /v1/payments uses merchant from ApiKeyGuard context', async () => {
    paymentsService.createPayment.mockResolvedValue({ ok: true });
    const req = {
      apiKeyAuth: { merchantId: 'm-1' },
    } as unknown as ApiKeyRequest;

    await controller.create(req, undefined, { amountCents: 1000 });

    expect(paymentsService.createPayment).toHaveBeenCalledWith(
      'm-1',
      expect.objectContaining({ amountCents: 1000 }),
      undefined,
    );
  });

  it('POST /payments/ozow/initiate uses merchant from ApiKeyGuard context', async () => {
    paymentsService.initiateOzowPayment.mockResolvedValue({ ok: true });
    const req = {
      apiKeyAuth: { merchantId: 'm-ozow' },
    } as unknown as ApiKeyRequest;

    await controller.initiateOzow(req, undefined, { amountCents: 1000 } as any);

    expect(paymentsService.initiateOzowPayment).toHaveBeenCalledWith(
      'm-ozow',
      expect.objectContaining({ amountCents: 1000 }),
      undefined,
    );
  });

  it('GET /v1/payments/:reference uses merchant from ApiKeyGuard context', async () => {
    paymentsService.getPaymentByReference.mockResolvedValue({ ok: true });
    const req = {
      apiKeyAuth: { merchantId: 'm-2' },
    } as unknown as ApiKeyRequest;

    await controller.getByReference(req, 'INV-1');

    expect(paymentsService.getPaymentByReference).toHaveBeenCalledWith(
      'm-2',
      'INV-1',
    );
  });

  it('GET /v1/payments uses merchant from ApiKeyGuard context', async () => {
    paymentsService.listPayments.mockResolvedValue({ data: [] });
    const req = {
      apiKeyAuth: { merchantId: 'm-3' },
    } as unknown as ApiKeyRequest;

    await controller.list(req, {
      status: 'PAID',
      limit: '10',
      q: 'INV',
    });

    expect(paymentsService.listPayments).toHaveBeenCalledWith(
      'm-3',
      expect.objectContaining({
        status: 'PAID',
        limit: '10',
        q: 'INV',
      }),
    );
  });

  it('GET /v1/payments/:reference/attempts uses merchant from ApiKeyGuard context', async () => {
    paymentsService.listPaymentAttempts.mockResolvedValue({ attempts: [] });
    const req = {
      apiKeyAuth: { merchantId: 'm-4' },
    } as unknown as ApiKeyRequest;

    await controller.listAttempts(req, 'INV-4');

    expect(paymentsService.listPaymentAttempts).toHaveBeenCalledWith(
      'm-4',
      'INV-4',
    );
  });

  it('POST /v1/payments/:reference/failover uses merchant from ApiKeyGuard context', async () => {
    paymentsService.failoverPayment.mockResolvedValue({ ok: true });
    const req = {
      apiKeyAuth: { merchantId: 'm-5' },
    } as unknown as ApiKeyRequest;

    await controller.failover(req, 'INV-5');

    expect(paymentsService.failoverPayment).toHaveBeenCalledWith(
      'm-5',
      'INV-5',
    );
  });

  it('throws when guard context is missing', async () => {
    const req = {} as ApiKeyRequest;

    await expect(
      controller.create(req, undefined, { amountCents: 500 }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
