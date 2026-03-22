import { SupportAiService } from './support-ai.service';
import type { MerchantSupportContext } from './support.types';

function buildContext(
  overrides: Partial<MerchantSupportContext> = {},
): MerchantSupportContext {
  const baseContext: MerchantSupportContext = {
    merchant: {
      id: 'merchant-1',
      name: 'Stackaura Test Merchant',
      email: 'merchant@test.com',
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
      currentEnvironment: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    gateways: {
      connectedCount: 1,
      ozow: {
        connected: true,
        testMode: true,
        hasApiKey: true,
        hasPrivateKey: true,
        siteCode: 'K20-K20-164',
      },
      yoco: { connected: false, testMode: true },
      paystack: { connected: false, testMode: true },
    },
    apiKeys: {
      activeCount: 1,
      testKeyCount: 1,
      liveKeyCount: 0,
      latestCreatedAt: new Date().toISOString(),
      latestLastUsedAt: null,
    },
    onboarding: {
      completed: true,
      status: 'COMPLETED',
      detail: 'Merchant is active.',
    },
    payments: {
      totalPayments: 4,
      totalVolumeCents: 9900,
      successRate: 75,
      recoveredPayments: 1,
      activeGatewaysUsed: 1,
      recentFailures: [],
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
    generatedAt: new Date().toISOString(),
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

describe('SupportAiService', () => {
  it('recommends escalation for fraud-like issues in fallback mode', async () => {
    const service = new SupportAiService();
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousSupportAiKey = process.env.SUPPORT_AI_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SUPPORT_AI_OPENAI_API_KEY;

    try {
      const reply = await service.generateReply({
        merchantContext: buildContext(),
        userMessage:
          'I think there is fraud on my account and I need a human to review it',
        conversationHistory: [],
        knowledgeMatches: [],
      });

      expect(reply.provider).toBe('fallback');
      expect(reply.escalationRecommended).toBe(true);
      expect(reply.content).toContain('wesupport@stackaura.co.za');
    } finally {
      if (previousOpenAiKey) {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousSupportAiKey) {
        process.env.SUPPORT_AI_OPENAI_API_KEY = previousSupportAiKey;
      }
    }
  });

  it('treats provider-specific failure questions as troubleshooting requests', async () => {
    const service = new SupportAiService();
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousSupportAiKey = process.env.SUPPORT_AI_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SUPPORT_AI_OPENAI_API_KEY;

    try {
      const reply = await service.generateReply({
        merchantContext: buildContext({
          payments: {
            totalPayments: 8,
            totalVolumeCents: 14900,
            successRate: 62.5,
            recoveredPayments: 2,
            activeGatewaysUsed: 2,
            recentFailures: [
              {
                reference: 'INV-OZ-1001',
                status: 'FAILED',
                gateway: 'OZOW',
                updatedAt: '2026-03-22T19:32:00.000Z',
                lastAttemptGateway: 'OZOW',
                lastAttemptStatus: 'FAILED',
              },
            ],
            recentRoutingIssues: [
              {
                reference: 'INV-OZ-1001',
                status: 'FAILED',
                routeSummary: 'AUTO -> OZOW',
                fallbackCount: 0,
                createdAt: '2026-03-22T19:31:00.000Z',
              },
            ],
          },
        }),
        userMessage: 'Why are my Ozow payments failing?',
        conversationHistory: [],
        knowledgeMatches: [],
      });

      expect(reply.provider).toBe('fallback');
      expect(reply.content).toContain('What I can see');
      expect(reply.content).toContain('Possible causes');
      expect(reply.content).toContain('What to check');
      expect(reply.content).toContain('Next steps in Stackaura');
      expect(reply.content).toContain('Ozow');
      expect(reply.content).toContain('INV-OZ-1001');
    } finally {
      if (previousOpenAiKey) {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousSupportAiKey) {
        process.env.SUPPORT_AI_OPENAI_API_KEY = previousSupportAiKey;
      }
    }
  });

  it('flags environment mismatches as a likely cause during troubleshooting', async () => {
    const service = new SupportAiService();
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousSupportAiKey = process.env.SUPPORT_AI_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SUPPORT_AI_OPENAI_API_KEY;

    try {
      const reply = await service.generateReply({
        merchantContext: buildContext({
          merchant: {
            currentEnvironment: 'live',
          },
          apiKeys: {
            activeCount: 1,
            testKeyCount: 0,
            liveKeyCount: 1,
            latestCreatedAt: new Date().toISOString(),
            latestLastUsedAt: null,
          },
          gateways: {
            ozow: {
              connected: true,
              testMode: true,
              hasApiKey: true,
              hasPrivateKey: true,
              siteCode: 'K20-K20-164',
            },
          },
        }),
        userMessage: 'Ozow checkout keeps failing in live mode',
        conversationHistory: [],
        knowledgeMatches: [],
      });

      expect(reply.content).toContain('Possible causes');
      expect(reply.content).toContain('workspace looks live');
      expect(reply.content).toContain('test mode');
      expect(reply.content).toContain('Gateway Connections');
    } finally {
      if (previousOpenAiKey) {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousSupportAiKey) {
        process.env.SUPPORT_AI_OPENAI_API_KEY = previousSupportAiKey;
      }
    }
  });
});
