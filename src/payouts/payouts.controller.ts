import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import type { ApiKeyRequest } from './api-key.guard';
import { CreatePayoutDto } from './payout.dto';
import { PayoutsService } from './payouts.service';

@UseGuards(ApiKeyGuard)
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  // POST /v1/payouts
  @Post()
  async create(
    @Req() req: ApiKeyRequest,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: CreatePayoutDto,
  ) {
    const merchantId = req.apiKeyAuth?.merchantId;
    if (!merchantId) {
      throw new UnauthorizedException('Invalid API key');
    }

    const idempotencyKey = idempotencyKeyHeader?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    return this.payoutsService.createPayout(merchantId, idempotencyKey, body);
  }

  // GET /v1/payouts/:id
  @Get(':id')
  async getById(@Req() req: ApiKeyRequest, @Param('id') id: string) {
    const merchantId = req.apiKeyAuth?.merchantId;
    if (!merchantId) {
      throw new UnauthorizedException('Invalid API key');
    }

    return this.payoutsService.getPayoutById(merchantId, id);
  }
}
