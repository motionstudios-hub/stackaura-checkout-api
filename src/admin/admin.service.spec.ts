import { Test, TestingModule } from '@nestjs/testing';
import {
  GatewayProvider,
  PaymentStatus,
  SupportEscalationStatus,
  WebhookDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: { [key: string]: unknown };

  beforeEach(async () => {
    prisma = {
      merchant: {
        findMany: jest.fn(),
      },
      payment: {
        findMany: jest.fn(),
      },
      webhookDelivery: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      supportConversation: {
        count: jest.fn(),
      },
      supportEscalation: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AdminService);
  });

  it('builds real summary metrics from merchant, payment, webhook, and support data', async () => {
    (prisma.merchant.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'm-1',
        name: 'Merchant One',
        email: 'one@example.com',
        isActive: true,
        createdAt: new Date('2026-03-20T10:00:00.000Z'),
      },
      {
        id: 'm-2',
        name: 'Merchant Two',
        email: 'two@example.com',
        isActive: false,
        createdAt: new Date('2026-03-24T11:00:00.000Z'),
      },
    ]);
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'p-1',
        reference: 'PAY-1',
        baseAmountCents: 5000,
        amountCents: 5000,
        platformFeeCents: 125,
        providerFeeCents: null,
        merchantNetCents: 5000,
        status: PaymentStatus.PAID,
        gateway: GatewayProvider.PAYSTACK,
        createdAt: new Date('2026-03-24T09:00:00.000Z'),
        updatedAt: new Date('2026-03-24T09:02:00.000Z'),
        expiresAt: new Date('2026-03-24T09:30:00.000Z'),
        rawGateway: { routing: { fallbackCount: 1 } },
        merchant: { id: 'm-1', name: 'Merchant One' },
        attempts: [
          {
            gateway: GatewayProvider.PAYSTACK,
            status: 'FAILED',
            createdAt: new Date('2026-03-24T09:00:00.000Z'),
          },
          {
            gateway: GatewayProvider.YOCO,
            status: 'PAID',
            createdAt: new Date('2026-03-24T09:01:00.000Z'),
          },
        ],
      },
      {
        id: 'p-2',
        reference: 'PAY-2',
        baseAmountCents: 2500,
        amountCents: 2500,
        platformFeeCents: 50,
        providerFeeCents: null,
        merchantNetCents: 2500,
        status: PaymentStatus.FAILED,
        gateway: GatewayProvider.OZOW,
        createdAt: new Date('2026-03-23T09:00:00.000Z'),
        updatedAt: new Date('2026-03-23T09:03:00.000Z'),
        expiresAt: new Date('2026-03-23T09:30:00.000Z'),
        rawGateway: null,
        merchant: { id: 'm-2', name: 'Merchant Two' },
        attempts: [
          {
            gateway: GatewayProvider.OZOW,
            status: 'FAILED',
            createdAt: new Date('2026-03-23T09:00:00.000Z'),
          },
        ],
      },
    ]);
    (prisma.webhookDelivery.count as jest.Mock)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'wd-1',
        event: 'payment_intent.failed',
        status: WebhookDeliveryStatus.FAILED,
        attempts: 3,
        lastError: '500 upstream',
        nextAttemptAt: null,
        updatedAt: new Date('2026-03-24T08:00:00.000Z'),
        webhookEndpoint: {
          url: 'https://merchant.example/webhooks',
          merchant: { id: 'm-1', name: 'Merchant One' },
        },
      },
    ]);
    (prisma.supportConversation.count as jest.Mock).mockResolvedValue(4);
    (prisma.supportEscalation.count as jest.Mock).mockResolvedValue(2);
    (prisma.supportEscalation.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'se-1',
        status: SupportEscalationStatus.PENDING,
        reason: 'Payment routing issue',
        emailTo: 'wesupport@stackaura.co.za',
        createdAt: new Date('2026-03-24T07:30:00.000Z'),
        merchant: { id: 'm-1', name: 'Merchant One' },
        conversation: { id: 'sc-1', title: 'Why are payments failing?' },
      },
    ]);

    const result = await service.getOverview();

    expect(result.business.totalMerchants).toBe(2);
    expect(result.business.activeMerchants).toBe(1);
    expect(result.business.newSignups.today).toBeGreaterThanOrEqual(1);
    expect(result.payments.totalPayments).toBe(2);
    expect(result.payments.failedPayments).toBe(1);
    expect(result.payments.successRate).toBe(50);
    expect(result.payments.failoverCount).toBe(1);
    expect(result.payments.gatewayUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateway: GatewayProvider.YOCO, count: 1 }),
        expect.objectContaining({ gateway: GatewayProvider.OZOW, count: 1 }),
      ]),
    );
    expect(result.operations.webhookIssues.totalIssues).toBe(3);
    expect(result.operations.support.conversationCount).toBe(4);
    expect(result.revenue.grossProcessedVolumeCents).toBe(5000);
    expect(result.revenue.stackauraFeeEarnedCents).toBe(125);
    expect(result.revenue.providerFeesAvailable).toBe(false);
    expect(result.funnel.counts.paid).toBe(1);
    expect(result.gatewayHealth.byGateway).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateway: GatewayProvider.YOCO,
          successRate: 100,
        }),
        expect.objectContaining({
          gateway: GatewayProvider.OZOW,
          failureRate: 100,
        }),
      ]),
    );
    expect(result.operations.recentIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'payment_error', title: 'PAY-2' }),
        expect.objectContaining({
          kind: 'webhook_issue',
          title: 'payment_intent.failed',
        }),
        expect.objectContaining({
          kind: 'support_escalation',
          title: 'Why are payments failing?',
        }),
      ]),
    );
  });
});
