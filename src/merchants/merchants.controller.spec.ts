import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';

describe('MerchantsController', () => {
  let controller: MerchantsController;
  let merchantsService: {
    listApiKeys: jest.Mock;
    createApiKey: jest.Mock;
    revokeApiKey: jest.Mock;
    getMerchantAnalytics: jest.Mock;
    getOzowGatewayConnection: jest.Mock;
    configureOzowGateway: jest.Mock;
    getYocoGatewayConnection: jest.Mock;
    configureYocoGateway: jest.Mock;
    getPaystackGatewayConnection: jest.Mock;
    configurePaystackGateway: jest.Mock;
  };
  let authService: {
    resolveSession: jest.Mock;
  };

  beforeEach(async () => {
    merchantsService = {
      listApiKeys: jest.fn(),
      createApiKey: jest.fn(),
      revokeApiKey: jest.fn(),
      getMerchantAnalytics: jest.fn(),
      getOzowGatewayConnection: jest.fn(),
      configureOzowGateway: jest.fn(),
      getYocoGatewayConnection: jest.fn(),
      configureYocoGateway: jest.fn(),
      getPaystackGatewayConnection: jest.fn(),
      configurePaystackGateway: jest.fn(),
    };
    authService = {
      resolveSession: jest.fn(),
    };

    const moduleBuilder = Test.createTestingModule({
      controllers: [MerchantsController],
      providers: [
        { provide: MerchantsService, useValue: merchantsService },
        { provide: AuthService, useValue: authService },
      ],
    });
    moduleBuilder
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: jest.fn(() => true) });
    moduleBuilder
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) });

    const module: TestingModule = await moduleBuilder.compile();

    controller = module.get<MerchantsController>(MerchantsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('lists only signed-in merchant memberships without touching secret fields', async () => {
    const req = {
      sessionAuth: {
        user: { id: 'u-1', email: 'owner@example.com' },
        memberships: [
          {
            id: 'mem-1',
            role: 'OWNER',
            merchant: {
              id: 'm-1',
              name: 'Merchant One',
              email: 'merchant@example.com',
              isActive: true,
              planCode: 'growth',
              plan: {
                code: 'growth',
                manualGatewaySelection: true,
                autoRouting: true,
                fallback: true,
              },
            },
          },
        ],
      },
    };

    await expect(controller.list(req as never)).resolves.toEqual([
      {
        id: 'm-1',
        name: 'Merchant One',
        email: 'merchant@example.com',
        isActive: true,
        role: 'OWNER',
        planCode: 'growth',
        plan: {
          code: 'growth',
          manualGatewaySelection: true,
          autoRouting: true,
          fallback: true,
        },
      },
    ]);
  });

  it('returns merchant analytics for a signed-in member of that merchant workspace', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.getMerchantAnalytics.mockResolvedValue({
      merchantId: 'm-1',
      totalPayments: 1,
      totalVolumeCents: 5000,
      successfulPayments: 1,
      failedPayments: 0,
      successRate: 100,
      recoveredPayments: 0,
      activeGatewaysUsed: 1,
      gatewayDistribution: [],
      recentPayments: [],
      recentRoutingHistory: [],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
    };

    await expect(
      controller.getMerchantAnalytics(req as never, 'm-1'),
    ).resolves.toEqual(
      expect.objectContaining({
        merchantId: 'm-1',
        totalPayments: 1,
      }),
    );

    expect(authService.resolveSession).toHaveBeenCalledWith('session-token');
    expect(merchantsService.getMerchantAnalytics).toHaveBeenCalledWith('m-1');
  });

  it('rejects merchant analytics when the signed-in user lacks that merchant membership', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-2',
          role: 'OWNER',
          merchant: { id: 'm-2', name: 'Merchant Two' },
        },
      ],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
    };

    await expect(
      controller.getMerchantAnalytics(req as never, 'm-1'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('lists API keys for the signed-in merchant workspace without requiring Authorization', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.listApiKeys.mockResolvedValue([
      { id: 'key-1', label: 'primary-backend' },
    ]);

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.listApiKeys(req as never, 'm-1'),
    ).resolves.toEqual([{ id: 'key-1', label: 'primary-backend' }]);

    expect(authService.resolveSession).toHaveBeenCalledWith('session-token');
    expect(merchantsService.listApiKeys).toHaveBeenCalledWith('m-1');
  });

  it('creates an API key for the signed-in merchant workspace without requiring Authorization', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.createApiKey.mockResolvedValue({
      apiKey: 'ck_test_created_key',
      apiKeyId: 'key-1',
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.createApiKey(req as never, 'm-1', {
        label: 'primary-backend',
        environment: 'test',
      }),
    ).resolves.toEqual({
      apiKey: 'ck_test_created_key',
      apiKeyId: 'key-1',
    });

    expect(authService.resolveSession).toHaveBeenCalledWith('session-token');
    expect(merchantsService.createApiKey).toHaveBeenCalledWith(
      'm-1',
      'primary-backend',
      'test',
    );
  });

  it('returns Ozow connection state for the authenticated merchant scope', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.getOzowGatewayConnection.mockResolvedValue({
      connected: true,
      siteCodeMasked: 'K20-K20-164',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:30:00.000Z',
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.getOzowGatewayConnection(req as never, 'm-1'),
    ).resolves.toEqual({
      connected: true,
      siteCodeMasked: 'K20-K20-164',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:30:00.000Z',
    });

    expect(merchantsService.getOzowGatewayConnection).toHaveBeenCalledWith(
      'm-1',
    );
  });

  it('configures Ozow including per-merchant test mode', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.configureOzowGateway.mockResolvedValue({
      connected: true,
      siteCodeMasked: 'SC-1',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:31:00.000Z',
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.configureOzowGateway(req as never, 'm-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
        apiKey: 'api-key',
        testMode: false,
      }),
    ).resolves.toEqual({
      connected: true,
      siteCodeMasked: 'SC-1',
      hasApiKey: true,
      hasPrivateKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:31:00.000Z',
    });

    expect(merchantsService.configureOzowGateway).toHaveBeenCalledWith('m-1', {
      siteCode: 'SC-1',
      privateKey: 'private-key',
      apiKey: 'api-key',
      testMode: false,
    });
  });

  it('rejects Ozow GET when the session lacks that merchant membership', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-2',
          role: 'OWNER',
          merchant: { id: 'm-2', name: 'Merchant Two' },
        },
      ],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.getOzowGatewayConnection(req as never, 'm-1'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects Ozow POST when the session lacks that merchant membership', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-2',
          role: 'OWNER',
          merchant: { id: 'm-2', name: 'Merchant Two' },
        },
      ],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.configureOzowGateway(req as never, 'm-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns Yoco connection state for the authenticated merchant scope', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.getYocoGatewayConnection.mockResolvedValue({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:35:00.000Z',
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.getYocoGatewayConnection(req as never, 'm-1'),
    ).resolves.toEqual({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: true,
      updatedAt: '2026-03-18T10:35:00.000Z',
    });

    expect(merchantsService.getYocoGatewayConnection).toHaveBeenCalledWith(
      'm-1',
    );
  });

  it('configures Yoco credentials including per-merchant test mode', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.configureYocoGateway.mockResolvedValue({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:36:00.000Z',
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.configureYocoGateway(req as never, 'm-1', {
        publicKey: 'pk_live_public',
        secretKey: 'sk_live_secret',
        testMode: false,
      }),
    ).resolves.toEqual({
      connected: true,
      hasPublicKey: true,
      hasSecretKey: true,
      testMode: false,
      updatedAt: '2026-03-18T10:36:00.000Z',
    });

    expect(merchantsService.configureYocoGateway).toHaveBeenCalledWith('m-1', {
      publicKey: 'pk_live_public',
      secretKey: 'sk_live_secret',
      testMode: false,
    });
  });

  it('rejects Yoco GET when the session lacks that merchant membership', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-2',
          role: 'OWNER',
          merchant: { id: 'm-2', name: 'Merchant Two' },
        },
      ],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.getYocoGatewayConnection(req as never, 'm-1'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects Yoco POST when the session lacks that merchant membership', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-2',
          role: 'OWNER',
          merchant: { id: 'm-2', name: 'Merchant Two' },
        },
      ],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.configureYocoGateway(req as never, 'm-1', {
        publicKey: 'pk_test_public',
        secretKey: 'sk_test_secret',
        testMode: true,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns Paystack connection state for the authenticated merchant scope', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.getPaystackGatewayConnection.mockResolvedValue({
      connected: true,
      hasSecretKey: true,
      testMode: true,
      updatedAt: '2026-03-19T09:35:00.000Z',
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.getPaystackGatewayConnection(req as never, 'm-1'),
    ).resolves.toEqual({
      connected: true,
      hasSecretKey: true,
      testMode: true,
      updatedAt: '2026-03-19T09:35:00.000Z',
    });

    expect(merchantsService.getPaystackGatewayConnection).toHaveBeenCalledWith(
      'm-1',
    );
  });

  it('configures Paystack credentials including per-merchant test mode', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-1',
          role: 'OWNER',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      ],
    });
    merchantsService.configurePaystackGateway.mockResolvedValue({
      connected: true,
      hasSecretKey: true,
      testMode: false,
      updatedAt: '2026-03-19T09:36:00.000Z',
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.configurePaystackGateway(req as never, 'm-1', {
        secretKey: 'sk_live_secret',
        testMode: false,
      }),
    ).resolves.toEqual({
      connected: true,
      hasSecretKey: true,
      testMode: false,
      updatedAt: '2026-03-19T09:36:00.000Z',
    });

    expect(merchantsService.configurePaystackGateway).toHaveBeenCalledWith(
      'm-1',
      {
        secretKey: 'sk_live_secret',
        testMode: false,
      },
    );
  });

  it('rejects Paystack GET when the session lacks that merchant membership', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-2',
          role: 'OWNER',
          merchant: { id: 'm-2', name: 'Merchant Two' },
        },
      ],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.getPaystackGatewayConnection(req as never, 'm-1'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects Paystack POST when the session lacks that merchant membership', async () => {
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [
        {
          id: 'mem-2',
          role: 'OWNER',
          merchant: { id: 'm-2', name: 'Merchant Two' },
        },
      ],
    });

    const req = {
      cookies: { stackaura_session: 'session-token' },
      headers: {},
    };

    await expect(
      controller.configurePaystackGateway(req as never, 'm-1', {
        secretKey: 'sk_test_secret',
        testMode: true,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
