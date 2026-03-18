import { Test, TestingModule } from '@nestjs/testing';
import { YocoGateway } from '../gateways/yoco.gateway';
import { MerchantsService } from './merchants.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MerchantsService', () => {
  let service: MerchantsService;
  let prisma: { [key: string]: unknown };
  let yocoGateway: {
    registerWebhookSubscription: jest.Mock;
    resolveWebhookUrl: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      merchant: { findUnique: jest.fn(), update: jest.fn() },
      apiKey: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    };
    yocoGateway = {
      resolveWebhookUrl: jest
        .fn()
        .mockReturnValue('https://api.stackaura.co.za/v1/webhooks/yoco'),
      registerWebhookSubscription: jest.fn().mockResolvedValue({
        id: 'sub_yoco_1',
        name: 'stackaura-test-m1',
        url: 'https://api.stackaura.co.za/v1/webhooks/yoco',
        mode: 'test',
        secret: 'whsec_test_secret',
        raw: {},
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MerchantsService,
        { provide: PrismaService, useValue: prisma },
        { provide: YocoGateway, useValue: yocoGateway },
      ],
    }).compile();

    service = module.get<MerchantsService>(MerchantsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('configures Ozow credentials for merchant', async () => {
    const updatedAt = new Date('2026-03-18T10:15:00.000Z');
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({
      id: 'm-1',
      ozowIsTest: null,
    });
    (prisma.merchant.update as jest.Mock).mockResolvedValue({
      id: 'm-1',
      ozowSiteCode: 'SC-1',
      ozowPrivateKey: 'private-key',
      ozowApiKey: 'api-key',
      ozowIsTest: true,
      updatedAt,
    });

    await expect(
      service.configureOzowGateway('m-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
        apiKey: 'api-key',
        testMode: true,
      }),
    ).resolves.toEqual({
      id: 'm-1',
      connected: true,
      configured: true,
      ozowConfigured: true,
      siteCode: 'SC-1',
      ozowSiteCode: 'SC-1',
      siteCodeMasked: 'SC-1',
      hasApiKey: true,
      hasPrivateKey: true,
      ozowApiKeyConfigured: true,
      ozowPrivateKeyConfigured: true,
      testMode: true,
      ozowTestMode: true,
      updatedAt: updatedAt.toISOString(),
    });

    expect(prisma.merchant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm-1' },
        data: {
          ozowSiteCode: 'SC-1',
          ozowPrivateKey: 'private-key',
          ozowApiKey: 'api-key',
          ozowIsTest: true,
        },
      }),
    );
  });

  it('returns non-secret Ozow connection state for readback', async () => {
    const updatedAt = new Date('2026-03-18T10:25:00.000Z');
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({
      id: 'm-1',
      ozowSiteCode: 'K20-K20-164',
      ozowPrivateKey: 'private-key',
      ozowApiKey: 'api-key',
      ozowIsTest: false,
      updatedAt,
    });

    await expect(service.getOzowGatewayConnection('m-1')).resolves.toEqual({
      id: 'm-1',
      connected: true,
      configured: true,
      ozowConfigured: true,
      siteCode: 'K20-K20-164',
      ozowSiteCode: 'K20-K20-164',
      siteCodeMasked: 'K20-K20-164',
      hasApiKey: true,
      hasPrivateKey: true,
      ozowApiKeyConfigured: true,
      ozowPrivateKeyConfigured: true,
      testMode: false,
      ozowTestMode: false,
      updatedAt: updatedAt.toISOString(),
    });
  });

  it('configures Yoco credentials for merchant', async () => {
    const updatedAt = new Date('2026-03-18T10:40:00.000Z');
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({
      id: 'm-1',
      yocoTestMode: null,
      yocoPublicKey: null,
      yocoSecretKey: null,
      yocoWebhookId: null,
      yocoWebhookSecret: null,
      yocoWebhookUrl: null,
    });
    (prisma.merchant.update as jest.Mock).mockResolvedValue({
      id: 'm-1',
      yocoPublicKey: 'pk_test_public',
      yocoSecretKey: 'sk_test_secret',
      yocoTestMode: true,
      yocoWebhookId: 'sub_yoco_1',
      yocoWebhookSecret: 'whsec_test_secret',
      yocoWebhookUrl: 'https://api.stackaura.co.za/v1/webhooks/yoco',
      updatedAt,
    });

    await expect(
      service.configureYocoGateway('m-1', {
        publicKey: 'pk_test_public',
        secretKey: 'sk_test_secret',
        testMode: true,
      }),
    ).resolves.toEqual({
      id: 'm-1',
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: true,
      webhookConfigured: true,
      updatedAt: updatedAt.toISOString(),
    });

    expect(prisma.merchant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm-1' },
        data: {
          yocoPublicKey: 'pk_test_public',
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
          yocoWebhookId: 'sub_yoco_1',
          yocoWebhookSecret: 'whsec_test_secret',
          yocoWebhookUrl: 'https://api.stackaura.co.za/v1/webhooks/yoco',
        },
      }),
    );
    expect(yocoGateway.registerWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          yocoPublicKey: 'pk_test_public',
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        }),
      }),
    );
  });

  it('returns non-secret Yoco connection state for readback', async () => {
    const updatedAt = new Date('2026-03-18T10:45:00.000Z');
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({
      id: 'm-1',
      yocoPublicKey: 'pk_live_public',
      yocoSecretKey: 'sk_live_secret',
      yocoTestMode: false,
      yocoWebhookSecret: 'whsec_live_secret',
      yocoWebhookUrl: 'https://api.stackaura.co.za/v1/webhooks/yoco',
      updatedAt,
    });

    await expect(service.getYocoGatewayConnection('m-1')).resolves.toEqual({
      id: 'm-1',
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: false,
      webhookConfigured: true,
      updatedAt: updatedAt.toISOString(),
    });
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
