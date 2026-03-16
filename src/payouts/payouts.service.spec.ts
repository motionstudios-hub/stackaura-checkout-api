/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PayoutRail, PayoutStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePayoutDto } from './payout.dto';
import { PayoutsService } from './payouts.service';

describe('PayoutsService', () => {
  let service: PayoutsService;
  let prisma: {
    payout: { findFirst: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
  };

  const dto: CreatePayoutDto = {
    amountCents: 5000,
    currency: 'ZAR',
    reference: 'PO-1001',
    rail: 'DERIV',
    derivAccountId: 'CR123456',
    beneficiaryName: 'Test User',
  };

  beforeEach(async () => {
    const payout = {
      findFirst: jest.fn(),
      create: jest.fn(),
    };

    prisma = {
      payout,
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback({ payout }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PayoutsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<PayoutsService>(PayoutsService);
  });

  it('creates payout and returns created record', async () => {
    prisma.payout.findFirst.mockResolvedValue(null);
    prisma.payout.create.mockResolvedValue({
      id: 'po-1',
      merchantId: 'm-1',
      reference: 'PO-1001',
      idempotencyKey: 'idem-1',
      currency: 'ZAR',
      amountCents: 5000,
      status: PayoutStatus.CREATED,
      rail: PayoutRail.DERIV,
      provider: 'DERIV_PA',
      providerRef: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.createPayout('m-1', 'idem-1', dto);

    expect(prisma.payout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantId: 'm-1',
          reference: 'PO-1001',
          idempotencyKey: 'idem-1',
          status: PayoutStatus.CREATED,
          rail: PayoutRail.DERIV,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 'po-1',
        status: PayoutStatus.CREATED,
        reference: 'PO-1001',
      }),
    );
  });

  it('returns existing payout for idempotent replay', async () => {
    prisma.payout.findFirst.mockResolvedValue({
      id: 'po-1',
      merchantId: 'm-1',
      reference: 'PO-1001',
      idempotencyKey: 'idem-1',
      currency: 'ZAR',
      amountCents: 5000,
      status: PayoutStatus.CREATED,
      rail: PayoutRail.DERIV,
      provider: 'DERIV_PA',
      providerRef: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.createPayout('m-1', 'idem-1', dto);

    expect(prisma.payout.create).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        id: 'po-1',
        merchantId: 'm-1',
        reference: 'PO-1001',
      }),
    );
  });

  it('returns payout by id for merchant', async () => {
    prisma.payout.findFirst.mockResolvedValue({
      id: 'po-1',
      merchantId: 'm-1',
      reference: 'PO-1001',
      idempotencyKey: 'idem-1',
      currency: 'ZAR',
      amountCents: 5000,
      status: PayoutStatus.CREATED,
      rail: PayoutRail.DERIV,
      provider: 'DERIV_PA',
      providerRef: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getPayoutById('m-1', 'po-1');

    expect(prisma.payout.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { merchantId: 'm-1', id: 'po-1' },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 'po-1',
        merchantId: 'm-1',
        reference: 'PO-1001',
      }),
    );
  });

  it('returns 404 when payout does not exist for merchant', async () => {
    prisma.payout.findFirst.mockResolvedValue(null);

    await expect(service.getPayoutById('m-1', 'po-404')).rejects.toThrow(
      NotFoundException,
    );
  });
});
