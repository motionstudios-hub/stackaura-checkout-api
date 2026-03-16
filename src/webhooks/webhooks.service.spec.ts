/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentStatus,
  PayoutStatus,
  WebhookDeliveryStatus,
} from '@prisma/client';
import { createHash, createHmac } from 'crypto';
import { OzowGateway } from '../gateways/ozow.gateway';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let prisma: {
    payment: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    paymentAttempt: {
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    merchant: {
      findUnique: jest.Mock;
    };
    webhookEndpoint: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    webhookDelivery: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    payout: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    webhookEvent: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let fetchMock: jest.Mock;
  let paymentsService: {
    recordSuccessfulPaymentLedgerByPaymentId: jest.Mock;
  };
  let ozowGateway: {
    getTransactionStatus: jest.Mock;
  };

  const encodePayfast = (value: string) =>
    encodeURIComponent(value)
      .replace(/%20/g, '+')
      .replace(/%[0-9a-f]{2}/gi, (match) => match.toUpperCase());

  const computePayfastSignature = (
    payload: Record<string, string>,
    passphrase?: string | null,
  ) => {
    const entries = Object.entries(payload)
      .filter(([key]) => key !== 'signature')
      .map(([key, value]) => [key, value.trim()] as const);

    const paramString = entries
      .map(([key, value]) => `${key}=${encodePayfast(value)}`)
      .join('&');
    const normalizedPassphrase = passphrase?.trim() ?? '';
    const toHash = normalizedPassphrase
      ? `${paramString}&passphrase=${encodePayfast(normalizedPassphrase)}`
      : paramString;
    return createHash('md5').update(toHash).digest('hex');
  };

  const computePayfastSignatureFromRawBody = (
    rawBody: string,
    passphrase?: string | null,
  ) => {
    const segments = rawBody
      .split('&')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .filter(
        (segment) => segment.split('=', 1)[0].toLowerCase() !== 'signature',
      );
    const normalizedPassphrase = passphrase?.trim();
    if (normalizedPassphrase) {
      segments.push(`passphrase=${encodePayfast(normalizedPassphrase)}`);
    }
    return createHash('md5').update(segments.join('&')).digest('hex');
  };

  const withPayfastSignature = (
    payload: Record<string, string>,
    passphrase?: string | null,
  ) => ({
    ...payload,
    signature: computePayfastSignature(payload, passphrase),
  });

  const computeOzowHashCheck = (
    payload: Record<string, string>,
    privateKey: string,
  ) => {
    const orderedKeys = [
      'SiteCode',
      'TransactionId',
      'TransactionReference',
      'Amount',
      'Status',
      'Optional1',
      'Optional2',
      'Optional3',
      'Optional4',
      'Optional5',
      'CurrencyCode',
      'IsTest',
      'StatusMessage',
    ];

    const value = orderedKeys
      .map((key) => payload[key])
      .filter((item) => item !== undefined && item !== null && item !== '')
      .join('');
    return createHash('sha512')
      .update(`${value}${privateKey}`.toLowerCase())
      .digest('hex');
  };

  const withOzowHash = (
    payload: Record<string, string>,
    privateKey: string,
  ) => ({
    ...payload,
    HashCheck: computeOzowHashCheck(payload, privateKey),
  });

  const signDerivPayload = (
    body: Record<string, unknown>,
    timestamp?: string,
  ) => {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new Error('WEBHOOK_SECRET is required in test');
    const serialized = JSON.stringify(body);
    const toSign = timestamp ? `${timestamp}.${serialized}` : serialized;
    return createHmac('sha256', secret).update(toSign).digest('hex');
  };

  const buildPayment = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'pay-1',
    merchantId: 'merch-1',
    reference: 'INV-1',
    status: PaymentStatus.CREATED,
    merchant: {
      payfastPassphrase: 'merchant-pass',
      payfastIsSandbox: true,
      ozowSiteCode: 'SC-1',
      ozowPrivateKey: 'merchant-ozow-key',
      ozowApiKey: null,
    },
    ...overrides,
  });

  beforeEach(async () => {
    process.env.PAYFAST_VERIFY_POSTBACK = 'false';
    process.env.PAYFAST_VERIFY_TIMEOUT_MS = '1000';
    process.env.WEBHOOK_SECRET = 'deriv-secret';
    process.env.WEBHOOK_MAX_ATTEMPTS = '3';
    process.env.WEBHOOK_INITIAL_DELAY_MS = '10';
    delete process.env.NODE_ENV;
    paymentsService = {
      recordSuccessfulPaymentLedgerByPaymentId: jest.fn(),
    };
    ozowGateway = {
      getTransactionStatus: jest.fn(),
    };

    prisma = {
      payment: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      paymentAttempt: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      merchant: {
        findUnique: jest.fn(),
      },
      webhookEndpoint: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      webhookDelivery: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      payout: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback({
          payment: prisma.payment,
          paymentAttempt: prisma.paymentAttempt,
          merchant: prisma.merchant,
          webhookEndpoint: prisma.webhookEndpoint,
          webhookDelivery: prisma.webhookDelivery,
          payout: prisma.payout,
          webhookEvent: prisma.webhookEvent,
        }),
      ),
    };

    prisma.merchant.findUnique.mockResolvedValue({
      payfastPassphrase: 'merchant-pass',
      ozowPrivateKey: 'merchant-ozow-key',
    });
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.webhookEvent.create.mockResolvedValue({ id: 'evt-1' });
    prisma.webhookEvent.update.mockResolvedValue({});
    prisma.webhookEndpoint.findMany.mockResolvedValue([]);
    prisma.webhookDelivery.create.mockResolvedValue({ id: 'del-1' });
    prisma.webhookDelivery.update.mockResolvedValue({});
    prisma.paymentAttempt.findFirst.mockResolvedValue({
      id: 'att-1',
      status: 'CREATED',
    });
    prisma.paymentAttempt.update.mockResolvedValue({ id: 'att-1' });
    prisma.payment.update.mockResolvedValue(
      buildPayment({
        status: PaymentStatus.PAID,
      }),
    );

    fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes('verify.local')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('VALID'),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('ok'),
      });
    });
    (global as { fetch?: jest.Mock }).fetch = fetchMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentsService, useValue: paymentsService },
        { provide: OzowGateway, useValue: ozowGateway },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
  });

  afterEach(() => {
    delete (global as { fetch?: jest.Mock }).fetch;
    delete process.env.PAYFAST_VERIFY_POSTBACK;
    delete process.env.PAYFAST_VALIDATE_URL;
    delete process.env.PAYFAST_VERIFY_URL;
    delete process.env.PAYFAST_VERIFY_TIMEOUT_MS;
    delete process.env.PAYFAST_PROCESS_URL;
    delete process.env.PAYFAST_IS_SANDBOX;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_MAX_ATTEMPTS;
    delete process.env.WEBHOOK_INITIAL_DELAY_MS;
    delete process.env.NODE_ENV;
    delete process.env.OZOW_PRIVATE_KEY;
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('normalizes array ITN values and enqueues payment_intent.succeeded delivery', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-array',
        merchantId: 'merch-array',
        reference: 'INV-array',
        status: PaymentStatus.CREATED,
      }),
    );
    prisma.payment.update.mockResolvedValue(
      buildPayment({
        id: 'pay-array',
        merchantId: 'merch-array',
        reference: 'INV-array',
        status: PaymentStatus.PAID,
      }),
    );
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'we-1', url: 'https://merchant.local/webhook' },
    ]);

    const signed = withPayfastSignature(
      {
        m_payment_id: 'INV-array',
        pf_payment_id: 'pf-array',
        payment_status: 'COMPLETE',
      },
      'merchant-pass',
    );

    await expect(
      service.handlePayfastWebhook({
        ...signed,
        m_payment_id: [' INV-array '],
        pf_payment_id: [' pf-array '],
        payment_status: [' COMPLETE '],
        signature: [signed.signature],
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-array' },
        data: expect.objectContaining({
          status: PaymentStatus.PAID,
          gatewayRef: 'pf-array',
          rawGateway: expect.objectContaining({
            m_payment_id: 'INV-array',
            pf_payment_id: 'pf-array',
            payment_status: 'COMPLETE',
          }),
        }),
      }),
    );
    expect(prisma.paymentAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: 'pay-array' },
      }),
    );
    expect(prisma.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-1' },
        data: { status: 'SUCCEEDED' },
      }),
    );
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'PAYFAST_ITN',
          providerEventId: 'pf_payment_id:pf-array',
        }),
      }),
    );
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          webhookEndpointId: 'we-1',
          event: 'payment_intent.succeeded',
          status: WebhookDeliveryStatus.PENDING,
        }),
      }),
    );
  });

  it('validates PayFast signature using rawBody field order (POST order)', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-raw-order',
        reference: 'INV-raw-order',
        status: PaymentStatus.CREATED,
      }),
    );
    prisma.payment.update.mockResolvedValue(
      buildPayment({
        id: 'pay-raw-order',
        reference: 'INV-raw-order',
        status: PaymentStatus.PAID,
      }),
    );
    prisma.paymentAttempt.findFirst.mockResolvedValue({
      id: 'att-raw-order',
      status: 'CREATED',
    });

    const rawBodyWithoutSignature =
      'm_payment_id=INV-raw-order&pf_payment_id=3030838&payment_status=COMPLETE&merchant_id=10046276&merchant_key=abc123&amount_gross=10.00&amount_fee=-0.23&amount_net=9.77&item_name=Order+123&email_address=buyer%40example.com';
    const expectedSignature = '8d4d71952b48acbab482b4c617e46dee';
    expect(
      computePayfastSignatureFromRawBody(
        rawBodyWithoutSignature,
        'merchant-pass',
      ),
    ).toBe(expectedSignature);
    const rawBody = `${rawBodyWithoutSignature}&signature=${expectedSignature}`;

    await expect(
      service.handlePayfastWebhook(
        {
          amount_fee: '-0.23',
          amount_gross: '10.00',
          amount_net: '9.77',
          email_address: 'buyer@example.com',
          item_name: 'Order 123',
          m_payment_id: 'INV-raw-order',
          merchant_id: '10046276',
          merchant_key: 'abc123',
          payment_status: 'COMPLETE',
          pf_payment_id: '3030838',
          signature: expectedSignature,
        },
        {
          rawBody,
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-raw-order' },
        data: expect.objectContaining({
          status: PaymentStatus.PAID,
          gatewayRef: '3030838',
        }),
      }),
    );
  });

  it('updates COMPLETE ITN payment from CREATED to PAID, sets gatewayRef, and marks latest attempt SUCCEEDED', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-complete',
        merchantId: 'merch-complete',
        reference: 'INV-complete',
        status: PaymentStatus.CREATED,
      }),
    );
    prisma.payment.update.mockResolvedValue(
      buildPayment({
        id: 'pay-complete',
        merchantId: 'merch-complete',
        reference: 'INV-complete',
        status: PaymentStatus.PAID,
      }),
    );
    prisma.paymentAttempt.findFirst.mockResolvedValue({
      id: 'att-complete',
      status: 'CREATED',
    });

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-complete',
            pf_payment_id: 'pf-3030838',
            payment_status: 'COMPLETE',
          },
          'merchant-pass',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-complete' },
        data: expect.objectContaining({
          status: PaymentStatus.PAID,
          gatewayRef: 'pf-3030838',
        }),
      }),
    );
    expect(prisma.paymentAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: 'pay-complete' },
      }),
    );
    expect(prisma.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-complete' },
        data: { status: 'SUCCEEDED' },
      }),
    );
  });

  it('stores hash providerEventId when pf_payment_id is missing', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-hash',
        reference: 'INV-hash',
      }),
    );

    const payload = withPayfastSignature(
      {
        m_payment_id: 'INV-hash',
        payment_status: 'PENDING',
      },
      'merchant-pass',
    );

    await service.handlePayfastWebhook(payload);

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'PAYFAST_ITN',
          providerEventId: expect.stringMatching(/^hash:[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it('deduplicates repeated ITN callbacks and skips status update', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-dup',
        reference: 'INV-dup',
      }),
    );
    prisma.webhookEvent.findUnique.mockResolvedValue({
      id: 'evt-dup',
      processedAt: new Date(),
    });

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-dup',
            pf_payment_id: 'pf-dup',
            payment_status: 'COMPLETE',
          },
          'merchant-pass',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('ignores COMPLETE ITN when payment is already PAID (idempotent)', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-already-paid',
        reference: 'INV-already-paid',
        status: PaymentStatus.PAID,
      }),
    );

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-already-paid',
            pf_payment_id: 'pf-already-paid',
            payment_status: 'COMPLETE',
          },
          'merchant-pass',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.update).not.toHaveBeenCalled();
  });

  it('updates payment once and avoids duplicate payment_intent.succeeded deliveries for repeated ITN', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-paid-once',
        merchantId: 'merch-paid-once',
        reference: 'INV-paid-once',
        status: PaymentStatus.CREATED,
      }),
    );
    prisma.payment.update.mockResolvedValue(
      buildPayment({
        id: 'pay-paid-once',
        merchantId: 'merch-paid-once',
        reference: 'INV-paid-once',
        status: PaymentStatus.PAID,
      }),
    );
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'we-paid-once', url: 'https://merchant.local/paid-once' },
    ]);
    prisma.webhookEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'evt-paid-once',
        processedAt: new Date(),
      });

    const payload = withPayfastSignature(
      {
        m_payment_id: 'INV-paid-once',
        pf_payment_id: 'pf-paid-once',
        payment_status: 'COMPLETE',
      },
      'merchant-pass',
    );

    await expect(service.handlePayfastWebhook(payload)).resolves.toEqual({
      ok: true,
    });
    await expect(service.handlePayfastWebhook(payload)).resolves.toEqual({
      ok: true,
    });

    expect(prisma.payment.update).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          webhookEndpointId: 'we-paid-once',
          event: 'payment_intent.succeeded',
          status: WebhookDeliveryStatus.PENDING,
        }),
      }),
    );
  });

  it('ignores illegal transition from PAID to FAILED', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-terminal',
        reference: 'INV-terminal',
        status: PaymentStatus.PAID,
      }),
    );

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-terminal',
            pf_payment_id: 'pf-terminal',
            payment_status: 'FAILED',
          },
          'merchant-pass',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt-1' },
        data: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    );
  });

  it('verifies PayFast signature with merchant passphrase, not env passphrase', async () => {
    process.env.PAYFAST_PASSPHRASE = 'env-pass';
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-merchant-pass',
        reference: 'INV-merchant-pass',
      }),
    );

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-merchant-pass',
            payment_status: 'COMPLETE',
          },
          'env-pass',
        ),
      ),
    ).rejects.toThrow('Invalid signature');

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-merchant-pass',
            payment_status: 'COMPLETE',
          },
          'merchant-pass',
        ),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects PAYFAST_VERIFY_POSTBACK=false in production', async () => {
    process.env.NODE_ENV = 'production';
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-prod',
        reference: 'INV-prod',
      }),
    );

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-prod',
            payment_status: 'COMPLETE',
          },
          'merchant-pass',
        ),
      ),
    ).rejects.toThrow(
      'PAYFAST_VERIFY_POSTBACK=false is not allowed in production',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses sandbox PayFast validate URL when merchant payfastIsSandbox=true', async () => {
    process.env.PAYFAST_VERIFY_POSTBACK = 'true';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('VALID'),
    });
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-sandbox-flag',
        reference: 'INV-sandbox-flag',
        merchant: {
          payfastPassphrase: 'merchant-pass',
          payfastIsSandbox: true,
        },
      }),
    );

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-sandbox-flag',
            payment_status: 'COMPLETE',
          },
          'merchant-pass',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.payfast.co.za/eng/query/validate',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('uses live PayFast validate URL when merchant payfastIsSandbox=false', async () => {
    process.env.PAYFAST_VERIFY_POSTBACK = 'true';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('VALID'),
    });
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-live-process',
        reference: 'INV-live-process',
        merchant: {
          payfastPassphrase: 'merchant-pass',
          payfastIsSandbox: false,
        },
      }),
    );

    await expect(
      service.handlePayfastWebhook(
        withPayfastSignature(
          {
            m_payment_id: 'INV-live-process',
            payment_status: 'COMPLETE',
          },
          'merchant-pass',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.payfast.co.za/eng/query/validate',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('verifies Ozow signature with env-backed configuration', async () => {
    process.env.OZOW_PRIVATE_KEY = 'env-private-key';
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-ozow-signature',
        reference: 'INV-ozow-signature',
      }),
    );

    const payload = {
      SiteCode: 'SC-1',
      TransactionId: 'oz-tx-signature',
      TransactionReference: 'INV-ozow-signature',
      Amount: '10.00',
      Status: 'Complete',
      CurrencyCode: 'ZAR',
      IsTest: 'true',
    };

    await expect(
      service.handleOzowWebhook(withOzowHash(payload, 'env-private-key')),
    ).resolves.toEqual({ ok: true });

    await expect(
      service.handleOzowWebhook(withOzowHash(payload, 'merchant-ozow-key')),
    ).rejects.toThrow('Invalid signature');
  });

  it('deduplicates Ozow webhook events by providerEventId', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-ozow-dup',
        reference: 'INV-ozow-dup',
      }),
    );
    prisma.webhookEvent.findUnique.mockResolvedValue({
      id: 'evt-ozow-dup',
      processedAt: new Date(),
    });

    await expect(
      service.handleOzowWebhook(
        withOzowHash(
          {
            SiteCode: 'SC-1',
            TransactionId: 'oz-tx-dup',
            TransactionReference: 'INV-ozow-dup',
            Amount: '10.00',
            Status: 'Complete',
            CurrencyCode: 'ZAR',
            IsTest: 'true',
          },
          'merchant-ozow-key',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('ignores illegal Ozow transition from PAID to FAILED', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-ozow-terminal',
        reference: 'INV-ozow-terminal',
        status: PaymentStatus.PAID,
      }),
    );

    await expect(
      service.handleOzowWebhook(
        withOzowHash(
          {
            SiteCode: 'SC-1',
            TransactionId: 'oz-tx-terminal',
            TransactionReference: 'INV-ozow-terminal',
            Amount: '10.00',
            Status: 'Failed',
            CurrencyCode: 'ZAR',
            IsTest: 'true',
          },
          'merchant-ozow-key',
        ),
      ),
    ).resolves.toEqual({ ok: true });

    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('normalizes Ozow payload arrays and enqueues merchant outbox delivery', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({
        id: 'pay-ozow-paid',
        merchantId: 'merch-ozow-paid',
        reference: 'INV-ozow-paid',
        status: PaymentStatus.CREATED,
      }),
    );
    prisma.payment.update.mockResolvedValue(
      buildPayment({
        id: 'pay-ozow-paid',
        merchantId: 'merch-ozow-paid',
        reference: 'INV-ozow-paid',
        status: PaymentStatus.PAID,
      }),
    );
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'we-ozow-1', url: 'https://merchant.local/ozow' },
    ]);

    const signed = withOzowHash(
      {
        SiteCode: 'SC-1',
        TransactionId: 'oz-tx-paid',
        TransactionReference: 'INV-ozow-paid',
        Amount: '10.00',
        Status: 'Complete',
        CurrencyCode: 'ZAR',
        IsTest: 'true',
      },
      'merchant-ozow-key',
    );

    await expect(
      service.handleOzowWebhook({
        ...signed,
        TransactionId: [' oz-tx-paid '],
        TransactionReference: [' INV-ozow-paid '],
        Status: [' Complete '],
        HashCheck: [signed.HashCheck],
      }),
    ).resolves.toEqual({ ok: true });

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'OZOW',
          providerEventId: 'transaction_id:oz-tx-paid',
        }),
      }),
    );
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          webhookEndpointId: 'we-ozow-1',
          event: 'payment_intent.succeeded',
          status: WebhookDeliveryStatus.PENDING,
        }),
      }),
    );
  });

  it('enqueues deliveries and does not send HTTP immediately', async () => {
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'we-1', url: 'https://merchant.local/one' },
      { id: 'we-2', url: 'https://merchant.local/two' },
    ]);

    await service.deliverEvent('merch-evt', 'payment.paid', {
      payment: { reference: 'INV-100' },
    });

    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('worker marks delivery success for 2xx responses and signs payload', async () => {
    prisma.webhookDelivery.findMany.mockResolvedValue([
      {
        id: 'del-ok',
        event: 'payment.paid',
        payload: { payment: { reference: 'INV-ok' } },
        attempts: 0,
        webhookEndpoint: {
          id: 'we-ok',
          merchantId: 'merch-ok',
          url: 'https://merchant.local/ok',
          isActive: true,
          secret: 'endpoint-secret-ok',
        },
      },
    ]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('accepted'),
    });

    await service.processPendingDeliveries();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [
      string,
      {
        method: string;
        headers: Record<string, string>;
        body: string;
      },
    ];
    expect(url).toBe('https://merchant.local/ok');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(
      JSON.stringify({
        deliveryId: 'del-ok',
        event: 'payment.paid',
        attempt: 1,
        data: { payment: { reference: 'INV-ok' } },
      }),
    );
    expect(JSON.parse(options.body)).toEqual({
      deliveryId: 'del-ok',
      event: 'payment.paid',
      attempt: 1,
      data: { payment: { reference: 'INV-ok' } },
    });
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers['X-Checkout-Event']).toBe('payment.paid');
    expect(options.headers['X-Checkout-Delivery-Id']).toBe('del-ok');
    expect(options.headers['X-Checkout-Timestamp']).toEqual(expect.any(String));
    const expectedSignature = createHmac('sha256', 'endpoint-secret-ok')
      .update(`${options.headers['X-Checkout-Timestamp']}.${options.body}`)
      .digest('hex');
    expect(options.headers['X-Checkout-Signature']).toBe(
      `sha256=${expectedSignature}`,
    );
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-ok' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.SUCCESS,
          attempts: 1,
          lastStatusCode: 200,
          nextAttemptAt: null,
        }),
      }),
    );
  });

  it('worker schedules retry with backoff when delivery fails', async () => {
    prisma.webhookDelivery.findMany.mockResolvedValue([
      {
        id: 'del-retry',
        event: 'payout.updated',
        payload: { payout: { reference: 'PO-retry' } },
        attempts: 0,
        webhookEndpoint: {
          id: 'we-retry',
          merchantId: 'merch-retry',
          url: 'https://merchant.local/retry',
          isActive: true,
          secret: 'endpoint-secret-retry',
        },
      },
    ]);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('temporary outage'),
    });

    await service.processPendingDeliveries();

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-retry' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.PENDING,
          attempts: 1,
          lastStatusCode: 500,
          lastError: 'HTTP 500: temporary outage',
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
  });

  it('worker marks terminal failure when max attempts reached', async () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = '2';
    prisma.webhookDelivery.findMany.mockResolvedValue([
      {
        id: 'del-fail',
        event: 'payout.updated',
        payload: { payout: { reference: 'PO-fail' } },
        attempts: 1,
        webhookEndpoint: {
          id: 'we-fail',
          merchantId: 'merch-fail',
          url: 'https://merchant.local/fail',
          isActive: true,
          secret: 'endpoint-secret-fail',
        },
      },
    ]);

    fetchMock.mockRejectedValueOnce(new Error('network timeout'));

    await service.processPendingDeliveries();

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-fail' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.FAILED,
          attempts: 2,
          lastStatusCode: null,
          lastError: 'network timeout',
          nextAttemptAt: null,
        }),
      }),
    );
  });

  it('deduplicates Deriv provider events', async () => {
    const body = {
      eventId: 'evt-deriv-dup',
      reference: 'PO-123',
      status: 'SUCCESS',
    };
    const signature = signDerivPayload(body);
    prisma.webhookEvent.findUnique.mockResolvedValue({
      id: 'evt-existing',
      processedAt: new Date(),
    });

    await expect(
      service.handleDerivPaWebhook(body, { signature }),
    ).resolves.toEqual({ ok: true, deduplicated: true });
    expect(prisma.payout.update).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('updates Deriv payout status and enqueues payout.updated delivery', async () => {
    const body = {
      eventId: 'evt-deriv-ok',
      reference: 'PO-200',
      status: 'SUCCESS',
      providerRef: 'drv-200',
    };
    const signature = signDerivPayload(body);

    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.webhookEvent.create.mockResolvedValue({ id: 'evt-deriv-ok' });
    prisma.payout.findUnique.mockResolvedValue({
      id: 'po-200',
      merchantId: 'merch-200',
      reference: 'PO-200',
      currency: 'ZAR',
      amountCents: 1200,
      status: PayoutStatus.PENDING,
      rail: 'DERIV',
      provider: 'DERIV_PA',
      providerRef: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.payout.update.mockResolvedValue({
      id: 'po-200',
      merchantId: 'merch-200',
      reference: 'PO-200',
      currency: 'ZAR',
      amountCents: 1200,
      status: PayoutStatus.SUCCESS,
      rail: 'DERIV',
      provider: 'DERIV_PA',
      providerRef: 'drv-200',
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'we-payout-1', url: 'https://merchant.local/payout' },
    ]);

    await expect(
      service.handleDerivPaWebhook(body, { signature }),
    ).resolves.toEqual({ ok: true, deduplicated: false });

    expect(prisma.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'po-200' },
        data: expect.objectContaining({
          status: PayoutStatus.SUCCESS,
          providerRef: 'drv-200',
        }),
      }),
    );
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          webhookEndpointId: 'we-payout-1',
          event: 'payout.updated',
          status: WebhookDeliveryStatus.PENDING,
        }),
      }),
    );
  });
});
