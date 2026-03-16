import { Test, TestingModule } from '@nestjs/testing';
import { MerchantsService } from './merchants.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MerchantsService', () => {
  let service: MerchantsService;
  let prisma: { [key: string]: unknown };

  beforeEach(async () => {
    prisma = {
      merchant: { findUnique: jest.fn(), update: jest.fn() },
      apiKey: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MerchantsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<MerchantsService>(MerchantsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('configures Ozow credentials for merchant', async () => {
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({ id: 'm-1' });
    (prisma.merchant.update as jest.Mock).mockResolvedValue({
      id: 'm-1',
      ozowSiteCode: 'SC-1',
      ozowPrivateKey: 'private-key',
    });

    await expect(
      service.configureOzowGateway('m-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
        apiKey: 'api-key',
      }),
    ).resolves.toEqual({
      id: 'm-1',
      ozowSiteCode: 'SC-1',
      ozowConfigured: true,
    });

    expect(prisma.merchant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm-1' },
        data: {
          ozowSiteCode: 'SC-1',
          ozowPrivateKey: 'private-key',
          ozowApiKey: 'api-key',
        },
      }),
    );
  });

  it('configures PayFast credentials with merchant sandbox flag', async () => {
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({ id: 'm-1' });
    (prisma.merchant.update as jest.Mock).mockResolvedValue({
      id: 'm-1',
      payfastMerchantId: '10046276',
      payfastPassphrase: 'pf-pass',
      payfastIsSandbox: false,
    });

    await expect(
      service.configurePayfastGateway('m-1', {
        merchantId: '10046276',
        merchantKey: 'pf-key',
        passphrase: 'pf-pass',
        isSandbox: false,
      }),
    ).resolves.toEqual({
      id: 'm-1',
      payfastMerchantId: '10046276',
      payfastPassphraseConfigured: true,
      payfastIsSandbox: false,
    });

    expect(prisma.merchant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm-1' },
        data: {
          payfastMerchantId: '10046276',
          payfastMerchantKey: 'pf-key',
          payfastPassphrase: 'pf-pass',
          payfastIsSandbox: false,
        },
      }),
    );
  });
});
