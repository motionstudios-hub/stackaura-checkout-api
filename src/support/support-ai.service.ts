import { Injectable, Logger } from '@nestjs/common';
import {
  MerchantSupportContext,
  SupportAssistantReply,
  SupportKnowledgeMatch,
} from './support.types';

type SupportAiRequest = {
  merchantContext: MerchantSupportContext;
  userMessage: string;
  conversationHistory: Array<{
    role: 'USER' | 'ASSISTANT' | 'SYSTEM';
    content: string;
  }>;
  knowledgeMatches: SupportKnowledgeMatch[];
};

type SupportTopic =
  | 'gateway'
  | 'api_keys'
  | 'onboarding'
  | 'payments'
  | 'payment_troubleshooting'
  | 'payouts'
  | 'integration'
  | 'general';

type GatewayName = 'ozow' | 'yoco' | 'paystack';

type GatewaySnapshot = {
  connected: boolean;
  testMode: boolean | null;
  updatedAt: string | null;
  hasApiKey: boolean;
  hasPrivateKey: boolean;
  hasPublicKey: boolean;
  hasSecretKey: boolean;
  webhookConfigured: boolean;
  siteCode: string | null;
};

type TroubleshootingReply = {
  content: string;
  usedContextSignals: boolean;
};

@Injectable()
export class SupportAiService {
  private readonly logger = new Logger(SupportAiService.name);

