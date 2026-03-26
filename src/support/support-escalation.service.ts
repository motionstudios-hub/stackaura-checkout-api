import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  SupportConversationStatus,
  SupportEscalationStatus,
  SupportMessageRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MerchantSupportContext } from './support.types';

type EscalationConversation = {
  id: string;
  merchantId: string;
  userId: string;
  title: string | null;
  status: string;
  messages: Array<{
    role: SupportMessageRole;
    content: string;
    createdAt: Date;
  }>;
  escalations: Array<{
    id: string;
    status: SupportEscalationStatus;
    emailTo: string;
    summary: string;
    sentAt: Date | null;
    createdAt: Date;
  }>;
};

type EscalationTriage = {
  issue: string;
  issueLabel: string;
  conversationId: string;
  referenceId: string | null;
  keySignals: string[];
  likelyCause: string;
  aiSummary: string;
};

@Injectable()
export class SupportEscalationService {
  private readonly logger = new Logger(SupportEscalationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async escalateConversation(args: {
    conversation: EscalationConversation;
    merchantContext: MerchantSupportContext;
    reason?: string | null;
  }) {
    const existing = args.conversation.escalations.find(
      (item) =>
        item.status === SupportEscalationStatus.PENDING ||
        item.status === SupportEscalationStatus.SENT,
    );

    if (existing) {
      return {
        escalationId: existing.id,
        status: existing.status,
        emailTo: existing.emailTo,
        summary: existing.summary,
        sentAt: existing.sentAt?.toISOString() ?? null,
        alreadyEscalated: true,
      };
    }

    const emailTo = this.getSupportInboxEmail();
    const triage = this.buildTriage(args);
    const summary = this.buildSummary(args, triage);
    const payload = this.buildPayload(args, emailTo, summary, triage);

    const created = await this.prisma.supportEscalation.create({
      data: {
        conversationId: args.conversation.id,
        merchantId: args.conversation.merchantId,
        userId: args.conversation.userId,
        reason: (args.reason?.trim() || 'Human support requested').slice(
          0,
          240,
        ),
        summary,
        payload: payload as Prisma.InputJsonValue,
        emailTo,
        status: SupportEscalationStatus.PENDING,
      },
      select: {
        id: true,
        status: true,
        emailTo: true,
      },
    });

    try {
      await this.deliverEscalationEmail({
        emailTo,
        merchantContext: args.merchantContext,
        payload,
        summary,
        triage,
      });

      const updated = await this.prisma.supportEscalation.update({
        where: { id: created.id },
        data: {
          status: SupportEscalationStatus.SENT,
          sentAt: new Date(),
        },
        select: {
          id: true,
          status: true,
          emailTo: true,
          summary: true,
          sentAt: true,
        },
      });

      await this.prisma.supportConversation.update({
        where: { id: args.conversation.id },
        data: {
          status: SupportConversationStatus.ESCALATED,
          escalatedAt: new Date(),
        },
      });

      return {
        escalationId: updated.id,
        status: updated.status,
        emailTo: updated.emailTo,
        summary: updated.summary,
        sentAt: updated.sentAt?.toISOString() ?? null,
        alreadyEscalated: false,
      };
    } catch (error) {
      await this.prisma.supportEscalation.update({
        where: { id: created.id },
        data: {
          status: SupportEscalationStatus.FAILED,
          failureMessage:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : String(error),
        },
      });

      throw error;
    }
  }

  private getSupportInboxEmail() {
    return (
      process.env.SUPPORT_INBOX_EMAIL?.trim() || 'wesupport@stackaura.co.za'
    );
  }

  private buildSummary(
    args: {
      conversation: EscalationConversation;
      merchantContext: MerchantSupportContext;
      reason?: string | null;
    },
    triage: EscalationTriage,
  ) {
    const reason = args.reason?.trim() || 'Human support requested';

    return [
      `Merchant ${args.merchantContext.merchant.name} requires human support.`,
      `Reason: ${reason}.`,
      `Issue: ${triage.issue}.`,
      `Environment: ${args.merchantContext.merchant.currentEnvironment}.`,
      `Connected gateways: ${args.merchantContext.gateways.connectedCount}.`,
    ].join(' ');
  }

  private buildPayload(
    args: {
      conversation: EscalationConversation;
      merchantContext: MerchantSupportContext;
      reason?: string | null;
    },
    emailTo: string,
    summary: string,
    triage: EscalationTriage,
  ) {
    return {
      emailTo,
      supportInboxIdentity: this.getSupportInboxEmail(),
      conversationId: args.conversation.id,
      reason: args.reason?.trim() || 'Human support requested',
      summary,
      triage,
      merchant: {
        id: args.merchantContext.merchant.id,
        name: args.merchantContext.merchant.name,
        email: args.merchantContext.merchant.email,
        planCode: args.merchantContext.merchant.planCode,
        accountStatus: args.merchantContext.merchant.accountStatus,
        currentEnvironment: args.merchantContext.merchant.currentEnvironment,
      },
      context: args.merchantContext,
      transcript: args.conversation.messages.slice(-12).map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
      createdAt: new Date().toISOString(),
    };
  }

  private async deliverEscalationEmail(args: {
    emailTo: string;
    merchantContext: MerchantSupportContext;
    payload: Record<string, unknown>;
    summary: string;
    triage: EscalationTriage;
  }) {
    const provider = (
      process.env.SUPPORT_ESCALATION_PROVIDER?.trim() || 'resend'
    ).toLowerCase();

    if (provider === 'resend') {
      await this.sendViaResend(args);
      return;
    }

    if (provider === 'webhook') {
      await this.sendViaWebhook(args);
      return;
    }

    throw new ServiceUnavailableException(
      'Support escalation provider is not configured correctly',
    );
  }

  private async sendViaResend(args: {
    emailTo: string;
    merchantContext: MerchantSupportContext;
    payload: Record<string, unknown>;
    summary: string;
    triage: EscalationTriage;
  }) {
    const apiKey = process.env.SUPPORT_RESEND_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'SUPPORT_RESEND_API_KEY is required for support escalations',
      );
    }

