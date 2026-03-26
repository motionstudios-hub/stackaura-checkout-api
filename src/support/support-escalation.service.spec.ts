import { SupportMessageRole } from '@prisma/client';
import { SupportEscalationService } from './support-escalation.service';
import type { MerchantSupportContext } from './support.types';

function buildMerchantContext(
  overrides: Partial<MerchantSupportContext> = {},
): MerchantSupportContext {
  const baseContext: MerchantSupportContext = {
    merchant: {
      id: 'merchant-1',
      name: 'Stackaura Payments',
      email: 'mokaekgahliso@gmail.com',
      isActive: true,
      accountStatus: 'ACTIVE',
      planCode: 'growth',
      plan: {
        code: 'growth',
        source: 'merchant_plan',
        feeSource: 'merchant_plan',
        manualGatewaySelection: true,
        autoRouting: true,
        fallback: true,
      },
      currentEnvironment: 'mixed',
      createdAt: '2026-03-20T07:14:09.005Z',
      updatedAt: '2026-03-20T11:01:45.180Z',
    },
    gateways: {
      connectedCount: 3,
      ozow: {
        connected: true,
        configured: true,
        hasApiKey: true,
        hasPrivateKey: true,
        testMode: true,
      },
      yoco: {
        connected: true,
        hasPublicKey: true,
        hasSecretKey: true,
        testMode: false,
      },
      paystack: {
        connected: true,
        hasSecretKey: true,
        testMode: false,
      },
    },
    apiKeys: {
      activeCount: 2,
      testKeyCount: 1,
      liveKeyCount: 1,
      latestCreatedAt: '2026-03-20T10:00:00.000Z',
      latestLastUsedAt: '2026-03-22T20:00:00.000Z',
    },
    onboarding: {
      completed: true,
      status: 'COMPLETED',
      detail: 'Merchant is active.',
    },
    payments: {
      totalPayments: 8,
      totalVolumeCents: 10000,
      successRate: 0,
      recoveredPayments: 0,
      activeGatewaysUsed: 1,
      recentFailures: [
        {
          reference: 'INV-e83abebaf65c',
          status: 'CANCELLED',
          gateway: 'OZOW',
          updatedAt: '2026-03-22T20:42:00.000Z',
          lastAttemptGateway: 'OZOW',
          lastAttemptStatus: 'CANCELLED',
        },
        {
          reference: 'INV-e83abebaf65b',
          status: 'FAILED',
          gateway: 'OZOW',
          updatedAt: '2026-03-22T20:41:00.000Z',
          lastAttemptGateway: 'OZOW',
          lastAttemptStatus: 'FAILED',
        },
      ],
      recentRoutingIssues: [],
    },
    payouts: {
      pendingCount: 0,
      failedCount: 0,
      recent: [],
    },
    kyc: {
      tracked: false,
      status: 'UNAVAILABLE',
      detail: 'KYC not tracked.',
    },
    supportInboxEmail: 'wesupport@stackaura.co.za',
    generatedAt: '2026-03-22T20:43:00.000Z',
  };

  return {
    ...baseContext,
    ...overrides,
    merchant: {
      ...baseContext.merchant,
      ...overrides.merchant,
    },
    gateways: {
      ...baseContext.gateways,
      ...overrides.gateways,
      ozow: {
        ...baseContext.gateways.ozow,
        ...(overrides.gateways?.ozow ?? {}),
      },
      yoco: {
        ...baseContext.gateways.yoco,
        ...(overrides.gateways?.yoco ?? {}),
      },
      paystack: {
        ...baseContext.gateways.paystack,
        ...(overrides.gateways?.paystack ?? {}),
      },
    },
    apiKeys: {
      ...baseContext.apiKeys,
      ...overrides.apiKeys,
    },
    onboarding: {
      ...baseContext.onboarding,
      ...overrides.onboarding,
    },
    payments: {
      ...baseContext.payments,
      ...overrides.payments,
    },
    payouts: {
      ...baseContext.payouts,
      ...overrides.payouts,
    },
    kyc: {
      ...baseContext.kyc,
      ...overrides.kyc,
    },
  };
}

describe('SupportEscalationService formatting', () => {
  it('builds a human-readable subject, body, and json attachment', () => {
    const service = new SupportEscalationService({} as never);
    const merchantContext = buildMerchantContext();
    const conversation = {
      id: 'conversation-123',
      merchantId: merchantContext.merchant.id,
      userId: 'user-1',
      title: null,
      status: 'OPEN',
      messages: [
        {
          role: SupportMessageRole.USER,
          content: 'Why is my checkout failing?',
          createdAt: new Date('2026-03-22T20:40:00.000Z'),
        },
        {
          role: SupportMessageRole.ASSISTANT,
          content: [
            'What I can see',
            '- Ozow is connected for this merchant.',
            '- The latest relevant failed payment is INV-e83abebaf65c with status cancelled.',
            '',
            'Possible causes',
            '- Mixed test/live environment causing gateway mismatch.',
            '',
            'What to check',
            '- Confirm the Ozow mode matches the environment of the API keys.',
            '',
            'Next steps in Stackaura',
            '- Open Gateway Connections and standardize on one environment.',
          ].join('\n'),
          createdAt: new Date('2026-03-22T20:41:00.000Z'),
        },
      ],
      escalations: [],
    };

    const triage = (service as any).buildTriage({
      conversation,
      merchantContext,
      reason:
        'Merchant requested human support from the dashboard support console',
    });
    const subject = (service as any).buildEmailSubject(merchantContext, triage);
    const text = (service as any).buildEmailText(merchantContext, triage);
    const payload = (service as any).buildPayload(
      {
        conversation,
        merchantContext,
        reason:
          'Merchant requested human support from the dashboard support console',
      },
      'wesupport@stackaura.co.za',
      'summary',
      triage,
    );
    const attachment = (service as any).buildEmailAttachment(payload, triage);

    expect(subject).toBe(
      '[Support Escalation] Stackaura Payments – Checkout failures',
    );
    expect(text).toContain('🚨 New Support Escalation');
    expect(text).toContain('Conversation ID: conversation-123');
    expect(text).toContain('Merchant: Stackaura Payments');
    expect(text).toContain('Plan: Growth');
    expect(text).toContain('Environment: Mixed');
    expect(text).toContain('Issue:\nWhy is my checkout failing?');
    expect(text).toContain('🔍 Key Signals');
    expect(text).toContain('Success rate: 0.0%');
    expect(text).toContain('Environment mismatch detected');
    expect(text).toContain('⚠️ Likely Cause');
    expect(text).toContain(
      'Mixed test/live environment causing gateway mismatch',
    );
    expect(text).toContain('📊 Latest Payment');
    expect(text).toContain('INV-e83abebaf65c → CANCELLED');
    expect(text).toContain('🧠 AI Summary');
    expect(text).toContain(
      'Mixed test/live environment causing gateway mismatch',
    );
    expect(text).toContain('🧾 Full Context');
    expect(text).not.toContain('"merchant"');
    expect(attachment.filename).toBe(
      'support-escalation-conversation-123.json',
    );
    expect(
      Buffer.from(attachment.content, 'base64').toString('utf8'),
    ).toContain('"conversationId": "conversation-123"');
  });
});
