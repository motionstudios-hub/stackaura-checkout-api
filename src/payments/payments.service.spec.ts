/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { OzowGateway } from '../gateways/ozow.gateway';
import { PayfastGateway } from '../gateways/payfast.gateway';
import { PaystackGateway } from '../gateways/paystack.gateway';
import { YocoGateway } from '../gateways/yoco.gateway';
import { MerchantsService } from '../merchants/merchants.service';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingEngine } from '../routing/routing.engine';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let fetchMock: jest.Mock;
  let prisma: {
    merchant: { findUnique: jest.Mock; update: jest.Mock };
    payment: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    paymentAttempt: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let merchantsService: {
    createPendingMerchantSignup: jest.Mock;
    ensureInitialApiKey: jest.Mock;
  };

  const merchantBase = {
    id: 'm-1',
    payfastMerchantId: null,
    payfastMerchantKey: null,
    payfastPassphrase: null,
    payfastIsSandbox: true,
    ozowSiteCode: null,
    ozowPrivateKey: null,
    ozowApiKey: null,
    yocoPublicKey: null,
    yocoSecretKey: null,
    yocoTestMode: false,
    paystackSecretKey: null,
    paystackTestMode: false,
    gatewayOrder: ['OZOW', 'PAYFAST'],
    platformFeeBps: 0,
    platformFeeFixedCents: 0,
  };

  const paymentBase = {
    id: 'p-1',
    merchantId: 'm-1',
    reference: 'INV-1',
    currency: 'ZAR',
    amountCents: 1000,
    platformFeeCents: 0,
    merchantNetCents: 1000,
    status: 'CREATED',
    gateway: 'PAYFAST',
    checkoutToken: 'tok-1',
    expiresAt: new Date('2026-02-27T11:00:00.000Z'),
    customerEmail: 'buyer@example.com',
    description: 'Order',
    gatewayRef: null,
    createdAt: new Date('2026-02-27T10:00:00.000Z'),
    updatedAt: new Date('2026-02-27T10:00:00.000Z'),
  };

  beforeEach(async () => {
    fetchMock = jest.fn();
    (global as { fetch?: jest.Mock }).fetch = fetchMock;
    prisma = {
      merchant: { findUnique: jest.fn(), update: jest.fn() },
      payment: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentAttempt: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn((input: unknown) => {
        if (typeof input === 'function') {
          return input({
            payment: prisma.payment,
            paymentAttempt: prisma.paymentAttempt,
          });
        }

        if (Array.isArray(input)) {
          return Promise.all(input);
        }

        return input;
      }),
    };
    merchantsService = {
      createPendingMerchantSignup: jest.fn(),
      ensureInitialApiKey: jest.fn(),
    };

    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.paymentAttempt.create.mockResolvedValue({ id: 'att-1' });
    prisma.paymentAttempt.findFirst.mockResolvedValue({
      id: 'att-1',
      status: 'CREATED',
    });
    prisma.paymentAttempt.update.mockResolvedValue({ id: 'att-1' });
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 0 });
    prisma.payment.update.mockResolvedValue({ id: 'p-1' });
    prisma.merchant.update.mockResolvedValue({ id: 'm-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        RoutingEngine,
        GatewayRegistry,
        PayfastGateway,
        OzowGateway,
        YocoGateway,
        PaystackGateway,
        { provide: MerchantsService, useValue: merchantsService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  afterEach(() => {
    delete (global as { fetch?: jest.Mock }).fetch;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('computes fee/net and clamps fee to amount', async () => {
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      payfastMerchantId: 'pf-mid',
      payfastMerchantKey: 'pf-key',
      gatewayOrder: ['PAYFAST'],
      platformFeeBps: 20000,
      platformFeeFixedCents: 700,
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      amountCents: 1000,
      platformFeeCents: 1000,
      merchantNetCents: 0,
      gateway: 'PAYFAST',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1000,
      gateway: 'PAYFAST',
      reference: 'INV-CLAMP',
    });

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          platformFeeCents: 1000,
          merchantNetCents: 0,
        }),
      }),
    );
    expect(result.platformFeeCents).toBe(1000);
    expect(result.merchantNetCents).toBe(0);
  });

  it('clamps negative computed fee to zero', async () => {
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      payfastMerchantId: 'pf-mid',
      payfastMerchantKey: 'pf-key',
      gatewayOrder: ['PAYFAST'],
      platformFeeBps: -500,
      platformFeeFixedCents: -100,
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      amountCents: 1000,
      platformFeeCents: 0,
      merchantNetCents: 1000,
      gateway: 'PAYFAST',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1000,
      gateway: 'PAYFAST',
      reference: 'INV-NEG-CLAMP',
    });

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          platformFeeCents: 0,
          merchantNetCents: 1000,
        }),
      }),
    );
    expect(result.platformFeeCents).toBe(0);
    expect(result.merchantNetCents).toBe(1000);
  });

  it('AUTO chooses YOCO first when Yoco is configured and amount is valid', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_auto_yoco',
        redirectUrl: 'https://c.yoco.com/checkout/auto123',
        processingMode: 'test',
      }),
    });
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      ozowSiteCode: 'SC-1',
      ozowPrivateKey: 'oz-private',
      yocoPublicKey: 'pk_test_public',
      yocoSecretKey: 'sk_test_secret',
      yocoTestMode: true,
      gatewayOrder: ['OZOW', 'PAYFAST'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      gateway: 'YOCO',
      reference: 'INV-AUTO-YOCO',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1000,
      reference: 'INV-AUTO-YOCO',
    });

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gateway: 'YOCO',
        }),
      }),
    );
    expect(result.gateway).toBe('YOCO');
  });

  it('creates a Yoco payment with merchant-scoped Yoco keys when gateway is explicit', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_123',
        redirectUrl: 'https://c.yoco.com/checkout/abc123',
        processingMode: 'test',
      }),
    });
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      yocoPublicKey: 'pk_test_public',
      yocoSecretKey: 'sk_test_secret',
      yocoTestMode: true,
      gatewayOrder: ['OZOW', 'PAYFAST'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      gateway: 'YOCO',
      reference: 'INV-YOCO',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1500,
      gateway: 'yoco',
      reference: 'INV-YOCO',
      returnUrl: 'https://stackaura.co.za/payments/success',
      cancelUrl: 'https://stackaura.co.za/payments/cancel',
      errorUrl: 'https://stackaura.co.za/payments/error',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://payments.yoco.com/api/checkouts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_secret',
          'Idempotency-Key': 'p-1',
        }),
      }),
    );
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gateway: 'YOCO',
        }),
      }),
    );
    expect(result.gateway).toBe('YOCO');
    expect(result.redirectUrl).toBe('https://c.yoco.com/checkout/abc123');
    expect(result.gatewayRef).toBe('checkout_123');
  });

  it('creates a Paystack payment with merchant-scoped Paystack keys when gateway is explicit', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: 'https://checkout.paystack.com/abc123',
          access_code: 'access_123',
          reference: 'INV-PAYSTACK',
        },
      }),
    });
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      paystackSecretKey: 'sk_test_secret',
      paystackTestMode: true,
      gatewayOrder: ['YOCO', 'OZOW'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      gateway: 'PAYSTACK',
      reference: 'INV-PAYSTACK',
      customerEmail: 'buyer@example.com',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1500,
      gateway: 'paystack',
      reference: 'INV-PAYSTACK',
      customerEmail: 'buyer@example.com',
      returnUrl: 'https://stackaura.co.za/payments/success',
      cancelUrl: 'https://stackaura.co.za/payments/cancel',
      errorUrl: 'https://stackaura.co.za/payments/error',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_secret',
        }),
      }),
    );
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gateway: 'PAYSTACK',
        }),
      }),
    );
    expect(result.gateway).toBe('PAYSTACK');
    expect(result.redirectUrl).toBe('https://checkout.paystack.com/abc123');
    expect(result.gatewayRef).toBe('access_123');
  });

  it('AUTO falls back to Ozow when Yoco amount is below minimum', async () => {
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      ozowSiteCode: 'SC-1',
      ozowPrivateKey: 'oz-private',
      yocoPublicKey: 'pk_test_public',
      yocoSecretKey: 'sk_test_secret',
      yocoTestMode: true,
      gatewayOrder: ['YOCO', 'OZOW'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      gateway: 'OZOW',
      reference: 'INV-AUTO-OZOW-FALLBACK',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 150,
      reference: 'INV-AUTO-OZOW-FALLBACK',
      gateway: 'AUTO',
    });

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gateway: 'OZOW',
        }),
      }),
    );
    expect(result.gateway).toBe('OZOW');
  });

  it('reconciles Paystack verify status to PAID', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        message: 'Verification successful',
        data: {
          reference: 'INV-PAYSTACK-STATUS',
          access_code: 'access_123',
          status: 'success',
          amount: 1000,
          currency: 'ZAR',
          paid_at: '2026-03-19T09:20:00.000Z',
          channel: 'card',
          customer: {
            email: 'buyer@example.com',
          },
        },
      }),
    });
    prisma.payment.findFirst.mockResolvedValue({
      ...paymentBase,
      gateway: 'PAYSTACK',
      status: 'CREATED',
      reference: 'INV-PAYSTACK-STATUS',
      gatewayRef: 'access_123',
      merchant: {
        paystackSecretKey: 'sk_test_secret',
        paystackTestMode: true,
      },
      rawGateway: {
        provider: 'PAYSTACK',
        paystack: {
          reference: 'INV-PAYSTACK-STATUS',
        },
      },
    });
    jest
      .spyOn(service, 'recordSuccessfulPaymentLedgerByPaymentId')
      .mockResolvedValue({ ok: true } as never);
    jest
      .spyOn(service, 'fulfillPaidSignupPayment')
      .mockResolvedValue({ fulfilled: false, reason: 'not_signup_payment' } as never);

    const result = await service.getPaystackPaymentStatus(
      'm-1',
      'INV-PAYSTACK-STATUS',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/verify/INV-PAYSTACK-STATUS',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_secret',
        }),
      }),
    );
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gateway: 'PAYSTACK',
          status: 'PAID',
        }),
      }),
    );
    expect(result.localStatus).toBe('PAID');
    expect(result.providerStatus).toBe('success');
    expect(result.synced).toBe(true);
  });

  it('builds hosted checkout context with Paystack as an explicit selectable rail', async () => {
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 'p-hosted-paystack',
      checkoutToken: 'checkout-token-paystack',
      merchantId: 'm-1',
      reference: 'INV-HOSTED-PAYSTACK',
      amountCents: 9900,
      currency: 'ZAR',
      status: 'CREATED',
      description: 'Hosted checkout payment',
      customerEmail: 'buyer@example.com',
      expiresAt: new Date('2026-03-19T10:15:00.000Z'),
      gateway: null,
      rawGateway: {
        routing: {
          requestedGateway: 'PAYSTACK',
        },
      },
      merchant: {
        name: 'Stackaura Labs',
      },
      attempts: [],
    });
    prisma.merchant.findUnique.mockResolvedValueOnce({
      ...merchantBase,
      paystackSecretKey: 'sk_test_secret',
      paystackTestMode: true,
    });

    const result = await service.getHostedCheckoutPageContext(
      'checkout-token-paystack',
    );

    expect(result.selectedGateway).toBe('PAYSTACK');
    expect(result.selectionLocked).toBe(true);
    expect(result.gatewayOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'PAYSTACK',
          label: 'Paystack',
          available: true,
          selected: true,
        }),
      ]),
    );
  });

  it('reconciles Yoco webhook-derived success state to PAID', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_123',
        status: 'completed',
        paymentId: 'pay_yoco_123',
        externalId: 'INV-YOCO-STATUS',
        clientReferenceId: 'p-1',
        processingMode: 'test',
      }),
    });
    prisma.payment.findFirst.mockResolvedValue({
      ...paymentBase,
      gateway: 'YOCO',
      status: 'CREATED',
      reference: 'INV-YOCO-STATUS',
      gatewayRef: 'checkout_123',
      merchant: {
        yocoPublicKey: 'pk_test_public',
        yocoSecretKey: 'sk_test_secret',
        yocoTestMode: true,
      },
      rawGateway: {
        provider: 'YOCO',
        externalReference: 'checkout_123',
        request: {
          raw: {
            id: 'checkout_123',
            status: 'completed',
            paymentId: 'pay_yoco_123',
            processingMode: 'test',
          },
        },
        yoco: {
          checkoutId: 'checkout_123',
          checkoutStatus: 'completed',
          paymentId: 'pay_yoco_123',
          paymentStatus: 'succeeded',
          eventType: 'payment.succeeded',
          processingMode: 'test',
        },
      },
    });
    prisma.payment.update.mockResolvedValue({ id: 'p-1' });
    jest
      .spyOn(service, 'recordSuccessfulPaymentLedgerByPaymentId')
      .mockResolvedValue({ ok: true } as never);
    jest
      .spyOn(service, 'fulfillPaidSignupPayment')
      .mockResolvedValue({ fulfilled: false, reason: 'not_signup_payment' } as never);
    merchantsService.ensureInitialApiKey.mockResolvedValue({
      created: false,
      apiKey: null,
      apiKeyId: 'key-1',
      label: 'signup-initial',
      prefix: 'ck_test',
      last4: '1234',
    });

    const result = await service.getYocoPaymentStatus('m-1', 'INV-YOCO-STATUS');

    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-1' },
        data: expect.objectContaining({
          status: 'PAID',
          gateway: 'YOCO',
        }),
      }),
    );
    expect(prisma.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-1' },
        data: { status: 'SUCCEEDED' },
      }),
    );
    expect(result.localStatus).toBe('PAID');
    expect(result.providerStatus).toBe('succeeded');
    expect(result.providerEventType).toBe('payment.succeeded');
    expect(result.checkoutId).toBe('checkout_123');
  });

  it('marks expired unresolved Yoco checkout as CANCELLED during status reconciliation', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_expired',
        status: 'started',
        paymentId: null,
        externalId: 'INV-YOCO-EXPIRED',
        clientReferenceId: 'p-1',
        processingMode: 'test',
      }),
    });
    prisma.payment.findFirst.mockResolvedValue({
      ...paymentBase,
      gateway: 'YOCO',
      status: 'CREATED',
      reference: 'INV-YOCO-EXPIRED',
      gatewayRef: 'checkout_expired',
      expiresAt: new Date(Date.now() - 5 * 60 * 1000),
      merchant: {
        yocoPublicKey: 'pk_test_public',
        yocoSecretKey: 'sk_test_secret',
        yocoTestMode: true,
      },
      rawGateway: {
        provider: 'YOCO',
        request: {
          raw: {
            id: 'checkout_expired',
            status: 'started',
            processingMode: 'test',
          },
        },
      },
    });
    prisma.payment.update.mockResolvedValue({ id: 'p-1' });

    const result = await service.getYocoPaymentStatus('m-1', 'INV-YOCO-EXPIRED');

    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-1' },
        data: expect.objectContaining({
          status: 'CANCELLED',
        }),
      }),
    );
    expect(prisma.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-1' },
        data: { status: 'CANCELLED' },
      }),
    );
    expect(result.localStatus).toBe('CANCELLED');
    expect(result.expired).toBe(true);
  });

  it('uses configured PayFast merchant credentials in redirect, never internal merchant UUID', async () => {
    const internalMerchantId = '0277d043-5a88-4f94-84fc-7f46b8f1845f';
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      id: internalMerchantId,
      payfastMerchantId: '10046276',
      payfastMerchantKey: 'pf-key-10046276',
      payfastPassphrase: 'pf-pass',
      gatewayOrder: ['PAYFAST'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      merchantId: internalMerchantId,
      reference: 'INV-PF-CREDS',
      gateway: 'PAYFAST',
    });

    const result = await service.createPayment(internalMerchantId, {
      amountCents: 1000,
      gateway: 'PAYFAST',
      reference: 'INV-PF-CREDS',
    });

    expect(prisma.merchant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: internalMerchantId },
        select: expect.objectContaining({
          payfastMerchantId: true,
          payfastMerchantKey: true,
          payfastPassphrase: true,
          payfastIsSandbox: true,
        }),
      }),
    );

    const redirect = new URL(result.redirectUrl);
    expect(redirect.searchParams.get('merchant_id')).toBe('10046276');
    expect(redirect.searchParams.get('merchant_key')).toBe('pf-key-10046276');
    expect(redirect.searchParams.get('passphrase')).toBeNull();
    expect(result.redirectUrl).not.toContain(internalMerchantId);
  });

  it('uses sandbox PayFast process host when merchant payfastIsSandbox=true', async () => {
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      payfastMerchantId: '10046276',
      payfastMerchantKey: 'pf-key',
      payfastPassphrase: 'pf-pass',
      payfastIsSandbox: true,
      gatewayOrder: ['PAYFAST'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      reference: 'INV-PF-SANDBOX',
      gateway: 'PAYFAST',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1000,
      gateway: 'PAYFAST',
      reference: 'INV-PF-SANDBOX',
    });

    const redirect = new URL(result.redirectUrl);
    expect(redirect.origin).toBe('https://sandbox.payfast.co.za');
    expect(redirect.pathname).toBe('/eng/process');
  });

  it('uses live PayFast process host when merchant payfastIsSandbox=false', async () => {
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      payfastMerchantId: '10046276',
      payfastMerchantKey: 'pf-key',
      payfastPassphrase: 'pf-pass',
      payfastIsSandbox: false,
      gatewayOrder: ['PAYFAST'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      reference: 'INV-PF-LIVE',
      gateway: 'PAYFAST',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1000,
      gateway: 'PAYFAST',
      reference: 'INV-PF-LIVE',
    });

    const redirect = new URL(result.redirectUrl);
    expect(redirect.origin).toBe('https://www.payfast.co.za');
    expect(redirect.pathname).toBe('/eng/process');
  });

  it('failover creates the next Yoco attempt for AUTO-routed payments', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_failover_123',
        redirectUrl: 'https://c.yoco.com/checkout/failover123',
        processingMode: 'test',
      }),
    });
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p-1',
      merchantId: 'm-1',
      reference: 'INV-FAILOVER',
      amountCents: 2500,
      currency: 'ZAR',
      status: 'CREATED',
      gateway: 'OZOW',
      checkoutToken: 'tok-failover',
      customerEmail: 'buyer@example.com',
      description: 'Failover order',
      rawGateway: {
        routing: {
          requestedGateway: 'AUTO',
        },
      },
      merchant: {
        ...merchantBase,
        ozowSiteCode: 'SC-1',
        ozowPrivateKey: 'oz-private',
        yocoPublicKey: 'pk_test_public',
        yocoSecretKey: 'sk_test_secret',
        yocoTestMode: true,
        gatewayOrder: ['YOCO', 'OZOW'],
      },
      attempts: [{ gateway: 'OZOW' }],
    });

    prisma.paymentAttempt.create.mockResolvedValue({ id: 'att-next' });

    const result = await service.failoverPayment('m-1', 'INV-FAILOVER');

    expect(prisma.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentId: 'p-1',
          gateway: 'YOCO',
          redirectUrl: 'https://c.yoco.com/checkout/failover123',
        }),
      }),
    );
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-1' },
        data: expect.objectContaining({
          gateway: 'YOCO',
          status: 'PENDING',
        }),
      }),
    );
    expect(result.attemptId).toBe('att-next');
    expect(result.redirectUrl).toBe('https://c.yoco.com/checkout/failover123');
    expect(result.gateway).toBe('YOCO');
  });

  it('does not auto-failover when the payment was explicitly pinned to a gateway', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p-locked',
      merchantId: 'm-1',
      reference: 'INV-LOCKED',
      amountCents: 2500,
      currency: 'ZAR',
      status: 'CREATED',
      gateway: 'YOCO',
      checkoutToken: 'tok-locked',
      customerEmail: 'buyer@example.com',
      description: 'Locked order',
      rawGateway: {
        routing: {
          requestedGateway: 'YOCO',
        },
      },
      merchant: {
        ...merchantBase,
        ozowSiteCode: 'SC-1',
        ozowPrivateKey: 'oz-private',
        yocoPublicKey: 'pk_test_public',
        yocoSecretKey: 'sk_test_secret',
        yocoTestMode: true,
      },
      attempts: [{ gateway: 'YOCO' }],
    });

    await expect(service.failoverPayment('m-1', 'INV-LOCKED')).rejects.toThrow(
      'Automatic failover is disabled because this payment is locked to Yoco',
    );
  });


  it('cancels the superseded Yoco attempt when hosted checkout switches explicitly to Ozow', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p-switch',
      checkoutToken: 'checkout-switch',
      merchantId: 'm-1',
      reference: 'INV-SWITCH',
      amountCents: 2500,
      currency: 'ZAR',
      status: 'CREATED',
      description: 'Switch order',
      customerEmail: 'buyer@example.com',
      expiresAt: new Date('2099-03-20T10:00:00.000Z'),
      gateway: 'YOCO',
      rawGateway: {
        routing: {
          requestedGateway: 'AUTO',
        },
      },
      merchant: {
        name: 'Switch Merchant',
      },
      attempts: [
        {
          redirectUrl: 'https://c.yoco.com/checkout/ch_123',
          gateway: 'YOCO',
        },
      ],
    });
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      id: 'm-1',
      name: 'Switch Merchant',
      ozowSiteCode: 'MERCHANT-SC',
      ozowPrivateKey: 'merchant-private',
      ozowApiKey: 'merchant-api',
      ozowIsTest: true,
      yocoPublicKey: 'pk_test_public',
      yocoSecretKey: 'sk_test_secret',
      yocoTestMode: true,
      gatewayOrder: ['YOCO', 'OZOW'],
    });
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.continueHostedCheckout('checkout-switch', 'OZOW');

    expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        paymentId: 'p-switch',
        gateway: { not: 'OZOW' },
        status: { in: ['CREATED', 'PENDING'] },
      },
      data: {
        status: 'CANCELLED',
      },
    });
    expect(prisma.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentId: 'p-switch',
          gateway: 'OZOW',
        }),
      }),
    );
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-switch' },
        data: expect.objectContaining({
          gateway: 'OZOW',
        }),
      }),
    );
    expect(result.gateway).toBe('OZOW');
    expect(result.redirectForm?.action).toBe('https://pay.ozow.com');
    expect(result.redirectForm?.fields.SuccessUrl).toContain('reference=INV-SWITCH');
  });

  it('maps public signup payload into an Ozow payment with defaults', async () => {
    merchantsService.createPendingMerchantSignup.mockResolvedValue({
      merchant: {
        id: 'm-signup',
        name: 'Stackaura Test',
        email: 'admin@test.com',
      },
      apiKey: null,
    });
    prisma.merchant.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...merchantBase,
        id: 'm-signup',
        ozowSiteCode: 'SC-1',
        ozowPrivateKey: 'oz-private',
        ozowApiKey: 'oz-api',
        gatewayOrder: ['OZOW'],
      });
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      id: 'p-signup',
      merchantId: 'm-signup',
      reference: 'SIGNUP-MSIGNUP',
      amountCents: 9900,
      gateway: 'OZOW',
      customerEmail: 'admin@test.com',
      description: 'Stackaura merchant signup - Stackaura Test',
    });
    prisma.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ rawGateway: { provider: 'OZOW' } });

    const result = await service.initiatePublicOzowSignup({
      flow: 'merchant_signup',
      signup: {
        businessName: 'Stackaura Test',
        email: 'admin@test.com',
        password: 'password123',
        country: 'South Africa',
      },
      returnUrls: {
        success: 'https://stackaura.co.za/payments/success',
        cancel: 'https://stackaura.co.za/payments/cancel',
        error: 'https://stackaura.co.za/payments/error',
      },
    });

    expect(merchantsService.createPendingMerchantSignup).toHaveBeenCalledWith({
      businessName: 'Stackaura Test',
      email: 'admin@test.com',
      password: 'password123',
      country: 'South Africa',
    });
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantId: 'm-signup',
          amountCents: 9900,
          currency: 'ZAR',
          gateway: 'OZOW',
          customerEmail: 'admin@test.com',
          description: 'Stackaura merchant signup - Stackaura Test',
        }),
      }),
    );
    expect(prisma.payment.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'p-signup' },
        data: expect.objectContaining({
          rawGateway: expect.objectContaining({
            publicFlow: expect.objectContaining({
              flow: 'merchant_signup',
              merchantId: 'm-signup',
              signup: expect.objectContaining({
                businessName: 'Stackaura Test',
                email: 'admin@test.com',
                country: 'South Africa',
              }),
            }),
          }),
        }),
      }),
    );
    expect(result.redirectForm?.action).toBe('https://pay.ozow.com');
  });

  it('fulfills a paid signup payment once by activating the merchant and issuing an api key', async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: 'p-signup-paid',
      merchantId: 'm-signup',
      reference: 'SIGNUP-MSIGNUP',
      status: 'PAID',
      rawGateway: {
        publicFlow: {
          flow: 'merchant_signup',
          merchantId: 'm-signup',
          fulfillment: {
            status: 'PENDING',
          },
        },
      },
    });
    prisma.merchant.findUnique.mockResolvedValue({
      id: 'm-signup',
      isActive: false,
    });
    merchantsService.ensureInitialApiKey.mockResolvedValue({
      created: true,
      apiKey: null,
      apiKeyId: 'key-1',
      label: 'signup-initial',
      prefix: 'ck_test_abcd',
      last4: '1234',
    });

    const result = await service.fulfillPaidSignupPayment('p-signup-paid');

    expect(merchantsService.ensureInitialApiKey).toHaveBeenCalledWith(
      'm-signup',
    );
    expect(prisma.merchant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm-signup' },
        data: { isActive: true },
      }),
    );
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-signup-paid' },
        data: expect.objectContaining({
          rawGateway: expect.objectContaining({
            publicFlow: expect.objectContaining({
              fulfillment: expect.objectContaining({
                status: 'COMPLETED',
                merchantId: 'm-signup',
                apiKeyId: 'key-1',
                apiKeyIssued: true,
                merchantActivated: true,
              }),
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        paymentId: 'p-signup-paid',
        merchantId: 'm-signup',
        fulfilled: true,
        merchantActivated: true,
        apiKeyIssued: true,
        apiKeyId: 'key-1',
      }),
    );
  });

  it('does nothing when a paid signup payment is already fulfilled', async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: 'p-signup-paid',
      merchantId: 'm-signup',
      reference: 'SIGNUP-MSIGNUP',
      status: 'PAID',
      rawGateway: {
        publicFlow: {
          flow: 'merchant_signup',
          merchantId: 'm-signup',
          fulfillment: {
            status: 'COMPLETED',
            apiKeyId: 'key-1',
          },
        },
      },
    });

    const result = await service.fulfillPaidSignupPayment('p-signup-paid');

    expect(merchantsService.ensureInitialApiKey).not.toHaveBeenCalled();
    expect(prisma.merchant.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        paymentId: 'p-signup-paid',
        fulfilled: false,
        reason: 'already_fulfilled',
        apiKeyId: 'key-1',
      }),
    );
  });

  it('lists payments with merchant scope, filters, and cursor pagination', async () => {
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'p-new',
        reference: 'INV-NEW',
        status: 'PAID',
        gateway: 'PAYFAST',
        amountCents: 1500,
        platformFeeCents: 100,
        merchantNetCents: 1400,
        currency: 'ZAR',
        customerEmail: 'new@example.com',
        description: 'Newest',
        createdAt: new Date('2026-02-27T10:00:00.000Z'),
        updatedAt: new Date('2026-02-27T10:01:00.000Z'),
        gatewayRef: 'pf-new',
        expiresAt: new Date('2026-02-27T11:00:00.000Z'),
        checkoutToken: 'tok-new',
        attempts: [
          {
            id: 'att-new-2',
            gateway: 'PAYFAST',
            status: 'CREATED',
            createdAt: new Date('2026-02-27T10:00:00.000Z'),
            updatedAt: new Date('2026-02-27T10:00:30.000Z'),
          },
          {
            id: 'att-new-1',
            gateway: 'OZOW',
            status: 'CREATED',
            createdAt: new Date('2026-02-27T09:58:00.000Z'),
            updatedAt: new Date('2026-02-27T09:58:20.000Z'),
          },
        ],
      },
      {
        id: 'p-old',
        reference: 'INV-OLD',
        status: 'PAID',
        gateway: 'PAYFAST',
        amountCents: 900,
        platformFeeCents: 50,
        merchantNetCents: 850,
        currency: 'ZAR',
        customerEmail: 'old@example.com',
        description: 'Older',
        createdAt: new Date('2026-02-26T10:00:00.000Z'),
        updatedAt: new Date('2026-02-26T10:01:00.000Z'),
        gatewayRef: 'pf-old',
        expiresAt: new Date('2026-02-26T11:00:00.000Z'),
        checkoutToken: 'tok-old',
        attempts: [],
      },
    ]);

    const result = await service.listPayments('m-1', {
      status: 'PAID',
      gateway: 'PAYFAST',
      from: '2026-02-27',
      to: '2026-02-27',
      q: 'INV',
      limit: '1',
    });

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          merchantId: 'm-1',
          status: 'PAID',
          gateway: 'PAYFAST',
          createdAt: {
            gte: new Date('2026-02-27T00:00:00.000Z'),
            lte: new Date('2026-02-27T23:59:59.999Z'),
          },
          OR: expect.arrayContaining([
            expect.objectContaining({
              reference: expect.objectContaining({
                contains: 'INV',
                mode: 'insensitive',
              }),
            }),
          ]),
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(
      expect.objectContaining({
        id: 'p-new',
        reference: 'INV-NEW',
        platformFeeCents: 100,
        merchantNetCents: 1400,
        currentAttemptId: 'att-new-2',
        attempts: expect.arrayContaining([
          expect.objectContaining({
            id: 'att-new-2',
            gateway: 'PAYFAST',
          }),
          expect.objectContaining({
            id: 'att-new-1',
            gateway: 'OZOW',
          }),
        ]),
        checkoutUrl: expect.stringContaining('/v1/checkout/tok-new'),
      }),
    );
    expect(result.nextCursor).toBeDefined();
    expect(result.data[0]).not.toHaveProperty('checkoutToken');
  });

  it('returns payment with attempts and currentAttemptId by reference', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p-ref',
      merchantId: 'm-1',
      reference: 'INV-REF',
      currency: 'ZAR',
      amountCents: 2500,
      platformFeeCents: 100,
      merchantNetCents: 2400,
      status: 'PENDING',
      gateway: 'PAYFAST',
      checkoutToken: 'tok-ref',
      expiresAt: new Date('2026-02-27T11:00:00.000Z'),
      customerEmail: 'buyer@example.com',
      description: 'Reference payment',
      gatewayRef: null,
      createdAt: new Date('2026-02-27T10:00:00.000Z'),
      updatedAt: new Date('2026-02-27T10:01:00.000Z'),
      attempts: [
        {
          id: 'att-ref-2',
          gateway: 'PAYFAST',
          status: 'CREATED',
          createdAt: new Date('2026-02-27T10:00:00.000Z'),
          updatedAt: new Date('2026-02-27T10:00:30.000Z'),
          redirectUrl: 'https://www.payfast.co.za/eng/process?x=2',
        },
        {
          id: 'att-ref-1',
          gateway: 'OZOW',
          status: 'CREATED',
          createdAt: new Date('2026-02-27T09:58:00.000Z'),
          updatedAt: new Date('2026-02-27T09:58:30.000Z'),
          redirectUrl: 'https://pay.ozow.com?x=1',
        },
      ],
    });

    const result = await service.getPaymentByReference('m-1', 'INV-REF');

    expect(result.currentAttemptId).toBe('att-ref-2');
    expect(result.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'att-ref-2',
          gateway: 'PAYFAST',
          redirectUrl: 'https://www.payfast.co.za/eng/process?x=2',
        }),
        expect.objectContaining({
          id: 'att-ref-1',
          gateway: 'OZOW',
          redirectUrl: 'https://pay.ozow.com?x=1',
        }),
      ]),
    );
  });

  it('lists attempts newest-first by payment reference', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p-attempts',
      reference: 'INV-ATTEMPTS',
      attempts: [
        {
          id: 'att-2',
          gateway: 'PAYFAST',
          status: 'CREATED',
          createdAt: new Date('2026-02-27T10:00:00.000Z'),
          updatedAt: new Date('2026-02-27T10:00:30.000Z'),
          redirectUrl: 'https://www.payfast.co.za/eng/process?x=2',
        },
        {
          id: 'att-1',
          gateway: 'OZOW',
          status: 'CREATED',
          createdAt: new Date('2026-02-27T09:58:00.000Z'),
          updatedAt: new Date('2026-02-27T09:58:20.000Z'),
          redirectUrl: 'https://pay.ozow.com?x=1',
        },
      ],
    });

    const result = await service.listPaymentAttempts('m-1', 'INV-ATTEMPTS');

    expect(result.currentAttemptId).toBe('att-2');
    expect(result.attempts).toEqual([
      expect.objectContaining({
        id: 'att-2',
        gateway: 'PAYFAST',
        redirectUrl: 'https://www.payfast.co.za/eng/process?x=2',
      }),
      expect.objectContaining({
        id: 'att-1',
        gateway: 'OZOW',
        redirectUrl: 'https://pay.ozow.com?x=1',
      }),
    ]);
  });

  it('rejects invalid list filters', async () => {
    await expect(
      service.listPayments('m-1', { status: 'DONE' }),
    ).rejects.toThrow(
      'status must be one of CREATED, PENDING, PAID, FAILED, CANCELLED',
    );
  });
});
