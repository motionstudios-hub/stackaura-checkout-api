import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { SessionRequest } from '../auth/session-auth.guard';
import { SupportService } from './support.service';

@ApiTags('support')
@Controller('support')
@UseGuards(SessionAuthGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @ApiOperation({
    summary: 'List support conversations for the active merchant workspace',
  })
  @Get('conversations')
  async listConversations(
    @Req() req: SessionRequest,
    @Query('merchantId') merchantId: string,
  ) {
    this.assertSessionMerchantScope(req, merchantId);
    return this.supportService.listConversations(
      req.sessionAuth!.user.id,
      merchantId,
    );
  }

  @ApiOperation({ summary: 'Get a support conversation and its messages' })
  @Get('conversations/:conversationId')
  async getConversation(
    @Req() req: SessionRequest,
    @Param('conversationId') conversationId: string,
  ) {
    const result = await this.supportService.getConversation(
      req.sessionAuth!.user.id,
      conversationId,
    );
    this.assertSessionMerchantScope(req, result.merchantId);
    return result;
  }

  @ApiOperation({ summary: 'Send a message to the Stackaura support AI' })
  @Post('chat')
  async chat(
    @Req() req: SessionRequest,
    @Body()
    body: {
      merchantId: string;
      message: string;
      conversationId?: string | null;
    },
  ) {
    this.assertSessionMerchantScope(req, body?.merchantId);
    return this.supportService.chat({
      userId: req.sessionAuth!.user.id,
      merchantId: body.merchantId,
      message: body.message,
      conversationId: body.conversationId,
    });
  }

  @ApiOperation({
    summary: 'Escalate a support conversation to the human support inbox',
  })
  @Post('conversations/:conversationId/escalate')
  async escalateConversation(
    @Req() req: SessionRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: { reason?: string | null },
  ) {
    const result = await this.supportService.escalateConversation({
      userId: req.sessionAuth!.user.id,
      conversationId,
      reason: body?.reason,
    });
    this.assertSessionMerchantScope(req, result.merchantId);
    return result;
  }

  private assertSessionMerchantScope(req: SessionRequest, merchantId: string) {
    if (!merchantId?.trim()) {
      throw new BadRequestException('merchantId is required');
    }

    const hasMembership = req.sessionAuth?.memberships.some(
      (membership) => membership.merchant.id === merchantId,
    );

    if (!hasMembership) {
      throw new UnauthorizedException('Merchant access denied');
    }
  }
}
