import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { ApiKeyRequest } from '../payouts/api-key.guard';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { Public } from '../auth/public.decorator';
import { WebhooksService } from './webhooks.service';

type RawBodyRequest = Request & { rawBody?: string | Buffer };

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly webhooksService: WebhooksService) {}

  @Get()
  list() {
    return { ok: true, resource: 'webhooks' };
  }

  // PayFast ITN: POST /v1/webhooks/payfast
  @ApiOperation({ summary: 'Receive PayFast ITN callback' })
  @Public()
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @Post('payfast')
  async payfast(
    @Req() req: RawBodyRequest,
    @Body() body: Record<string, string | string[]>,
  ) {
    const requestId = this.resolveRequestId(req);
    this.logger.log(`PayFast ITN received (requestId=${requestId ?? 'n/a'})`);

    try {
      await this.webhooksService.handlePayfastWebhook(body, {
        requestId,
        rawBody: req?.rawBody,
      });
      return 'OK';
    } catch (error) {
      this.logger.error(
        `PayFast ITN processing failed (requestId=${requestId})`,
        error instanceof Error ? error.stack : String(error),
      );
      return 'OK';
    }
  }

  // Ozow callback: POST /v1/webhooks/ozow
  @ApiOperation({ summary: 'Receive Ozow webhook callback' })
  @Public()
  @HttpCode(200)
  @Post('ozow')
  async ozow(
    @Req() req: RawBodyRequest,
    @Body() body: Record<string, string | string[]>,
  ) {
    const requestId = this.resolveRequestId(req);
    await this.webhooksService.handleOzowWebhook(body, { requestId });
    return { ok: true };
  }

  // Deriv PA webhook: POST /v1/webhooks/deriv-pa
  @ApiOperation({ summary: 'Receive PayGate-style signed webhook callback' })
  @Public()
  @HttpCode(200)
  @Post('paygate')
  async paygate(
    @Req() req: RawBodyRequest,
    @Body() body: Record<string, unknown>,
    @Headers() allHeaders: Record<string, string | string[] | undefined>,
    @Headers('x-timestamp') timestamp?: string,
  ) {
    return this.handleSignedWebhook(req, body, allHeaders, timestamp);
  }

  @ApiOperation({ summary: 'Receive Deriv payout webhook callback' })
  @Public()
  @HttpCode(200)
  @Post('deriv-pa')
  async derivPa(
    @Req() req: RawBodyRequest,
    @Body() body: Record<string, unknown>,
    @Headers() allHeaders: Record<string, string | string[] | undefined>,
    @Headers('x-timestamp') timestamp?: string,
  ) {
    return this.handleSignedWebhook(req, body, allHeaders, timestamp);
  }

  private async handleSignedWebhook(
    req: RawBodyRequest,
    body: Record<string, unknown>,
    allHeaders: Record<string, string | string[] | undefined>,
    timestamp?: string,
  ) {
    const headerSignature = allHeaders?.['x-signature'];
    const signature =
      typeof headerSignature === 'string'
        ? headerSignature
        : Array.isArray(headerSignature)
          ? headerSignature[0]
          : (req.get('x-signature') ?? req.get('X-Signature'));

    return this.webhooksService.handleDerivPaWebhook(body, {
      signature,
      timestamp,
      rawBody: req?.rawBody,
      requestId: this.resolveRequestId(req),
    });
  }

  // POST /v1/webhooks/merchants/:merchantId/endpoints
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Create webhook endpoint for merchant' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', example: 'https://merchant.example/webhooks' },
        secret: { type: 'string', example: 'whsec_abc123' },
        isActive: { type: 'boolean', example: true },
      },
      required: ['url'],
    },
  })
  @UseGuards(ApiKeyGuard)
  @Post('merchants/:merchantId/endpoints')
  async createEndpoint(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Body() body: { url: string; secret?: string; isActive?: boolean },
  ) {
    this.assertMerchantScope(req, merchantId);
    return this.webhooksService.createWebhookEndpoint(merchantId, body);
  }

  // GET /v1/webhooks/merchants/:merchantId/endpoints
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'List webhook endpoints for merchant' })
  @ApiQuery({
    name: 'active',
    required: false,
    description: 'Filter by active flag (`true`/`false`)',
  })
  @UseGuards(ApiKeyGuard)
  @Get('merchants/:merchantId/endpoints')
  async listEndpoints(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Query('active') active?: string,
  ) {
    this.assertMerchantScope(req, merchantId);
    const activeFilter =
      active === undefined ? undefined : active === 'true' || active === '1';
    return this.webhooksService.listWebhookEndpoints(merchantId, activeFilter);
  }

  // POST /v1/webhooks/endpoints/:endpointId/disable
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Disable webhook endpoint' })
  @UseGuards(ApiKeyGuard)
  @Post('endpoints/:endpointId/disable')
  async disableEndpoint(
    @Req() req: ApiKeyRequest,
    @Param('endpointId') endpointId: string,
  ) {
    const merchantId = this.assertAuthenticatedMerchant(req);
    return this.webhooksService.setWebhookEndpointActive(
      endpointId,
      false,
      merchantId,
    );
  }

  // POST /v1/webhooks/endpoints/:endpointId/enable
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Enable webhook endpoint' })
  @UseGuards(ApiKeyGuard)
  @Post('endpoints/:endpointId/enable')
  async enableEndpoint(
    @Req() req: ApiKeyRequest,
    @Param('endpointId') endpointId: string,
  ) {
    const merchantId = this.assertAuthenticatedMerchant(req);
    return this.webhooksService.setWebhookEndpointActive(
      endpointId,
      true,
      merchantId,
    );
  }

  // POST /v1/webhooks/endpoints/:endpointId/rotate-secret
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Rotate webhook endpoint secret' })
  @UseGuards(ApiKeyGuard)
  @Post('endpoints/:endpointId/rotate-secret')
  async rotateEndpointSecret(
    @Req() req: ApiKeyRequest,
    @Param('endpointId') endpointId: string,
  ) {
    const merchantId = this.assertAuthenticatedMerchant(req);
    return this.webhooksService.rotateWebhookEndpointSecret(
      endpointId,
      merchantId,
    );
  }

  // POST /v1/webhooks/deliveries/:deliveryId/retry
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Retry a webhook delivery immediately' })
  @UseGuards(ApiKeyGuard)
  @Post('deliveries/:deliveryId/retry')
  async retryDelivery(
    @Req() req: ApiKeyRequest,
    @Param('deliveryId') deliveryId: string,
  ) {
    const merchantId = this.assertAuthenticatedMerchant(req);
    return this.webhooksService.retryWebhookDelivery(deliveryId, merchantId);
  }

  // GET /v1/webhooks/endpoints/:endpointId/deliveries
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'List deliveries for webhook endpoint' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum rows to return (default 50, max 200)',
  })
  @UseGuards(ApiKeyGuard)
  @Get('endpoints/:endpointId/deliveries')
  async listDeliveries(
    @Req() req: ApiKeyRequest,
    @Param('endpointId') endpointId: string,
    @Query('limit') limit?: string,
  ) {
    const merchantId = this.assertAuthenticatedMerchant(req);
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.webhooksService.listWebhookDeliveries(
      endpointId,
      parsedLimit,
      merchantId,
    );
  }

  private resolveRequestId(req: RawBodyRequest) {
    return req?.get('x-request-id') ?? req?.get('X-Request-Id') ?? undefined;
  }

  private assertAuthenticatedMerchant(req: ApiKeyRequest) {
    const merchantId = req.apiKeyAuth?.merchantId;
    if (!merchantId) throw new UnauthorizedException('Invalid API key');
    return merchantId;
  }

  private assertMerchantScope(req: ApiKeyRequest, merchantId: string) {
    const authMerchantId = this.assertAuthenticatedMerchant(req);
    if (authMerchantId !== merchantId) {
      throw new UnauthorizedException('API key not allowed for merchant');
    }
  }
}
