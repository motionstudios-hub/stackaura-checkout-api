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
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    prisma = {
      merchant: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      membership: {
        create: jest.fn(),
      },
      payment: {
        findMany: jest.fn(),
      },
      apiKey: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
      $transaction: jest.fn((callback: (tx: typeof prisma) => unknown) =>
        callback(prisma),
      ),
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

  afterEach(() => {
    process.env = { ...originalEnv };
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

  it('configures Paystack credentials for merchant', async () => {
    const updatedAt = new Date('2026-03-19T09:30:00.000Z');
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({
      id: 'm-1',
      paystackTestMode: null,
    });
    (prisma.merchant.update as jest.Mock).mockResolvedValue({
      id: 'm-1',
      paystackSecretKey: 'sk_test_secret',
      paystackTestMode: true,
      updatedAt,
    });

    await expect(
      service.configurePaystackGateway('m-1', {
        secretKey: 'sk_test_secret',
        testMode: true,
      }),
    ).resolves.toEqual({
      id: 'm-1',
      connected: true,
      hasSecretKey: true,
      testMode: true,
      updatedAt: updatedAt.toISOString(),
    });

    expect(prisma.merchant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm-1' },
        data: {
          paystackSecretKey: 'sk_test_secret',
          paystackTestMode: true,
        },
      }),
    );
  });

  it('returns non-secret Paystack connection state for readback', async () => {
    const updatedAt = new Date('2026-03-19T09:32:00.000Z');
    (prisma.merchant.findUnique as jest.Mock).mockResolvedValue({
      id: 'm-1',
      paystackSecretKey: 'sk_live_secret',
      paystackTestMode: false,
      updatedAt,
    });

    await expect(service.getPaystackGatewayConnection('m-1')).resolves.toEqual({
      id: 'm-1',
      connected: true,
      hasSecretKey: true,
      testMode: false,
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

  it('assigns the default merchant plan during pending signup onboarding', async () => {
    process.env.STACKAURA_DEFAULT_MERCHANT_PLAN = 'starter';
    (prisma.merchant.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.merchant.create as jest.Mock).mockResolvedValue({
      id: 'm-1',
      name: 'Starter Merchant',
      email: 'owner@example.com',
      isActive: false,
      planCode: 'starter',
      createdAt: new Date('2026-03-20T00:00:00.000Z'),
      updatedAt: new Date('2026-03-20T00:00:00.000Z'),
    });
    (prisma.user.create as jest.Mock).mockResolvedValue({
      id: 'u-1',
      email: 'owner@example.com',
      isActive: false,
    });
    (prisma.membership.create as jest.Mock).mockResolvedValue({ id: 'mem-1' });

    await expect(
      service.createPendingMerchantSignup({
        businessName: 'Starter Merchant',
        email: 'owner@example.com',
        password: 'password123',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        apiKey: null,
        merchant: expect.objectContaining({
          id: 'm-1',
          planCode: 'starter',
          plan: {
            code: 'starter',
            source: 'merchant_assigned',
            feeSource: 'platform_default',
            manualGatewaySelection: false,
            autoRouting: true,
            fallback: false,
          },
        }),
      }),
    );

    expect(prisma.merchant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          planCode: 'starter',
        }),
      }),
    );
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'owner@example.com',
          isActive: false,
          passwordHash: expect.any(String),
        }),
      }),
    );
    expect(prisma.membership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          userId: 'u-1',
          merchantId: 'm-1',
          role: 'OWNER',
        },
      }),
    );
  });

  it('creates a loginable owner user and api key during direct merchant signup', async () => {
    (prisma.merchant.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.merchant.create as jest.Mock).mockResolvedValue({
      id: 'm-direct',
      name: 'Direct Merchant',
      email: 'owner@example.com',
      isActive: true,
      planCode: 'growth',
      createdAt: new Date('2026-03-20T00:00:00.000Z'),
      updatedAt: new Date('2026-03-20T00:00:00.000Z'),
    });
    (prisma.user.create as jest.Mock).mockResolvedValue({
      id: 'u-direct',
      email: 'owner@example.com',
      isActive: true,
    });
    (prisma.membership.create as jest.Mock).mockResolvedValue({ id: 'mem-direct' });
    (prisma.apiKey.create as jest.Mock).mockResolvedValue({
      id: 'key-1',
      label: 'default',
      prefix: 'ck_test_abcd',
      last4: '1234',
    });

    const result = await service.createMerchantAccount({
      businessName: 'Direct Merchant',
      email: 'owner@example.com',
      password: 'password123',
    });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'owner@example.com',
          isActive: true,
          passwordHash: expect.any(String),
        }),
      }),
    );
    expect(prisma.membership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          userId: 'u-direct',
          merchantId: 'm-direct',
          role: 'OWNER',
        },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        apiKey: expect.stringMatching(/^ck_test_/),
        apiKeyId: 'key-1',
        merchant: expect.objectContaining({
          id: 'm-direct',
          email: 'owner@example.com',
        }),
      }),
    );
  });

  it('returns zeroed analytics for a merchant with no real payments', async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);

    await expect(service.getMerchantAnalytics('m-empty')).resolves.toEqual(
      expect.objectContaining({
        merchantId: 'm-empty',
        totalPayments: 0,
        totalVolumeCents: 0,
        successfulPayments: 0,
        failedPayments: 0,
        successRate: 0,
        recoveredPayments: 0,
        activeGatewaysUsed: 0,
        gatewayDistribution: [],
        recentPayments: [],
        recentRoutingHistory: [],
      }),
    );
  });

  it('calculates real analytics from merchant payments and excludes signup bootstrap payments', async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'p-3',
        reference: 'PAY-3',
        amountCents: 2000,
        status: 'PAID',
        gateway: 'OZOW',
        createdAt: new Date('2026-03-20T10:00:00.000Z'),
        rawGateway: {
          routing: {
            requestedGateway: 'AUTO',
            selectionMode: 'auto',
            fallbackCount: 0,
          },
        },
        attempts: [
          {
            id: 'a-3',
            gateway: 'OZOW',
            status: 'SUCCEEDED',
            createdAt: new Date('2026-03-20T10:00:00.000Z'),
            updatedAt: new Date('2026-03-20T10:01:00.000Z'),
          },
        ],
      },
      {
        id: 'p-2',
        reference: 'PAY-2',
        amountCents: 1500,
        status: 'FAILED',
        gateway: 'PAYSTACK',
        createdAt: new Date('2026-03-20T09:00:00.000Z'),
        rawGateway: {
          routing: {
            requestedGateway: 'AUTO',
            selectionMode: 'auto',
            fallbackCount: 0,
          },
        },
        attempts: [
          {
            id: 'a-2',
            gateway: 'PAYSTACK',
            status: 'FAILED',
            createdAt: new Date('2026-03-20T09:00:00.000Z'),
            updatedAt: new Date('2026-03-20T09:01:00.000Z'),
          },
        ],
      },
      {
        id: 'p-1',
        reference: 'PAY-1',
        amountCents: 5000,
        status: 'PAID',
        gateway: 'YOCO',
        createdAt: new Date('2026-03-20T08:00:00.000Z'),
        rawGateway: {
          routing: {
            requestedGateway: 'AUTO',
            selectionMode: 'auto',
            fallbackCount: 1,
          },
        },
        attempts: [
          {
            id: 'a-1a',
            gateway: 'PAYSTACK',
            status: 'FAILED',
            createdAt: new Date('2026-03-20T08:00:00.000Z'),
            updatedAt: new Date('2026-03-20T08:01:00.000Z'),
          },
          {
            id: 'a-1b',
            gateway: 'YOCO',
            status: 'SUCCEEDED',
            createdAt: new Date('2026-03-20T08:02:00.000Z'),
            updatedAt: new Date('2026-03-20T08:03:00.000Z'),
          },
        ],
      },
      {
        id: 'p-signup',
        reference: 'SIGNUP-M1',
        amountCents: 1000,
        status: 'PAID',
        gateway: 'OZOW',
        createdAt: new Date('2026-03-20T07:00:00.000Z'),
        rawGateway: {
          publicFlow: {
            flow: 'merchant_signup',
          },
        },
        attempts: [
          {
            id: 'a-signup',
            gateway: 'OZOW',
            status: 'SUCCEEDED',
            createdAt: new Date('2026-03-20T07:00:00.000Z'),
            updatedAt: new Date('2026-03-20T07:01:00.000Z'),
          },
        ],
      },
    ]);

    const analytics = await service.getMerchantAnalytics('m-1');

    expect(analytics).toEqual(
      expect.objectContaining({
        merchantId: 'm-1',
        totalPayments: 3,
        totalVolumeCents: 8500,
        successfulPayments: 2,
        failedPayments: 1,
        successRate: expect.closeTo(66.67, 2),
        recoveredPayments: 1,
        activeGatewaysUsed: 3,
      }),
    );
    expect(analytics.gatewayDistribution).toEqual([
      expect.objectContaining({
        gateway: 'PAYSTACK',
        count: 1,
        volumeCents: 1500,
      }),
      expect.objectContaining({
        gateway: 'YOCO',
        count: 1,
        volumeCents: 5000,
      }),
      expect.objectContaining({
        gateway: 'OZOW',
        count: 1,
        volumeCents: 2000,
      }),
    ]);
    expect(analytics.recentPayments).toHaveLength(3);
    expect(analytics.recentPayments[0]).toEqual(
      expect.objectContaining({
        reference: 'PAY-3',
        gateway: 'OZOW',
      }),
    );
    expect(analytics.recentRoutingHistory[0]).toEqual(
      expect.objectContaining({
        reference: 'PAY-3',
        routeSummary: 'AUTO -> Ozow -> SUCCEEDED',
      }),
    );
    expect(analytics.recentRoutingHistory[2]).toEqual(
      expect.objectContaining({
        reference: 'PAY-1',
        routeSummary: 'AUTO -> Paystack -> FAILED -> Yoco -> SUCCEEDED',
        timelineStages: ['CREATED', 'INITIATED', 'FAILED', 'FALLBACK', 'SUCCEEDED'],
      }),
    );
  });
});
