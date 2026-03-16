import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../payouts/api-key.guard';
import { Public } from '../auth/public.decorator';
import type { ApiKeyRequest } from '../payouts/api-key.guard';
import { InitiateOzowPaymentDto } from './ozow.dto';
import { PaymentsService } from './payments.service';
import type {
  CreatePaymentDto,
  CreatePaymentIntentDto,
  CreateSubscriptionDto,
  ListPaymentsQuery,
} from './payments.service';

@ApiTags('payments')
@ApiBearerAuth('bearer')
@UseGuards(ApiKeyGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  private requireMerchantId(req: ApiKeyRequest) {
    const merchantId = req.apiKeyAuth?.merchantId;
    if (!merchantId) {
      throw new UnauthorizedException('Invalid API key');
    }
    return merchantId;
  }

  @ApiOperation({
    summary: 'Create payment intent (logical payment before gateway execution)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', example: 2500 },
        currency: { type: 'string', example: 'ZAR' },
        gateway: { type: 'string', enum: ['AUTO', 'PAYFAST', 'OZOW'] },
        customerEmail: { type: 'string', example: 'buyer@example.com' },
        description: { type: 'string', example: 'Order #123' },
      },
      required: ['amountCents'],
    },
  })
  @Post('intents')
  async createIntent(
    @Req() req: ApiKeyRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreatePaymentIntentDto,
  ) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.createPaymentIntent(
      merchantId,
      body,
      idempotencyKey,
    );
  }

  @ApiOperation({ summary: 'Create recurring subscription' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        customerEmail: { type: 'string', example: 'buyer@example.com' },
        amountCents: { type: 'integer', example: 9900 },
        currency: { type: 'string', example: 'ZAR' },
        interval: { type: 'string', enum: ['DAY', 'WEEK', 'MONTH', 'YEAR'] },
        startAt: { type: 'string', example: '2026-04-01T00:00:00Z' },
      },
      required: ['customerEmail', 'amountCents', 'interval'],
    },
  })
  @Post('subscriptions')
  async createSubscription(
    @Req() req: ApiKeyRequest,
    @Body() body: CreateSubscriptionDto,
  ) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.createSubscription(merchantId, body);
  }

  @ApiOperation({ summary: 'List merchant subscriptions' })
  @Get('subscriptions')
  async listSubscriptions(@Req() req: ApiKeyRequest) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.listSubscriptions(merchantId);
  }

  @ApiOperation({ summary: 'Retrieve payment intent by ID' })
  @Get('intents/:id')
  async getIntent(@Req() req: ApiKeyRequest, @Param('id') id: string) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.getPaymentIntentById(merchantId, id);
  }

  @Public()
  @ApiOperation({
    summary: 'Initiate Ozow payment and return form-post redirect payload',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', example: 2500 },
        currency: { type: 'string', example: 'ZAR' },
        reference: { type: 'string', example: 'INV-OZOW-123' },
        bankReference: { type: 'string', example: 'INV123' },
        customerEmail: { type: 'string', example: 'buyer@example.com' },
        description: { type: 'string', example: 'Order #123' },
      },
      required: ['amountCents'],
    },
  })
  @Post('ozow/initiate')
  async initiateOzow(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: InitiateOzowPaymentDto,
  ) {
    return this.paymentsService.initiateOzowPayment(
      body,
      idempotencyKey,
    );
  }

  @Public()
  @ApiOperation({
    summary: 'Fetch the latest Ozow provider status for a payment reference',
  })
  @Get('ozow/:reference/status')
  async getOzowStatus(
    @Param('reference') reference: string,
  ) {
    return this.paymentsService.getOzowPaymentStatus(reference);
  }

  @ApiOperation({
    summary:
      'Create payment (gateway can be PAYFAST, OZOW, or AUTO/omitted for ordered resolution)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', example: 2500 },
        reference: { type: 'string', example: 'INV-123' },
        gateway: { type: 'string', enum: ['AUTO', 'PAYFAST', 'OZOW'] },
        customerEmail: { type: 'string', example: 'buyer@example.com' },
        description: { type: 'string', example: 'Order #123' },
      },
      required: ['amountCents'],
    },
  })
  @Post()
  async create(
    @Req() req: ApiKeyRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreatePaymentDto,
  ) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.createPayment(
      merchantId,
      body,
      idempotencyKey,
    );
  }

  @Get()
  async list(@Req() req: ApiKeyRequest, @Query() query: ListPaymentsQuery) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.listPayments(merchantId, query);
  }

  @ApiOperation({
    summary: 'Write or return ledger entries for a paid payment reference',
  })
  @Post(':reference/ledger')
  async recordLedger(
    @Req() req: ApiKeyRequest,
    @Param('reference') reference: string,
  ) {
    const merchantId = this.requireMerchantId(req);
    const payment = await this.paymentsService.getPaymentByReference(
      merchantId,
      reference,
    );

    return this.paymentsService.recordSuccessfulPaymentLedgerByPaymentId(
      payment.id,
    );
  }

  @ApiOperation({
    summary: 'List payment attempts for a merchant-scoped payment reference',
  })
  @Get(':reference/attempts')
  async listAttempts(
    @Req() req: ApiKeyRequest,
    @Param('reference') reference: string,
  ) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.listPaymentAttempts(merchantId, reference);
  }

  @ApiOperation({ summary: 'Get payment by merchant-scoped reference' })
  @Get(':reference')
  async getByReference(
    @Req() req: ApiKeyRequest,
    @Param('reference') reference: string,
  ) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.getPaymentByReference(merchantId, reference);
  }

  @ApiOperation({
    summary: 'Create next gateway attempt for a payment reference',
  })
  @Post(':reference/failover')
  async failover(
    @Req() req: ApiKeyRequest,
    @Param('reference') reference: string,
  ) {
    const merchantId = this.requireMerchantId(req);
    return this.paymentsService.failoverPayment(merchantId, reference);
  }
}
