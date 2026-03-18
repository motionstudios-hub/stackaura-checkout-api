import { Test, TestingModule } from '@nestjs/testing';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let webhooksService: {
    handlePayfastWebhook: jest.Mock;
    handleOzowWebhook: jest.Mock;
    handleYocoWebhook: jest.Mock;
    handleDerivPaWebhook: jest.Mock;
  };

  beforeEach(async () => {
    webhooksService = {
      handlePayfastWebhook: jest.fn(),
      handleOzowWebhook: jest.fn(),
      handleYocoWebhook: jest.fn(),
      handleDerivPaWebhook: jest.fn(),
    };

    const moduleBuilder = Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [{ provide: WebhooksService, useValue: webhooksService }],
    });
    moduleBuilder
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: jest.fn(() => true) });

    const module: TestingModule = await moduleBuilder.compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns plain OK when PayFast webhook succeeds', async () => {
    const req = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as Parameters<WebhooksController['payfast']>[0];

    await expect(
      controller.payfast(req, {
        m_payment_id: 'INV-1',
        payment_status: 'COMPLETE',
      }),
    ).resolves.toEqual('OK');

    expect(webhooksService.handlePayfastWebhook).toHaveBeenCalled();
  });

  it('returns plain OK for invalid signature/postback errors', async () => {
    webhooksService.handlePayfastWebhook.mockRejectedValueOnce(
      new Error('Invalid signature'),
    );

    const req = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as Parameters<WebhooksController['payfast']>[0];

    await expect(
      controller.payfast(req, {
        m_payment_id: 'INV-2',
        payment_status: 'COMPLETE',
        signature: 'bad',
      }),
    ).resolves.toEqual('OK');
  });

  it('swallows unexpected PayFast errors and still returns plain OK payload', async () => {
    webhooksService.handlePayfastWebhook.mockRejectedValueOnce(
      new Error('temporary db failure'),
    );

    const req = {
      get: jest.fn().mockReturnValue('req-123'),
    } as unknown as Parameters<WebhooksController['payfast']>[0];

    await expect(
      controller.payfast(req, {
        m_payment_id: 'INV-3',
        payment_status: 'COMPLETE',
      }),
    ).resolves.toEqual('OK');
  });

  it('returns { ok: true } when Ozow webhook succeeds', async () => {
    const req = {
      get: jest.fn().mockReturnValue('req-ozow'),
    } as unknown as Parameters<WebhooksController['ozow']>[0];

    await expect(
      controller.ozow(req, {
        TransactionReference: 'INV-ozow-1',
        Status: 'Complete',
      }),
    ).resolves.toEqual({ ok: true });

    expect(webhooksService.handleOzowWebhook).toHaveBeenCalled();
  });

  it('returns { ok: true } when Yoco webhook succeeds', async () => {
    const req = {
      rawBody: Buffer.from(
        JSON.stringify({
          id: 'evt_yoco_1',
          type: 'payment.succeeded',
        }),
      ),
      get: jest.fn().mockReturnValue('req-yoco'),
    } as unknown as Parameters<WebhooksController['yoco']>[0];

    await expect(
      controller.yoco(
        req,
        {
          id: 'evt_yoco_1',
          type: 'payment.succeeded',
          payload: { metadata: { checkoutId: 'checkout_123' } },
        },
        {
          'webhook-id': 'evt_yoco_1',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,signature',
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(webhooksService.handleYocoWebhook).toHaveBeenCalled();
  });
});
