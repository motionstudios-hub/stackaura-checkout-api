import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ApiKeyRequest } from '../payouts/api-key.guard';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { MerchantsService } from './merchants.service';

@ApiTags('merchants')
@Controller('merchants') // because main.ts already sets /v1 prefix
export class MerchantsController {
  constructor(private readonly merchantsService: MerchantsService) {}

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
    },
  ) {
    this.assertMerchantScope(req, merchantId);
    return this.merchantsService.configureOzowGateway(merchantId, body);
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
}
