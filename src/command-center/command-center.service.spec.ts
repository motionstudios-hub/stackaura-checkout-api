import { Test, TestingModule } from '@nestjs/testing';
import { CommandCenterService } from './command-center.service';
import { PrismaService } from '../prisma/prisma.service';

describe('CommandCenterService', () => {
  let service: CommandCenterService;

  const prisma = {
    membership: {
      findFirst: jest.fn(),
    },
    payment: {
      findMany: jest.fn(),
    },
    webhookDelivery: {
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandCenterService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(CommandCenterService);
    jest.clearAllMocks();
  });

  it('requires an authenticated user', async () => {
    await expect(service.getOverview()).rejects.toThrow('Authenticated user required');
  });

  it('returns an aggregated merchant overview', async () => {
    prisma.membership.findFirst.mockResolvedValue({
      merchantId: 'merchant-1',
      merchant: { id: 'merchant-1', name: 'Test Merchant', isActive: true },
    });

    prisma.payment.findMany
      .mockResolvedValueOnce([
        { amount: 10000, status: 'PAID', gateway: 'PAYSTACK', createdAt: new Date() },
        { amount: 5000, status: 'FAILED', gateway: 'YOCO', createdAt: new Date() },
        { amount: 2500, status: 'PENDING', gateway: 'OZOW', createdAt: new Date() },
      ])
      .mockResolvedValueOnce([]);

    prisma.webhookDelivery.findMany.mockResolvedValue([
      { status: 'SUCCESS', attempts: 1, lastStatusCode: 200, lastError: null, updatedAt: new Date() },
      { status: 'FAILED', attempts: 3, lastStatusCode: 500, lastError: 'test', updatedAt: new Date() },
    ]);

    const result = await service.getOverview('user-1');

    expect(result.merchant).toEqual({ id: 'merchant-1', name: 'Test Merchant' });
    expect(result.business.today).toMatchObject({
      revenueCents: 10000,
      transactions: 3,
      successful: 1,
      failed: 1,
      pending: 1,
      successRate: 33.33,
    });
    expect(result.gateways.paystack.transactions).toBe(1);
    expect(result.webhooks).toMatchObject({
      deliverySuccessRate: 50,
      pending: 0,
      failed: 1,
      sampledDeliveries: 2,
    });
  });
});
