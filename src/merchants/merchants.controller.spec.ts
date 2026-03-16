import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';
import type { ApiKeyRequest } from '../payouts/api-key.guard';

describe('MerchantsController', () => {
  let controller: MerchantsController;
  let merchantsService: {
    createApiKey: jest.Mock;
    revokeApiKey: jest.Mock;
    validateApiKey: jest.Mock;
    configurePayfastGateway: jest.Mock;
    configureOzowGateway: jest.Mock;
  };

  beforeEach(async () => {
    merchantsService = {
      createApiKey: jest.fn(),
      revokeApiKey: jest.fn(),
      validateApiKey: jest.fn(),
      configurePayfastGateway: jest.fn(),
      configureOzowGateway: jest.fn(),
    };

    const moduleBuilder = Test.createTestingModule({
      controllers: [MerchantsController],
      providers: [{ provide: MerchantsService, useValue: merchantsService }],
    });
    moduleBuilder
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: jest.fn(() => true) });

    const module: TestingModule = await moduleBuilder.compile();

    controller = module.get<MerchantsController>(MerchantsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('configures PayFast using Authorization Bearer key', async () => {
    merchantsService.validateApiKey.mockResolvedValue({ merchantId: 'm-1' });
    merchantsService.configurePayfastGateway.mockResolvedValue({ ok: true });

    await controller.configurePayfastGateway(
      'm-1',
      'ck_test_old',
      'Bearer ck_test_new',
      {
        merchantId: 'pf-mid',
        merchantKey: 'pf-mkey',
        isSandbox: false,
      },
    );

    expect(merchantsService.validateApiKey).toHaveBeenCalledWith(
      'ck_test_new',
      false,
    );
    expect(merchantsService.configurePayfastGateway).toHaveBeenCalledWith(
      'm-1',
      expect.objectContaining({
        merchantId: 'pf-mid',
        merchantKey: 'pf-mkey',
        isSandbox: false,
      }),
    );
  });

  it('falls back to x-api-key when Authorization is missing', async () => {
    merchantsService.validateApiKey.mockResolvedValue({ merchantId: 'm-1' });
    merchantsService.configurePayfastGateway.mockResolvedValue({ ok: true });

    await controller.configurePayfastGateway(
      'm-1',
      'ck_test_fallback',
      undefined,
      {
        merchantId: 'pf-mid',
        merchantKey: 'pf-mkey',
      },
    );

    expect(merchantsService.validateApiKey).toHaveBeenCalledWith(
      'ck_test_fallback',
      false,
    );
  });

  it('rejects mismatched merchant scope', async () => {
    merchantsService.validateApiKey.mockResolvedValue({ merchantId: 'm-2' });

    await expect(
      controller.configurePayfastGateway(
        'm-1',
        undefined,
        'Bearer ck_test_scope',
        { merchantId: 'pf-mid', merchantKey: 'pf-mkey' },
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('configures Ozow using guarded merchant scope', async () => {
    merchantsService.configureOzowGateway.mockResolvedValue({
      id: 'm-ozow',
      ozowSiteCode: 'SC-1',
      ozowConfigured: true,
    });

    const req = {
      apiKeyAuth: { merchantId: 'm-1' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.configureOzowGateway(req, 'm-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
        apiKey: 'api-key',
      }),
    ).resolves.toEqual({
      id: 'm-ozow',
      ozowSiteCode: 'SC-1',
      ozowConfigured: true,
    });

    expect(merchantsService.configureOzowGateway).toHaveBeenCalledWith('m-1', {
      siteCode: 'SC-1',
      privateKey: 'private-key',
      apiKey: 'api-key',
    });
  });

  it('rejects Ozow config when API key merchant scope mismatches path merchant', async () => {
    const req = {
      apiKeyAuth: { merchantId: 'm-2' },
    } as unknown as ApiKeyRequest;

    await expect(
      controller.configureOzowGateway(req, 'm-1', {
        siteCode: 'SC-1',
        privateKey: 'private-key',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
