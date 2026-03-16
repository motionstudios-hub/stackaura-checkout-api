/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { OzowGateway } from '../gateways/ozow.gateway';
import { PayfastGateway } from '../gateways/payfast.gateway';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingEngine } from '../routing/routing.engine';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: {
    merchant: { findUnique: jest.Mock };
    payment: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    paymentAttempt: {
      create: jest.Mock;
    };
    $transaction: jest.Mock;
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
    prisma = {
      merchant: { findUnique: jest.fn() },
      payment: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentAttempt: {
        create: jest.fn(),
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

    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.paymentAttempt.create.mockResolvedValue({ id: 'att-1' });
    prisma.payment.update.mockResolvedValue({ id: 'p-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        RoutingEngine,
        GatewayRegistry,
        PayfastGateway,
        OzowGateway,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
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

  it('AUTO chooses OZOW first when OZOW is configured in gateway order', async () => {
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      payfastMerchantId: 'pf-mid',
      payfastMerchantKey: 'pf-key',
      ozowSiteCode: 'SC-1',
      ozowPrivateKey: 'oz-private',
      gatewayOrder: ['OZOW', 'PAYFAST'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      gateway: 'OZOW',
      reference: 'INV-AUTO-OZOW',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1000,
      reference: 'INV-AUTO-OZOW',
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

  it('AUTO falls back to PAYFAST when OZOW is not configured', async () => {
    prisma.merchant.findUnique.mockResolvedValue({
      ...merchantBase,
      payfastMerchantId: 'pf-mid',
      payfastMerchantKey: 'pf-key',
      ozowSiteCode: null,
      ozowPrivateKey: null,
      gatewayOrder: ['OZOW', 'PAYFAST'],
    });
    prisma.payment.create.mockResolvedValue({
      ...paymentBase,
      gateway: 'PAYFAST',
      reference: 'INV-AUTO-PAYFAST',
    });

    const result = await service.createPayment('m-1', {
      amountCents: 1000,
      reference: 'INV-AUTO-PAYFAST',
      gateway: 'AUTO',
    });

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gateway: 'PAYFAST',
        }),
      }),
    );
    expect(result.gateway).toBe('PAYFAST');
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

  it('failover creates next attempt and returns a new redirectUrl', async () => {
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
      merchant: {
        ...merchantBase,
        payfastMerchantId: 'pf-mid',
        payfastMerchantKey: 'pf-key',
        payfastPassphrase: 'pf-pass',
        ozowSiteCode: 'SC-1',
        ozowPrivateKey: 'oz-private',
        gatewayOrder: ['OZOW', 'PAYFAST'],
      },
      attempts: [{ gateway: 'OZOW' }],
    });

    prisma.paymentAttempt.create.mockResolvedValue({ id: 'att-next' });

    const result = await service.failoverPayment('m-1', 'INV-FAILOVER');

    expect(prisma.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentId: 'p-1',
          gateway: 'PAYFAST',
          redirectUrl: expect.stringMatching(
            /^https:\/\/(?:sandbox\.)?payfast\.co\.za\/eng\/process\?/,
          ),
        }),
      }),
    );
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-1' },
        data: expect.objectContaining({
          gateway: 'PAYFAST',
          status: 'PENDING',
        }),
      }),
    );
    expect(result.attemptId).toBe('att-next');
    expect(result.redirectUrl).toMatch(
      /^https:\/\/(?:sandbox\.)?payfast\.co\.za\/eng\/process\?/,
    );
    expect(result.redirectUrl).not.toContain('https://pay.ozow.com?');
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
