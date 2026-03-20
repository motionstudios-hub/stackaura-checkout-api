import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from '../auth/auth.service';
import type { ApiKeyRequest } from '../payouts/api-key.guard';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { MerchantsService } from './merchants.service';

@ApiTags('merchants')
@Controller('merchants') // because main.ts already sets /v1 prefix
export class MerchantsController {
  private readonly logger = new Logger(MerchantsController.name);

  constructor(
    private readonly merchantsService: MerchantsService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async list() {
    return this.merchantsService.listMerchants();
  }

  // POST /v1/merchants/signup
  @Post('signup')
  async signup(
    @Body()
    body: {
      businessName: string;
      email: string;
      password: string;
      country?: string;
    },
  ) {
    return this.merchantsService.createMerchantAccount(body);
  }

  @ApiOperation({ summary: 'Get real merchant payment analytics for the dashboard' })
  @Get(':merchantId/analytics')
  async getMerchantAnalytics(
    @Req() req: Request,
    @Param('merchantId') merchantId: string,
  ) {
    await this.assertSessionMerchantScope(req, merchantId);
    return this.merchantsService.getMerchantAnalytics(merchantId);
  }

  // GET /v1/merchants/:merchantId/api-keys
  @ApiBearerAuth('bearer')
  @UseGuards(ApiKeyGuard)
  @Get(':merchantId/api-keys')
  listApiKeys(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
  ) {
    this.assertMerchantScope(req, merchantId);
    return this.merchantsService.listApiKeys(merchantId);
  }

  // POST /v1/merchants/:merchantId/api-keys
  @ApiBearerAuth('bearer')
  @UseGuards(ApiKeyGuard)
  @Post(':merchantId/api-keys')
  createApiKey(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Body() body: { label?: string; environment?: 'test' | 'live' },
  ) {
    this.assertMerchantScope(req, merchantId);
    return this.merchantsService.createApiKey(
      merchantId,
      body?.label,
      body?.environment,
    );
  }

  // POST /v1/merchants/:merchantId/api-keys/:apiKeyId/revoke
  @ApiBearerAuth('bearer')
  @UseGuards(ApiKeyGuard)
  @Post(':merchantId/api-keys/:apiKeyId/revoke')
  revokeApiKey(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Param('apiKeyId') apiKeyId: string,
  ) {
    this.assertMerchantScope(req, merchantId);
    return this.merchantsService.revokeApiKey(merchantId, apiKeyId);
  }

  // POST /v1/merchants/:merchantId/gateways/payfast
  @ApiBearerAuth('bearer')
  @UseGuards(ApiKeyGuard)
  @Post(':merchantId/gateways/payfast')
  async configurePayfastGateway(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Body()
    body: {
      merchantId: string;
      merchantKey: string;
      passphrase?: string;
      isSandbox?: boolean;
    },
  ) {
    this.assertMerchantScope(req, merchantId);
    return this.merchantsService.configurePayfastGateway(merchantId, body);
  }

  // GET /v1/merchants/:merchantId/gateways/ozow
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Get merchant Ozow connection state' })
  @UseGuards(ApiKeyGuard)
  @Get(':merchantId/gateways/ozow')
  async getOzowGatewayConnection(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
  ) {
    try {
      this.assertMerchantScope(req, merchantId);
      return this.merchantsService.getOzowGatewayConnection(merchantId);
    } catch (error) {
      this.logGatewayControllerError({
        routeName: 'GET /v1/merchants/:merchantId/gateways/ozow',
        merchantId,
        requestMethod: req.method ?? 'GET',
        body: null,
        error,
      });
      throw error;
    }
  }

  // POST /v1/merchants/:merchantId/gateways/ozow
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Configure merchant Ozow credentials' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        siteCode: { type: 'string', example: 'SC-1234' },
        privateKey: { type: 'string', example: 'ozow_private_key' },
        apiKey: { type: 'string', example: 'ozow_api_key' },
        testMode: { type: 'boolean', example: true },
      },
      required: ['siteCode', 'privateKey'],
    },
  })
  @UseGuards(ApiKeyGuard)
  @Post(':merchantId/gateways/ozow')
  async configureOzowGateway(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Body()
    body: {
      siteCode: string;
      privateKey: string;
      apiKey?: string;
      testMode?: boolean;
    },
  ) {
    try {
      this.assertMerchantScope(req, merchantId);
      return this.merchantsService.configureOzowGateway(merchantId, body);
    } catch (error) {
      this.logGatewayControllerError({
        routeName: 'POST /v1/merchants/:merchantId/gateways/ozow',
        merchantId,
        requestMethod: req.method ?? 'POST',
        body,
        error,
      });
      throw error;
    }
  }

  // GET /v1/merchants/:merchantId/gateways/yoco
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Get merchant Yoco connection state' })
  @UseGuards(ApiKeyGuard)
  @Get(':merchantId/gateways/yoco')
  async getYocoGatewayConnection(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
  ) {
    try {
      this.assertMerchantScope(req, merchantId);
      return this.merchantsService.getYocoGatewayConnection(merchantId);
    } catch (error) {
      this.logGatewayControllerError({
        routeName: 'GET /v1/merchants/:merchantId/gateways/yoco',
        merchantId,
        requestMethod: req.method ?? 'GET',
        body: null,
        error,
      });
      throw error;
    }
  }

  // POST /v1/merchants/:merchantId/gateways/yoco
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Configure merchant Yoco credentials' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        publicKey: { type: 'string', example: 'pk_test_public_key' },
        secretKey: { type: 'string', example: 'sk_test_secret_key' },
        testMode: { type: 'boolean', example: true },
      },
      required: ['publicKey', 'secretKey', 'testMode'],
    },
  })
  @UseGuards(ApiKeyGuard)
  @Post(':merchantId/gateways/yoco')
  async configureYocoGateway(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Body()
    body: {
      publicKey: string;
      secretKey: string;
      testMode?: boolean;
    },
  ) {
    try {
      this.assertMerchantScope(req, merchantId);
      return this.merchantsService.configureYocoGateway(merchantId, body);
    } catch (error) {
      this.logGatewayControllerError({
        routeName: 'POST /v1/merchants/:merchantId/gateways/yoco',
        merchantId,
        requestMethod: req.method ?? 'POST',
        body,
        error,
      });
      throw error;
    }
  }

  // GET /v1/merchants/:merchantId/gateways/paystack
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Get merchant Paystack connection state' })
  @UseGuards(ApiKeyGuard)
  @Get(':merchantId/gateways/paystack')
  async getPaystackGatewayConnection(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
  ) {
    try {
      this.assertMerchantScope(req, merchantId);
      return this.merchantsService.getPaystackGatewayConnection(merchantId);
    } catch (error) {
      this.logGatewayControllerError({
        routeName: 'GET /v1/merchants/:merchantId/gateways/paystack',
        merchantId,
        requestMethod: req.method ?? 'GET',
        body: null,
        error,
      });
      throw error;
    }
  }

  // POST /v1/merchants/:merchantId/gateways/paystack
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Configure merchant Paystack credentials' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        secretKey: { type: 'string', example: 'sk_test_secret_key' },
        testMode: { type: 'boolean', example: true },
      },
      required: ['secretKey', 'testMode'],
    },
  })
  @UseGuards(ApiKeyGuard)
  @Post(':merchantId/gateways/paystack')
  async configurePaystackGateway(
    @Req() req: ApiKeyRequest,
    @Param('merchantId') merchantId: string,
    @Body()
    body: {
      secretKey: string;
      testMode?: boolean;
    },
  ) {
    try {
      this.assertMerchantScope(req, merchantId);
      return this.merchantsService.configurePaystackGateway(merchantId, body);
    } catch (error) {
      this.logGatewayControllerError({
        routeName: 'POST /v1/merchants/:merchantId/gateways/paystack',
        merchantId,
        requestMethod: req.method ?? 'POST',
        body,
        error,
      });
      throw error;
    }
  }

  private assertMerchantScope(req: ApiKeyRequest, merchantId: string) {
    const authMerchantId = req.apiKeyAuth?.merchantId;
    if (!authMerchantId) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (authMerchantId !== merchantId) {
      throw new UnauthorizedException('API key not allowed for merchant');
    }
  }

  private async assertSessionMerchantScope(req: Request, merchantId: string) {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      cookieName
    ];
    const session = await this.authService.resolveSession(token);

    if (!session) {
      throw new UnauthorizedException('Not authenticated');
    }

    const hasMembership = session.memberships.some(
      (membership) => membership.merchant.id === merchantId,
    );

    if (!hasMembership) {
      throw new UnauthorizedException('Merchant access denied');
    }
  }

  private logGatewayControllerError(args: {
    routeName: string;
    merchantId?: string | null;
    requestMethod?: string | null;
    body: unknown;
    error: unknown;
  }) {
    const stack = args.error instanceof Error ? args.error.stack : undefined;
    const payload = {
      event: 'merchant_gateway_controller_error',
      routeName: args.routeName,
      merchantId: args.merchantId ?? null,
      requestMethod: args.requestMethod ?? null,
      requestBodyShape: this.sanitizeGatewayBody(args.body),
      errorMessage:
        args.error instanceof Error ? args.error.message : String(args.error),
      errorStack: stack ?? null,
      ...this.extractPrismaErrorDetails(args.error),
    };

    this.logger.error(JSON.stringify(payload), stack);
  }

  private sanitizeGatewayBody(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const record = body as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        this.sanitizeGatewayField(key, value),
      ]),
    );
  }

  private sanitizeGatewayField(key: string, value: unknown) {
    const isRedactedSecret = ['apiKey', 'privateKey', 'publicKey', 'secretKey'].includes(
      key,
    );
    const isPresent =
      typeof value === 'string'
        ? value.trim().length > 0
        : value !== null && value !== undefined;

    return {
      present: isPresent,
      type: value === null ? 'null' : typeof value,
      ...(typeof value === 'boolean' ? { value } : {}),
      ...(isRedactedSecret ? { redacted: true } : {}),
    };
  }

  private extractPrismaErrorDetails(error: unknown) {
    if (!error || typeof error !== 'object') {
      return {};
    }

    const record = error as Record<string, unknown>;
    const meta = 'meta' in record ? record.meta : undefined;
    const code = typeof record.code === 'string' ? record.code : null;
    const clientVersion =
      typeof record.clientVersion === 'string' ? record.clientVersion : null;
    const prismaErrorName =
      typeof record.name === 'string' ? record.name : null;

    const looksLikePrismaError =
      Boolean(meta) ||
      Boolean(code) ||
      Boolean(clientVersion) ||
      Boolean(prismaErrorName?.includes('Prisma'));

    if (!looksLikePrismaError) {
      return {};
    }

    return {
      prisma: {
        name: prismaErrorName,
        code,
        clientVersion,
        meta: meta ?? null,
      },
    };
  }
}