  async generateReply(args: SupportAiRequest): Promise<SupportAssistantReply> {
    const escalationReason = this.detectEscalationNeed(args.userMessage);
    const fallbackReply = this.buildFallbackReply(args, escalationReason);
    const apiKey =
      process.env.SUPPORT_AI_OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      '';

    if (!apiKey) {
      return fallbackReply;
    }

    try {
      const reply = await this.generateOpenAiReply(args, apiKey);
      return {
        content: reply,
        citations: fallbackReply.citations,
        escalationRecommended: fallbackReply.escalationRecommended,
        escalationReason: fallbackReply.escalationReason,
        provider: 'openai',
      };
    } catch (error) {
      this.logger.warn(
        `Support AI provider unavailable, falling back to local guidance: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallbackReply;
    }
  }

  private async generateOpenAiReply(
    args: SupportAiRequest,
    apiKey: string,
  ): Promise<string> {
    const model = process.env.SUPPORT_AI_MODEL?.trim() || 'gpt-4.1-mini';
    const payload = {
      model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: this.buildSystemPrompt(args),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: this.buildUserPrompt(args),
            },
          ],
        },
      ],
    };

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI support response failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<{
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    };

    const directText = data.output_text?.trim();
    if (directText) {
      return directText;
    }

    const outputText = data.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();

    if (!outputText) {
      throw new Error('OpenAI support response did not include output text');
    }

    return outputText;
  }

  private buildSystemPrompt(args: SupportAiRequest) {
    return [
      'You are Stackaura Support AI inside the authenticated merchant dashboard.',
      'You are merchant-aware, read-only, and should use only the supplied merchant context and knowledge snippets.',
      'Never reveal raw secrets or claim to have taken actions you did not take.',
      'Treat questions about failed payments, failing gateways, declined transactions, or checkout errors as troubleshooting requests, not just state lookups.',
      'Use merchant context first: gateway state, environment, onboarding status, recent failed payments, and routing issues.',
      'For troubleshooting answers, structure the reply with short sections: What I can see, Possible causes, What to check, Next steps in Stackaura.',
      'Be explicit about what is confirmed by the current context versus what is only a possible cause.',
      'Only lean on generic documentation when the merchant context is insufficient for a concrete diagnosis.',
      'Explain what you know, what is missing, and the most practical next step.',
      `If the issue looks like billing, fraud, compliance, legal, manual review, or cannot be safely resolved, recommend escalation to ${
        args.merchantContext.supportInboxEmail
      }.`,
      'Keep the answer concise, specific, and operationally useful.',
    ].join(' ');
  }

  private buildUserPrompt(args: SupportAiRequest) {
    const history = args.conversationHistory
      .slice(-6)
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');

    const knowledge = args.knowledgeMatches
      .map((entry) => `- ${entry.title} (${entry.url}): ${entry.content}`)
      .join('\n');

    return [
      `Merchant context JSON: ${JSON.stringify(args.merchantContext)}`,
      `Relevant knowledge snippets:\n${knowledge || '- None found'}`,
      `Conversation history:\n${history || 'No previous messages'}`,
      `Merchant question: ${args.userMessage}`,
    ].join('\n\n');
  }

  private buildFallbackReply(
    args: SupportAiRequest,
    escalationReason: string | null,
  ): SupportAssistantReply {
    const topic = this.detectTopic(args.userMessage);
    const provider = this.detectProvider(args.userMessage);
    const context = args.merchantContext;
    const lines: string[] = [];
    let usedContextSignals = false;

    if (topic === 'payment_troubleshooting') {
      const troubleshootingReply = this.buildTroubleshootingReply(args, provider);
      lines.push(troubleshootingReply.content);
      usedContextSignals = troubleshootingReply.usedContextSignals;
    } else if (topic === 'gateway') {
      lines.push(
        `Here is the current gateway state for ${context.merchant.name}: ${context.gateways.connectedCount} connected rail(s).`,
      );
      lines.push(
        `Ozow: ${String(context.gateways.ozow.connected)}. Yoco: ${String(
          context.gateways.yoco.connected,
        )}. Paystack: ${String(context.gateways.paystack.connected)}.`,
      );
    } else if (topic === 'api_keys') {
      lines.push(
        `This merchant currently has ${context.apiKeys.activeCount} active API key(s): ${context.apiKeys.testKeyCount} test and ${context.apiKeys.liveKeyCount} live.`,
      );
      if (!context.apiKeys.activeCount) {
        lines.push(
          'No active API keys are available right now, so authenticated API calls would fail until a new key is created.',
        );
      }
    } else if (topic === 'onboarding') {
      lines.push(
        `The merchant account status is ${context.merchant.accountStatus.toLowerCase().replace(/_/g, ' ')}.`,
      );
      lines.push(context.onboarding.detail);
    } else if (topic === 'payments') {
      const latestFailure = context.payments.recentFailures[0];
      lines.push(
        `This merchant has ${context.payments.totalPayments} payment(s) recorded with a ${context.payments.successRate.toFixed(
          1,
        )}% success rate.`,
      );
      if (latestFailure) {
        lines.push(
          `The latest failed or cancelled payment is ${latestFailure.reference} on ${
            latestFailure.updatedAt
          }, with provider status ${latestFailure.status.toLowerCase()}.`,
        );
        usedContextSignals = true;
      } else {
        lines.push(
          'There are no recent failed or cancelled payments in the current support snapshot.',
        );
      }
    } else if (topic === 'payouts') {
      lines.push(
        `Payout visibility is available for this merchant. There are ${context.payouts.pendingCount} pending payout(s) and ${context.payouts.failedCount} failed payout(s) in the current snapshot.`,
      );
    } else if (topic === 'integration') {
      lines.push(
        'Stackaura supports one backend integration for multiple gateways, payment creation, hosted checkout, and webhook-driven reconciliation.',
      );
      lines.push(
        'If you are integrating a website or backend, the fastest next step is usually checking the docs flow for payment creation and the dashboard pages for keys and gateway setup.',
      );
    } else {
      lines.push(
        `I’m answering for ${context.merchant.name} in ${context.merchant.currentEnvironment} mode with ${context.gateways.connectedCount} connected gateway rail(s).`,
      );
      lines.push(
        'I can help with gateway setup, integration guidance, account status, payment troubleshooting, and payout visibility using the current merchant context.',
      );
    }

    const bestKnowledge = args.knowledgeMatches[0];
    if (bestKnowledge && (!usedContextSignals || topic !== 'payment_troubleshooting')) {
      lines.push(`The most relevant Stackaura guidance right now is ${bestKnowledge.title}.`);
    }

    lines.push(
      escalationReason
        ? `This looks like it should be escalated to human support at ${context.supportInboxEmail} because it involves ${escalationReason}.`
        : 'If this still does not resolve the issue, I can escalate the conversation to human support at wesupport@stackaura.co.za.',
    );

    return {
      content: lines.join('\n\n'),
      citations: args.knowledgeMatches.map((entry) => ({
        id: entry.id,
        title: entry.title,
        url: entry.url,
        excerpt: entry.excerpt,
        source: entry.source,
      })),
      escalationRecommended: Boolean(escalationReason),
      escalationReason,
      provider: 'fallback',
    };
  }

  private buildTroubleshootingReply(
    args: SupportAiRequest,
    provider: GatewayName | null,
  ): TroubleshootingReply {
    const context = args.merchantContext;
    const targetProvider = provider ?? this.mostRecentFailureProvider(context);
    const gateway = targetProvider
      ? this.getGatewaySnapshot(context, targetProvider)
      : null;
    const recentFailures = this.filterRecentFailures(context, targetProvider);
    const routeIssues = this.filterRoutingIssues(context, targetProvider);
    const possibleCauses: string[] = [];
    const checks: string[] = [];
    const nextSteps: string[] = [];
    const visibleFacts: string[] = [];

    if (targetProvider && gateway) {
      visibleFacts.push(
        `${this.gatewayLabel(targetProvider)} is ${
          gateway.connected ? 'connected' : 'not fully connected'
        } for this merchant.`,
      );

      if (typeof gateway.testMode === 'boolean') {
        visibleFacts.push(
          `${this.gatewayLabel(targetProvider)} is currently set to ${
            gateway.testMode ? 'test' : 'live'
          } mode, while the workspace looks ${context.merchant.currentEnvironment}.`,
        );
      }
    } else {
      visibleFacts.push(
        `I’m looking at ${context.payments.recentFailures.length} recent failed or cancelled payment(s) for this merchant.`,
      );
    }

    if (recentFailures.length > 0) {
      const latestFailure = recentFailures[0];
      visibleFacts.push(
        `The latest relevant failed payment is ${latestFailure.reference} with status ${latestFailure.status.toLowerCase()} on ${latestFailure.updatedAt}.`,
      );
    }

    if (routeIssues.length > 0) {
      visibleFacts.push(
        `There are ${routeIssues.length} recent routing issue(s) in the current support snapshot for this path.`,
      );
    }

    if (!context.onboarding.completed) {
      possibleCauses.push(
        'The merchant onboarding or activation flow is not fully complete yet, which can block normal live payment processing.',
      );
      checks.push('Confirm the merchant account is active on the dashboard home and support context panel.');
      nextSteps.push('Finish any outstanding onboarding or activation steps before retrying live payments.');
    }

    if (!context.apiKeys.activeCount) {
      possibleCauses.push(
        'There are no active API keys for this merchant, so server-side payment creation calls may be failing before the provider handoff.',
      );
      checks.push('Open the Developer Keys page and confirm there is at least one active key for the environment you are using.');
      nextSteps.push('Create a test or live API key from the dashboard before retrying checkout creation.');
    }

    if (targetProvider && gateway) {
      this.populateGatewaySpecificTroubleshooting({
        provider: targetProvider,
        gateway,
        context,
        recentFailures,
        possibleCauses,
        checks,
        nextSteps,
      });
    }

    if (!possibleCauses.length) {
      possibleCauses.push(
        'The current merchant snapshot does not show a single confirmed configuration fault, so the failure may be in the provider response, bank rejection, or redirect/webhook handling outside this snapshot.',
      );
    }

    if (!checks.length) {
      checks.push(
        'Review the latest failed payment reference in the dashboard and compare the environment, selected gateway, and callback URLs used for that attempt.',
      );
    }

    if (!nextSteps.length) {
      nextSteps.push(
        'Retry from the current environment after reviewing gateway setup, then escalate to human support if the same failure repeats.',
      );
    }

    if (!this.hasSupportPageStep(nextSteps)) {
      nextSteps.push(
        `If the same issue repeats after those checks, use Escalate to human so the case goes to ${context.supportInboxEmail}.`,
      );
    }

    const sections = [
      targetProvider
        ? `Here’s how I’d troubleshoot ${this.gatewayLabel(targetProvider)} payment failures for ${context.merchant.name}.`
        : `Here’s how I’d troubleshoot the current payment failures for ${context.merchant.name}.`,
      `What I can see\n${visibleFacts.map((line) => `- ${line}`).join('\n')}`,
      `Possible causes\n${possibleCauses.map((line) => `- ${line}`).join('\n')}`,
      `What to check\n${checks.map((line) => `- ${line}`).join('\n')}`,
      `Next steps in Stackaura\n${nextSteps.map((line) => `- ${line}`).join('\n')}`,
    ];

    return {
      content: sections.join('\n\n'),
      usedContextSignals: visibleFacts.length > 0 || recentFailures.length > 0 || routeIssues.length > 0,
    };
  }

  private populateGatewaySpecificTroubleshooting(args: {
    provider: GatewayName;
    gateway: GatewaySnapshot;
    context: MerchantSupportContext;
    recentFailures: MerchantSupportContext['payments']['recentFailures'];
    possibleCauses: string[];
    checks: string[];
    nextSteps: string[];
  }) {
    const providerLabel = this.gatewayLabel(args.provider);
    const merchantEnvironment = args.context.merchant.currentEnvironment;

    if (!args.gateway.connected) {
      if (args.provider === 'ozow') {
        args.possibleCauses.push(
          'Ozow looks partially configured or incomplete. Missing site code, API key, or private key will stop valid request signing.',
        );
        args.checks.push(
          'Open Gateway Connections and confirm Ozow has a saved site code, API key, and private key.',
        );
      } else if (args.provider === 'yoco') {
        args.possibleCauses.push(
          'Yoco looks partially configured. Missing public or secret key will prevent checkout creation.',
        );
        args.checks.push(
          'Open Gateway Connections and confirm Yoco has both the public key and secret key saved.',
        );
      } else {
        args.possibleCauses.push(
          'Paystack is not fully configured. A missing secret key will prevent transaction initialization.',
        );
        args.checks.push(
          'Open Gateway Connections and confirm Paystack has a saved secret key.',
        );
      }

      args.nextSteps.push(
        `Go to Gateway Connections, complete the ${providerLabel} credentials, save again, and retry the payment from the same environment.`,
      );
    }

    if (merchantEnvironment === 'mixed') {
      args.possibleCauses.push(
        'This workspace looks mixed between test and live, which often causes environment mismatches between keys, gateway settings, and checkout requests.',
      );
      args.checks.push(
        'Verify whether you are intentionally operating in test or live mode and avoid mixing both key sets during the same troubleshooting session.',
      );
      args.nextSteps.push(
        'Standardize on one environment in the dashboard before retrying the payment.',
      );
    } else if (
      typeof args.gateway.testMode === 'boolean' &&
      ((merchantEnvironment === 'live' && args.gateway.testMode) ||
        (merchantEnvironment === 'test' && !args.gateway.testMode))
    ) {
      args.possibleCauses.push(
        `${providerLabel} is in ${args.gateway.testMode ? 'test' : 'live'} mode while the merchant workspace looks ${merchantEnvironment}, so the gateway and API environment may not match.`,
      );
      args.checks.push(
        `Confirm the ${providerLabel} test-mode toggle matches the environment of the API keys and checkout you are using.`,
      );
      args.nextSteps.push(
        `Switch the ${providerLabel} mode in Gateway Connections or retry using the matching ${args.gateway.testMode ? 'test' : 'live'} Stackaura environment.`,
      );
    }

    if (args.provider === 'ozow' && args.gateway.connected) {
      args.possibleCauses.push(
        'If the credentials look correct, Ozow failures can also come from incorrect notify/success/cancel URLs, hash/signature mismatches, or provider-side rejection of the request payload.',
      );
      args.checks.push(
        'Review whether the payment was created from the correct live or test flow and whether the return and notify URLs match the environment you expect.',
      );
    }

    if (args.recentFailures.length > 0) {
      args.checks.push(
        `Inspect the latest ${providerLabel} failure reference in Payments and compare the provider used, status, and timestamp with the failing checkout attempt.`,
      );
    }

    if (args.context.payments.recentRoutingIssues.length > 0) {
      args.possibleCauses.push(
        'Recent routing or initialization issues may mean the payment failed before the provider handoff completed cleanly.',
      );
    }

    args.nextSteps.push(
      `Use the Payments view to inspect the latest ${providerLabel} payment attempt, then retry once after fixing any mode or credential mismatch.`,
    );
  }

  private getGatewaySnapshot(
    context: MerchantSupportContext,
    provider: GatewayName,
  ): GatewaySnapshot {
    const raw =
      provider === 'ozow'
        ? context.gateways.ozow
        : provider === 'yoco'
          ? context.gateways.yoco
          : context.gateways.paystack;

    return {
      connected: Boolean(raw.connected),
      testMode:
        typeof raw.testMode === 'boolean'
          ? raw.testMode
          : typeof raw.ozowTestMode === 'boolean'
            ? raw.ozowTestMode
            : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      hasApiKey: Boolean(raw.hasApiKey),
      hasPrivateKey: Boolean(raw.hasPrivateKey),
      hasPublicKey: Boolean(raw.hasPublicKey),
      hasSecretKey: Boolean(raw.hasSecretKey),
      webhookConfigured: Boolean(raw.webhookConfigured),
      siteCode: typeof raw.siteCode === 'string' ? raw.siteCode : null,
    };
  }

  private filterRecentFailures(
    context: MerchantSupportContext,
    provider: GatewayName | null,
  ) {
    if (!provider) {
      return context.payments.recentFailures;
    }

    const target = provider.toUpperCase();
    return context.payments.recentFailures.filter((payment) => {
      const gateway = payment.gateway?.toUpperCase() ?? null;
      const lastAttemptGateway = payment.lastAttemptGateway?.toUpperCase() ?? null;
      return gateway === target || lastAttemptGateway === target;
    });
  }

  private filterRoutingIssues(
    context: MerchantSupportContext,
    provider: GatewayName | null,
  ) {
    if (!provider) {
      return context.payments.recentRoutingIssues;
    }

    const label = provider.toLowerCase();
    return context.payments.recentRoutingIssues.filter((item) =>
      item.routeSummary.toLowerCase().includes(label),
    );
  }

  private mostRecentFailureProvider(context: MerchantSupportContext): GatewayName | null {
    const latest = context.payments.recentFailures[0];
    const providerValue =
      latest?.lastAttemptGateway?.toLowerCase() ?? latest?.gateway?.toLowerCase() ?? '';

    if (providerValue.includes('ozow')) {
      return 'ozow';
    }
    if (providerValue.includes('yoco')) {
      return 'yoco';
    }
    if (providerValue.includes('paystack')) {
      return 'paystack';
    }
    return null;
  }

  private gatewayLabel(provider: GatewayName) {
    if (provider === 'ozow') {
      return 'Ozow';
    }
    if (provider === 'yoco') {
      return 'Yoco';
    }
    return 'Paystack';
  }

  private hasSupportPageStep(nextSteps: string[]) {
    return nextSteps.some((step) => /dashboard|escalate|support/i.test(step));
  }

  private detectTopic(messageRaw: string): SupportTopic {
    const message = messageRaw.trim().toLowerCase();
    const troubleshootingRequest =
      /(why|debug|diagnose|troubleshoot|investigate|problem|issue|not working)/.test(
        message,
      ) &&
      /(payment|transaction|checkout|gateway|ozow|yoco|paystack)/.test(message);
    const paymentFailure =
      /(payment|transaction|checkout|ozow|yoco|paystack|gateway)/.test(message) &&
      /(fail|failing|failed|error|declin|cancel|timed out|timeout|rejected)/.test(
        message,
      );

    if (troubleshootingRequest || paymentFailure) {
      return 'payment_troubleshooting';
    }

    if (/(ozow|yoco|paystack|gateway|checkout fail|connection)/.test(message)) {
      return 'gateway';
    }
    if (/(api key|secret key|developer key|token)/.test(message)) {
      return 'api_keys';
    }
    if (/(onboarding|pending|activation|account pending|kyc)/.test(message)) {
      return 'onboarding';
    }
    if (/(payment|transaction|checkout|fail|error|declined|routing)/.test(message)) {
      return 'payments';
    }
    if (/(payout|settlement|withdrawal|transfer)/.test(message)) {
      return 'payouts';
    }
    if (/(integrate|integration|docs|shopify|website|api)/.test(message)) {
      return 'integration';
    }
    return 'general';
  }

  private detectProvider(messageRaw: string): GatewayName | null {
    const message = messageRaw.trim().toLowerCase();

    if (message.includes('ozow')) {
      return 'ozow';
    }
    if (message.includes('yoco')) {
      return 'yoco';
    }
    if (message.includes('paystack')) {
      return 'paystack';
    }
    return null;
  }

  private detectEscalationNeed(messageRaw: string) {
    const message = messageRaw.trim().toLowerCase();

    if (/(fraud|chargeback|dispute|billing issue|invoice|refund dispute)/.test(message)) {
      return 'billing, dispute, or fraud handling';
    }

    if (/(legal|lawyer|lawsuit|compliance|kyc review|manual review)/.test(message)) {
      return 'legal, compliance, or manual review handling';
    }

    if (/(complaint|unhappy|human|person|support team)/.test(message)) {
      return 'a direct human support request';
    }

    return null;
  }
}
