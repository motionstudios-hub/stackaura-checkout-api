import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SupportEscalationStatus,
  SupportMessageRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupportAiService } from './support-ai.service';
import { SupportContextService } from './support-context.service';
import { SupportEscalationService } from './support-escalation.service';
import { SupportKnowledgeService } from './support-knowledge.service';

type SupportConversationRecord = {
  id: string;
  merchantId: string;
  userId: string;
  title: string | null;
  status: string;
  lastMessageAt: Date;
  escalatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    id: string;
    role: SupportMessageRole;
    content: string;
    citations: Prisma.JsonValue | null;
    contextSnapshot: Prisma.JsonValue | null;
    createdAt: Date;
  }>;
  escalations: Array<{
    id: string;
    reason: string;
    summary: string;
    emailTo: string;
    status: SupportEscalationStatus;
    sentAt: Date | null;
    failureMessage: string | null;
    createdAt: Date;
  }>;
};

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supportContextService: SupportContextService,
    private readonly supportKnowledgeService: SupportKnowledgeService,
    private readonly supportAiService: SupportAiService,
    private readonly supportEscalationService: SupportEscalationService,
  ) {}

  async listConversations(userId: string, merchantId: string) {
    this.assertIds(userId, merchantId);

    const [conversations, merchantContext] = await Promise.all([
      this.prisma.supportConversation.findMany({
        where: {
          userId,
          merchantId,
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 20,
        select: {
          id: true,
          title: true,
          status: true,
          lastMessageAt: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              content: true,
              role: true,
              createdAt: true,
            },
          },
          escalations: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              emailTo: true,
              sentAt: true,
            },
          },
        },
      }),
      this.supportContextService.buildMerchantContext(merchantId),
    ]);

    return {
      merchantId,
      merchantContext,
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title ?? 'Support conversation',
        status: conversation.status,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        preview: conversation.messages[0]?.content ?? '',
        lastMessageRole: conversation.messages[0]?.role ?? null,
        escalation: conversation.escalations[0]
          ? {
              id: conversation.escalations[0].id,
              status: conversation.escalations[0].status,
              emailTo: conversation.escalations[0].emailTo,
              sentAt: conversation.escalations[0].sentAt?.toISOString() ?? null,
            }
          : null,
      })),
    };
  }

  async getConversation(userId: string, conversationId: string) {
    const conversation = await this.findConversationForUser(
      userId,
      conversationId,
    );
    const merchantContext =
      await this.supportContextService.buildMerchantContext(
        conversation.merchantId,
      );

    return {
      merchantId: conversation.merchantId,
      merchantContext,
      conversation: this.serializeConversationDetail(conversation),
    };
  }

  async chat(args: {
    userId: string;
    merchantId: string;
    message: string;
    conversationId?: string | null;
  }) {
    this.assertIds(args.userId, args.merchantId);
    const message = args.message?.trim();
    if (!message) {
      throw new BadRequestException('message is required');
    }

    const conversation = await this.getOrCreateConversation({
      userId: args.userId,
      merchantId: args.merchantId,
      conversationId: args.conversationId,
      message,
    });

    await this.prisma.supportMessage.create({
      data: {
        conversationId: conversation.id,
        role: SupportMessageRole.USER,
        content: message,
      },
    });

    const merchantContext =
      await this.supportContextService.buildMerchantContext(args.merchantId);

    const conversationHistory = (
      await this.prisma.supportMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'desc' },
        take: 16,
        select: {
          role: true,
          content: true,
        },
      })
    ).reverse();

    const knowledgeMatches = this.supportKnowledgeService.search(message, 3);
    const assistantReply = await this.supportAiService.generateReply({
      merchantContext,
      userMessage: message,
      conversationHistory,
      knowledgeMatches,
    });

    const contextSnapshot = merchantContext as unknown as Prisma.InputJsonValue;
    const citations =
      assistantReply.citations as unknown as Prisma.InputJsonValue;

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          conversationId: conversation.id,
          role: SupportMessageRole.ASSISTANT,
          content: assistantReply.content,
          citations,
          contextSnapshot,
        },
      }),
      this.prisma.supportConversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          title: conversation.title ?? this.buildConversationTitle(message),
        },
      }),
    ]);

    const updated = await this.findConversationForUser(
      args.userId,
      conversation.id,
    );

    return {
      merchantId: args.merchantId,
      merchantContext,
      escalationRecommended: assistantReply.escalationRecommended,
      escalationReason: assistantReply.escalationReason,
      aiProvider: assistantReply.provider,
      conversation: this.serializeConversationDetail(updated),
    };
  }

  async escalateConversation(args: {
    userId: string;
    conversationId: string;
    reason?: string | null;
  }) {
    const conversation = await this.findConversationForUser(
      args.userId,
      args.conversationId,
    );
    const merchantContext =
      await this.supportContextService.buildMerchantContext(
        conversation.merchantId,
      );

    const escalation = await this.supportEscalationService.escalateConversation(
      {
        conversation: {
          id: conversation.id,
          merchantId: conversation.merchantId,
          userId: conversation.userId,
          title: conversation.title,
          status: conversation.status,
          messages: conversation.messages.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          })),
          escalations: conversation.escalations.map((item) => ({
            id: item.id,
            status: item.status,
            emailTo: item.emailTo,
            summary: item.summary,
            sentAt: item.sentAt,
            createdAt: item.createdAt,
          })),
        },
        merchantContext,
        reason: args.reason,
      },
    );

    const refreshed = await this.findConversationForUser(
      args.userId,
      args.conversationId,
    );

    return {
      merchantId: refreshed.merchantId,
      supportInboxEmail: merchantContext.supportInboxEmail,
      escalation,
      conversation: this.serializeConversationDetail(refreshed),
    };
  }

  private assertIds(userId: string, merchantId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('userId is required');
    }

    if (!merchantId?.trim()) {
      throw new BadRequestException('merchantId is required');
    }
  }

  private async getOrCreateConversation(args: {
    userId: string;
    merchantId: string;
    conversationId?: string | null;
    message: string;
  }) {
    if (args.conversationId?.trim()) {
      const existing = await this.prisma.supportConversation.findFirst({
        where: {
          id: args.conversationId.trim(),
          userId: args.userId,
          merchantId: args.merchantId,
        },
        select: {
          id: true,
          title: true,
        },
      });

      if (!existing) {
        throw new NotFoundException('Support conversation not found');
      }

      return existing;
    }

    return this.prisma.supportConversation.create({
      data: {
        userId: args.userId,
        merchantId: args.merchantId,
        title: this.buildConversationTitle(args.message),
      },
      select: {
        id: true,
        title: true,
      },
    });
  }

  private async findConversationForUser(
    userId: string,
    conversationId: string,
  ) {
    const conversation = await this.prisma.supportConversation.findFirst({
      where: {
        id: conversationId,
        userId,
      },
      select: {
        id: true,
        merchantId: true,
        userId: true,
        title: true,
        status: true,
        lastMessageAt: true,
        escalatedAt: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            citations: true,
            contextSnapshot: true,
            createdAt: true,
          },
        },
        escalations: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            reason: true,
            summary: true,
            emailTo: true,
            status: true,
            sentAt: true,
            failureMessage: true,
            createdAt: true,
          },
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Support conversation not found');
    }

    return conversation;
  }

  private serializeConversationDetail(conversation: SupportConversationRecord) {
    return {
      id: conversation.id,
      merchantId: conversation.merchantId,
      title: conversation.title ?? 'Support conversation',
      status: conversation.status,
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      escalatedAt: conversation.escalatedAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: Array.isArray(message.citations) ? message.citations : [],
        contextSnapshot: message.contextSnapshot ?? null,
        createdAt: message.createdAt.toISOString(),
      })),
      escalations: conversation.escalations.map((item) => ({
        id: item.id,
        reason: item.reason,
        summary: item.summary,
        emailTo: item.emailTo,
        status: item.status,
        sentAt: item.sentAt?.toISOString() ?? null,
        failureMessage: item.failureMessage ?? null,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  private buildConversationTitle(message: string) {
    const trimmed = message.trim();
    if (trimmed.length <= 80) {
      return trimmed;
    }

    return `${trimmed.slice(0, 77)}...`;
  }
}