    const from =
      process.env.SUPPORT_ESCALATION_FROM_EMAIL?.trim() ||
      this.getSupportInboxEmail();

    const subject = this.buildEmailSubject(args.merchantContext, args.triage);
    const text = this.buildEmailText(args.merchantContext, args.triage);
    const attachment = this.buildEmailAttachment(args.payload, args.triage);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [args.emailTo],
        subject,
        text,
        attachments: [attachment],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Resend escalation failed: ${body}`);
      throw new ServiceUnavailableException(
        `Support escalation email failed with status ${res.status}`,
      );
    }
  }

  private async sendViaWebhook(args: {
    emailTo: string;
    merchantContext: MerchantSupportContext;
    payload: Record<string, unknown>;
    summary: string;
    triage: EscalationTriage;
  }) {
    const webhookUrl = process.env.SUPPORT_ESCALATION_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      throw new ServiceUnavailableException(
        'SUPPORT_ESCALATION_WEBHOOK_URL is required for webhook-based support escalations',
      );
    }

    const subject = this.buildEmailSubject(args.merchantContext, args.triage);
    const text = this.buildEmailText(args.merchantContext, args.triage);
    const attachment = this.buildEmailAttachment(args.payload, args.triage);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        emailTo: args.emailTo,
        subject,
        summary: args.summary,
        text,
        attachments: [attachment],
        payload: args.payload,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Support escalation webhook failed: ${body}`);
      throw new ServiceUnavailableException(
        `Support escalation webhook failed with status ${res.status}`,
      );
    }
  }

  private buildEmailSubject(
    merchantContext: MerchantSupportContext,
    triage: EscalationTriage,
  ) {
    return `[Support Escalation] ${merchantContext.merchant.name} – ${triage.issueLabel}`;
  }

  private buildEmailText(
    merchantContext: MerchantSupportContext,
    triage: EscalationTriage,
  ) {
    return [
      '🚨 New Support Escalation',
      '',
      `Conversation ID: ${triage.conversationId}`,
      triage.referenceId ? `Reference ID: ${triage.referenceId}` : null,
      '',
      `Merchant: ${merchantContext.merchant.name}`,
      `Email: ${merchantContext.merchant.email}`,
      `Plan: ${this.toTitleCase(merchantContext.merchant.plan.code)}`,
      `Environment: ${this.toTitleCase(merchantContext.merchant.currentEnvironment)}`,
      '',
      'Issue:',
      triage.issue,
      '',
      '---',
      '',
      '🔍 Key Signals',
      ...triage.keySignals.map((signal) => `- ${signal}`),
      '',
      '---',
      '',
      '⚠️ Likely Cause',
      triage.likelyCause,
      '',
      '---',
      '',
      '📊 Latest Payment',
      triage.referenceId
        ? `${triage.referenceId}`
        : 'No recent payment reference available in the current context.',
      '',
      '---',
      '',
      '🧠 AI Summary',
      triage.aiSummary,
      '',
      '---',
      '',
      '🧾 Full Context',
      'Attached as JSON.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private buildEmailAttachment(
    payload: Record<string, unknown>,
    triage: EscalationTriage,
  ) {
    return {
      filename: `support-escalation-${triage.conversationId}.json`,
      content: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString(
        'base64',
      ),
    };
  }

  private buildTriage(args: {
    conversation: EscalationConversation;
    merchantContext: MerchantSupportContext;
    reason?: string | null;
  }): EscalationTriage {
    const latestUserMessage =
      [...args.conversation.messages]
        .reverse()
        .find((message) => message.role === SupportMessageRole.USER)
        ?.content?.trim() ||
      args.reason?.trim() ||
      'Human support requested';
    const latestAssistantMessage =
      [...args.conversation.messages]
        .reverse()
        .find((message) => message.role === SupportMessageRole.ASSISTANT)
        ?.content || '';
    const provider = this.detectProvider(
      latestUserMessage,
      args.merchantContext,
    );
    const referenceId =
      this.getLatestRelevantFailure(args.merchantContext, provider)
        ?.reference ?? null;
    const failureCount = this.countRecentFailures(
      args.merchantContext,
      provider,
    );
    const environmentMismatch = this.detectEnvironmentMismatch(
      args.merchantContext,
      provider,
    );

    const keySignals = [
      `Success rate: ${args.merchantContext.payments.successRate.toFixed(1)}%`,
      `Recent failures: ${failureCount}${
        provider ? ` (${this.gatewayLabel(provider)})` : ''
      }`,
    ];

    if (environmentMismatch) {
      keySignals.push('Environment mismatch detected');
    }

    if (args.merchantContext.payments.recentRoutingIssues.length > 0) {
      keySignals.push(
        `Recent routing issues: ${args.merchantContext.payments.recentRoutingIssues.length}`,
      );
    }

    const likelyCause = this.buildLikelyCause(
      args.merchantContext,
      provider,
      environmentMismatch,
      failureCount,
    );

    return {
      issue: latestUserMessage,
      issueLabel: this.buildIssueLabel(latestUserMessage, provider),
      conversationId: args.conversation.id,
      referenceId: referenceId
        ? `${referenceId} → ${this.formatLatestPaymentStatus(
            args.merchantContext,
            provider,
          )}`
        : null,
      keySignals,
      likelyCause,
      aiSummary: this.buildAiSummary(latestAssistantMessage, likelyCause),
    };
  }

  private buildIssueLabel(
    issue: string,
    provider: 'ozow' | 'yoco' | 'paystack' | null,
  ) {
    const message = issue.trim().toLowerCase();

    if (
      /(checkout|payment|transaction)/.test(message) &&
      /(fail|error|cancel|declin)/.test(message)
    ) {
      return 'Checkout failures';
    }

    if (/(connect|setup|configure)/.test(message) && provider) {
      return `${this.gatewayLabel(provider)} setup help`;
    }

    if (/(api key|secret key|developer key)/.test(message)) {
      return 'API key support';
    }

    if (/(pending|activation|kyc|onboarding)/.test(message)) {
      return 'Account status review';
    }

    return issue.trim().slice(0, 72) || 'Human support request';
  }

  private buildLikelyCause(
    merchantContext: MerchantSupportContext,
    provider: 'ozow' | 'yoco' | 'paystack' | null,
    environmentMismatch: boolean,
    failureCount: number,
  ) {
    if (environmentMismatch) {
      return 'Mixed test/live environment causing gateway mismatch';
    }

    if (!merchantContext.apiKeys.activeCount) {
      return 'No active API keys are available for the current merchant environment';
    }

    if (provider === 'ozow' && !merchantContext.gateways.ozow.connected) {
      return 'Ozow is not fully configured for signed payment requests';
    }

    if (provider === 'yoco' && !merchantContext.gateways.yoco.connected) {
      return 'Yoco is not fully configured for checkout creation';
    }

    if (
      provider === 'paystack' &&
      !merchantContext.gateways.paystack.connected
    ) {
      return 'Paystack is not fully configured for transaction initialization';
    }

    if (failureCount > 0) {
      return provider
        ? `Recurring ${this.gatewayLabel(provider)} payment failures need provider request and callback review`
        : 'Recurring payment failures need provider and routing review';
    }

    return 'Human review is needed to inspect the full checkout trace and merchant context';
  }

  private buildAiSummary(assistantMessage: string, likelyCause: string) {
    const summaryLines = this.extractAssistantSummaryLines(assistantMessage);
    if (summaryLines.length > 0) {
      return summaryLines.slice(0, 4).join(' ');
    }
    return likelyCause;
  }

  private extractAssistantSummaryLines(assistantMessage: string) {
    return assistantMessage
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith('- ') &&
          !/^-\s*(what i can see|possible causes|what to check|next steps in stackaura)$/i.test(
            line,
          ),
      )
      .map((line) => line.replace(/^- /, ''))
      .slice(0, 4);
  }

  private detectProvider(
    issue: string,
    merchantContext: MerchantSupportContext,
  ): 'ozow' | 'yoco' | 'paystack' | null {
    const message = issue.toLowerCase();
    if (message.includes('ozow')) {
      return 'ozow';
    }
    if (message.includes('yoco')) {
      return 'yoco';
    }
    if (message.includes('paystack')) {
      return 'paystack';
    }

    const latestFailure = merchantContext.payments.recentFailures[0];
    const gateway =
      latestFailure?.lastAttemptGateway?.toLowerCase() ??
      latestFailure?.gateway?.toLowerCase() ??
      '';

    if (gateway.includes('ozow')) {
      return 'ozow';
    }
    if (gateway.includes('yoco')) {
      return 'yoco';
    }
    if (gateway.includes('paystack')) {
      return 'paystack';
    }

    return null;
  }

  private getLatestRelevantFailure(
    merchantContext: MerchantSupportContext,
    provider: 'ozow' | 'yoco' | 'paystack' | null,
  ) {
    if (!provider) {
      return merchantContext.payments.recentFailures[0] ?? null;
    }

    return (
      merchantContext.payments.recentFailures.find((payment) => {
        const gateway = payment.gateway?.toLowerCase() ?? '';
        const lastAttemptGateway =
          payment.lastAttemptGateway?.toLowerCase() ?? '';
        return (
          gateway.includes(provider) || lastAttemptGateway.includes(provider)
        );
      }) ?? null
    );
  }

  private formatLatestPaymentStatus(
    merchantContext: MerchantSupportContext,
    provider: 'ozow' | 'yoco' | 'paystack' | null,
  ) {
    return (
      this.getLatestRelevantFailure(merchantContext, provider)?.status ??
      'UNKNOWN'
    );
  }

  private countRecentFailures(
    merchantContext: MerchantSupportContext,
    provider: 'ozow' | 'yoco' | 'paystack' | null,
  ) {
    if (!provider) {
      return merchantContext.payments.recentFailures.length;
    }

    return merchantContext.payments.recentFailures.filter((payment) => {
      const gateway = payment.gateway?.toLowerCase() ?? '';
      const lastAttemptGateway =
        payment.lastAttemptGateway?.toLowerCase() ?? '';
      return (
        gateway.includes(provider) || lastAttemptGateway.includes(provider)
      );
    }).length;
  }

  private detectEnvironmentMismatch(
    merchantContext: MerchantSupportContext,
    provider: 'ozow' | 'yoco' | 'paystack' | null,
  ) {
    if (merchantContext.merchant.currentEnvironment === 'mixed') {
      return true;
    }

    if (!provider) {
      return false;
    }

    const gateway =
      provider === 'ozow'
        ? merchantContext.gateways.ozow
        : provider === 'yoco'
          ? merchantContext.gateways.yoco
          : merchantContext.gateways.paystack;
    const gatewayTestMode =
      typeof gateway.testMode === 'boolean'
        ? gateway.testMode
        : typeof gateway.ozowTestMode === 'boolean'
          ? gateway.ozowTestMode
          : null;

    if (gatewayTestMode === null) {
      return false;
    }

    return (
      (merchantContext.merchant.currentEnvironment === 'live' &&
        gatewayTestMode) ||
      (merchantContext.merchant.currentEnvironment === 'test' &&
        !gatewayTestMode)
    );
  }

  private gatewayLabel(provider: 'ozow' | 'yoco' | 'paystack') {
    if (provider === 'ozow') {
      return 'Ozow';
    }
    if (provider === 'yoco') {
      return 'Yoco';
    }
    return 'Paystack';
  }

  private toTitleCase(value: string) {
    return value
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }
}
