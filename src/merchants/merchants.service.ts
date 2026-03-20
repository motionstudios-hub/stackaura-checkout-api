import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { resolveOzowConfig } from '../gateways/ozow.config';
import {
  assertPaystackConfigConsistency,
  detectPaystackModeFromSecretKey,
  resolvePaystackConfig,
} from '../gateways/paystack.config';
import { YocoGateway } from '../gateways/yoco.gateway';
import {
  assertYocoConfigConsistency,
  detectYocoModeFromKeys,
  resolveYocoConfig,
} from '../gateways/yoco.config';
import {
  resolveDefaultMerchantPlanCode,
  resolveMerchantPlan,
} from '../payments/monetization.config';
import { PrismaService } from '../prisma/prisma.service';
import * as argon2 from 'argon2';
import crypto from 'crypto';

@Injectable()
export class MerchantsService {
  private readonly logger = new Logger(MerchantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly yocoGateway: YocoGateway,
  ) {}

  async listMerchants() {
    try {
      const merchants = await this.prisma.merchant.findMany({
        orderBy: { createdAt: 'desc' },
      });

      return merchants.map((merchant) => ({
        ...merchant,
        ...this.buildMerchantPlanReadback(merchant.planCode),
      }));
    } catch (error) {
      this.logPrismaError('merchant.findMany', error);
      throw error;
    }
  }

  private generateApiKey(prefix: 'ck_live' | 'ck_test' = 'ck_test') {
    const raw = crypto.randomBytes(32).toString('base64url');
    return `${prefix}_${raw}`;
  }

  private hashApiKey(plain: string) {
    return crypto.createHash('sha256').update(plain).digest('hex');
  }

  private buildMerchantPlanReadback(planCode: string | null | undefined) {
    const plan = resolveMerchantPlan({
      merchantPlanCode: planCode,
    });

    return {
      planCode: plan.code,
      plan: {
        code: plan.code,
        source: plan.source,
        feeSource: plan.feePolicy.source,
        manualGatewaySelection: plan.routingFeatures.manualGatewaySelection,
        autoRouting: plan.routingFeatures.autoRouting,
        fallback: plan.routingFeatures.fallback,
      },
    };
  }

  private normalizeApiKeyEnvironment(environment?: 'test' | 'live') {
    const normalizedEnv = (
      environment ??
      process.env.API_KEY_ENV ??
      'test'
    ).toLowerCase();
    if (normalizedEnv !== 'test' && normalizedEnv !== 'live') {
      throw new BadRequestException('environment must be test or live');
    }

    return normalizedEnv;
  }

  private async createApiKeyRecord(args: {
    merchantId: string;
    label: string;
    environment?: 'test' | 'live';
  }, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const normalizedEnv = this.normalizeApiKeyEnvironment(args.environment);
    const keyPrefix = normalizedEnv === 'live' ? 'ck_live' : 'ck_test';
    const apiKeyPlain = this.generateApiKey(keyPrefix);
    const keyHash = this.hashApiKey(apiKeyPlain);
    const storedPrefix = apiKeyPlain.slice(0, 12);
    const last4 = apiKeyPlain.slice(-4);

    const created = await client.apiKey.create({
      data: {
        merchantId: args.merchantId,
        keyHash,
        label: args.label,
        prefix: storedPrefix,
        last4,
      },
      select: {
        id: true,
        label: true,
        prefix: true,
        last4: true,
      },
    });

    return {
      apiKeyId: created.id,
      apiKey: apiKeyPlain,
      label: created.label,
      prefix: created.prefix,
      last4: created.last4,
      environment: normalizedEnv,
    };
  }

  private async createMerchantAccountInternal(
    body: {
      businessName: string;
      email: string;
      password: string;
      country?: string;
    },
    options: {
      isActive: boolean;
      issueApiKey: boolean;
      apiKeyLabel?: string;
      environment?: 'test' | 'live';
    },
  ) {
    const { businessName, email, password } = body;
    const normalizedEmail = email?.trim().toLowerCase();
    const normalizedBusinessName = businessName?.trim();

    if (!normalizedBusinessName) {
      throw new BadRequestException('businessName is required');
    }

    if (!normalizedEmail) {
      throw new BadRequestException('email is required');
    }

    if (!password || password.length < 6) {
      throw new BadRequestException('password must be at least 6 characters');
    }

    const existingMerchant = await this.prisma.merchant.findFirst({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existingMerchant) {
      throw new BadRequestException('Account with this email already exists');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existingUser) {
      throw new BadRequestException('Account with this email already exists');
    }

    const passwordHash = await argon2.hash(password);

    const { merchant, apiKey, apiKeyId } = await this.prisma.$transaction(
      async (tx) => {
        const merchant = await tx.merchant.create({
          data: {
            name: normalizedBusinessName,
            email: normalizedEmail,
            isActive: options.isActive,
            planCode: resolveDefaultMerchantPlanCode(),
          },
        });

        const user = await tx.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            isActive: options.isActive,
          },
          select: { id: true },
        });

        await tx.membership.create({
          data: {
            userId: user.id,
            merchantId: merchant.id,
            role: 'OWNER',
          },
          select: { id: true },
        });

        if (!options.issueApiKey) {
          return {
            merchant,
            apiKey: null,
            apiKeyId: undefined,
          };
        }

        const createdApiKey = await this.createApiKeyRecord(
          {
            merchantId: merchant.id,
            label: options.apiKeyLabel ?? 'default',
            environment: options.environment,
          },
          tx,
        );

        return {
          merchant,
          apiKey: createdApiKey.apiKey,
          apiKeyId: createdApiKey.apiKeyId,
        };
      },
    );

    return {
      merchant: {
        ...merchant,
        ...this.buildMerchantPlanReadback(merchant.planCode),
      },
      apiKey,
      apiKeyId,
    };
  }

  async listApiKeys(merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });

    if (!merchant) throw new NotFoundException('Merchant not found');

    return this.prisma.apiKey.findMany({
      where: { merchantId },
      select: {
        id: true,
        merchantId: true,
        label: true,
        prefix: true,
        last4: true,
        createdAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createApiKey(
    merchantId: string,
    label?: string,
    environment?: 'test' | 'live',
  ) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

    return this.createApiKeyRecord({
      merchantId,
      label: label ?? 'default',
      environment,
    });
  }

  async ensureInitialApiKey(
    merchantId: string,
    label = 'signup-initial',
    environment: 'test' | 'live' = 'test',
  ) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

    const existing = await this.prisma.apiKey.findFirst({
      where: {
        merchantId,
        revokedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        label: true,
        prefix: true,
        last4: true,
      },
    });

    if (existing) {
      return {
        created: false,
        apiKey: null,
        apiKeyId: existing.id,
        label: existing.label ?? label,
        prefix: existing.prefix,
        last4: existing.last4,
      };
    }

    const created = await this.createApiKeyRecord({
      merchantId,
      label,
      environment,
    });

    return {
      created: true,
      ...created,
    };
  }

  async createMerchantAccount(body: {
    businessName: string;
    email: string;
    password: string;
    country?: string;
  }) {
    return this.createMerchantAccountInternal(body, {
      isActive: true,
      issueApiKey: true,
      apiKeyLabel: 'default',
    });
  }

  async createPendingMerchantSignup(body: {
    businessName: string;
    email: string;
    password: string;
    country?: string;
  }) {
    return this.createMerchantAccountInternal(body, {
      isActive: false,
      issueApiKey: false,
    });
  }

  async getOzowGatewayConnection(merchantId: string) {
    const id = merchantId?.trim();

    try {
      if (!id) throw new BadRequestException('merchantId is required');

      const merchant = await this.prisma.merchant.findUnique({
        where: { id },
        select: {
          id: true,
          ozowSiteCode: true,
          ozowPrivateKey: true,
          ozowApiKey: true,
          ozowIsTest: true,
          updatedAt: true,
        },
      });
      if (!merchant) throw new NotFoundException('Merchant not found');

      return this.serializeOzowGatewayConnection(merchant);
    } catch (error) {
      this.logGatewayServiceError({
        routeName: 'GET /v1/merchants/:merchantId/gateways/ozow',
        merchantId: id,
        requestMethod: 'GET',
        body: null,
        error,
      });
      throw error;
    }
  }

  async getYocoGatewayConnection(merchantId: string) {
    const id = merchantId?.trim();

    try {
      if (!id) throw new BadRequestException('merchantId is required');

      const merchant = await this.prisma.merchant.findUnique({
        where: { id },
        select: {
          id: true,
          yocoPublicKey: true,
          yocoSecretKey: true,
          yocoTestMode: true,
          updatedAt: true,
        },
      });
      if (!merchant) throw new NotFoundException('Merchant not found');

      return this.serializeYocoGatewayConnection(merchant);
    } catch (error) {
      this.logGatewayServiceError({
        routeName: 'GET /v1/merchants/:merchantId/gateways/yoco',
        merchantId: id,
        requestMethod: 'GET',
        body: null,
        error,
      });
      throw error;
    }
  }

  async getPaystackGatewayConnection(merchantId: string) {
    const id = merchantId?.trim();

    try {
      if (!id) throw new BadRequestException('merchantId is required');

      const merchant = await this.prisma.merchant.findUnique({
        where: { id },
        select: {
          id: true,
          paystackSecretKey: true,
          paystackTestMode: true,
          updatedAt: true,
        },
      });
      if (!merchant) throw new NotFoundException('Merchant not found');

      return this.serializePaystackGatewayConnection(merchant);
    } catch (error) {
      this.logGatewayServiceError({
        routeName: 'GET /v1/merchants/:merchantId/gateways/paystack',
        merchantId: id,
        requestMethod: 'GET',
        body: null,
        error,
      });
      throw error;
    }
  }

  async configurePayfastGateway(
    merchantId: string,
    body: {
      merchantId: string;
      merchantKey: string;
      passphrase?: string;
      isSandbox?: boolean;
    },
  ) {
    const id = merchantId?.trim();
    if (!id) throw new BadRequestException('merchantId is required');

    const payfastMerchantId = body?.merchantId?.trim();
    if (!payfastMerchantId) {
      throw new BadRequestException('merchantId is required in body');
    }

    const payfastMerchantKey = body?.merchantKey?.trim();
    if (!payfastMerchantKey) {
      throw new BadRequestException('merchantKey is required');
    }

    const passphrase = body?.passphrase?.trim() || null;
    if (body?.isSandbox !== undefined && typeof body.isSandbox !== 'boolean') {
      throw new BadRequestException('isSandbox must be boolean');
    }
    const isSandbox = body?.isSandbox ?? true;

    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

    const updated = await this.prisma.merchant.update({
      where: { id },
      data: {
        // TODO: Encrypt PayFast credentials at rest when encryption helpers are available.
        payfastMerchantId,
        payfastMerchantKey,
        payfastPassphrase: passphrase,
        payfastIsSandbox: isSandbox,
      },
      select: {
        id: true,
        payfastMerchantId: true,
        payfastPassphrase: true,
        payfastIsSandbox: true,
      },
    });

    return {
      id: updated.id,
      payfastMerchantId: updated.payfastMerchantId,
      payfastPassphraseConfigured: Boolean(updated.payfastPassphrase),
      payfastIsSandbox: updated.payfastIsSandbox,
    };
  }

  async configureOzowGateway(
    merchantId: string,
    body: {
      siteCode: string;
      privateKey: string;
      apiKey?: string;
      testMode?: boolean;
    },
  ) {
    const id = merchantId?.trim();

    try {
      if (!id) throw new BadRequestException('merchantId is required');

      const ozowSiteCode = body?.siteCode?.trim();
      if (!ozowSiteCode) {
        throw new BadRequestException('siteCode is required');
      }

      const ozowPrivateKey = body?.privateKey?.trim();
      if (!ozowPrivateKey) {
        throw new BadRequestException('privateKey is required');
      }

      const ozowApiKey = body?.apiKey?.trim() || null;
      if (body?.testMode !== undefined && typeof body.testMode !== 'boolean') {
        throw new BadRequestException('testMode must be boolean');
      }

      const merchant = await this.prisma.merchant.findUnique({
        where: { id },
        select: {
          id: true,
          ozowIsTest: true,
        },
      });
      if (!merchant) throw new NotFoundException('Merchant not found');

      const updateData: Prisma.MerchantUpdateInput = {
        // TODO: Encrypt Ozow credentials at rest when encryption helpers are available.
        ozowSiteCode,
        ozowPrivateKey,
        ozowApiKey,
      };
      if (body?.testMode !== undefined) {
        updateData.ozowIsTest = body.testMode;
      }

      const updated = await this.prisma.merchant.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          ozowSiteCode: true,
          ozowPrivateKey: true,
          ozowApiKey: true,
          ozowIsTest: true,
          updatedAt: true,
        },
      });

      return this.serializeOzowGatewayConnection({
        ...updated,
        ozowIsTest:
          body?.testMode !== undefined ? body.testMode : merchant.ozowIsTest,
      });
    } catch (error) {
      this.logGatewayServiceError({
        routeName: 'POST /v1/merchants/:merchantId/gateways/ozow',
        merchantId: id,
        requestMethod: 'POST',
        body,
        error,
      });
      throw error;
    }
  }

  async configureYocoGateway(
    merchantId: string,
    body: {
      publicKey: string;
      secretKey: string;
      testMode?: boolean;
    },
  ) {
    const id = merchantId?.trim();

    try {
      if (!id) throw new BadRequestException('merchantId is required');

      const yocoPublicKey = body?.publicKey?.trim();
      if (!yocoPublicKey) {
        throw new BadRequestException('publicKey is required');
      }

      const yocoSecretKey = body?.secretKey?.trim();
      if (!yocoSecretKey) {
        throw new BadRequestException('secretKey is required');
      }

      if (body?.testMode !== undefined && typeof body.testMode !== 'boolean') {
        throw new BadRequestException('testMode must be boolean');
      }

      const merchant = await this.prisma.merchant.findUnique({
        where: { id },
      select: {
        id: true,
        yocoTestMode: true,
        yocoPublicKey: true,
        yocoSecretKey: true,
        yocoWebhookId: true,
        yocoWebhookSecret: true,
        yocoWebhookUrl: true,
      },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

      const detectedMode = detectYocoModeFromKeys(yocoPublicKey, yocoSecretKey);
      const yocoTestMode = body?.testMode ?? detectedMode ?? merchant.yocoTestMode;
      if (yocoTestMode === null || yocoTestMode === undefined) {
        throw new BadRequestException('testMode is required');
      }

      try {
        assertYocoConfigConsistency(
          resolveYocoConfig({
            yocoPublicKey,
            yocoSecretKey,
            yocoTestMode,
          }),
        );
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Invalid Yoco configuration',
        );
      }

      const desiredWebhookUrl = this.yocoGateway.resolveWebhookUrl();
      const credentialsChanged =
        merchant.yocoPublicKey !== yocoPublicKey ||
        merchant.yocoSecretKey !== yocoSecretKey ||
        merchant.yocoTestMode !== yocoTestMode;

      const hasReusableWebhook =
        !credentialsChanged &&
        Boolean(merchant.yocoWebhookId?.trim()) &&
        Boolean(merchant.yocoWebhookSecret?.trim()) &&
        merchant.yocoWebhookUrl?.trim() === desiredWebhookUrl;

      const webhook =
        hasReusableWebhook
          ? {
              id: merchant.yocoWebhookId?.trim() ?? null,
              secret: merchant.yocoWebhookSecret?.trim() ?? null,
              url: merchant.yocoWebhookUrl?.trim() ?? desiredWebhookUrl,
            }
          : await this.registerYocoWebhook({
              merchantId: id,
              publicKey: yocoPublicKey,
              secretKey: yocoSecretKey,
              testMode: yocoTestMode,
              desiredWebhookUrl,
            });

      const updated = await this.prisma.merchant.update({
        where: { id },
        data: {
          // TODO: Encrypt Yoco credentials at rest when encryption helpers are available.
          yocoPublicKey,
          yocoSecretKey,
          yocoTestMode,
          yocoWebhookId: webhook.id,
          yocoWebhookSecret: webhook.secret,
          yocoWebhookUrl: webhook.url,
        },
        select: {
          id: true,
          yocoPublicKey: true,
          yocoSecretKey: true,
          yocoTestMode: true,
          yocoWebhookId: true,
          yocoWebhookSecret: true,
          yocoWebhookUrl: true,
          updatedAt: true,
        },
      });

      return this.serializeYocoGatewayConnection(updated);
    } catch (error) {
      this.logGatewayServiceError({
        routeName: 'POST /v1/merchants/:merchantId/gateways/yoco',
        merchantId: id,
        requestMethod: 'POST',
        body,
        error,
      });
      throw error;
    }
  }

  async configurePaystackGateway(
    merchantId: string,
    body: {
      secretKey: string;
      testMode?: boolean;
    },
  ) {
    const id = merchantId?.trim();

    try {
      if (!id) throw new BadRequestException('merchantId is required');

      const paystackSecretKey = body?.secretKey?.trim();
      if (!paystackSecretKey) {
        throw new BadRequestException('secretKey is required');
      }

      if (body?.testMode !== undefined && typeof body.testMode !== 'boolean') {
        throw new BadRequestException('testMode must be boolean');
      }

      const merchant = await this.prisma.merchant.findUnique({
        where: { id },
        select: {
          id: true,
          paystackTestMode: true,
        },
      });
      if (!merchant) throw new NotFoundException('Merchant not found');

      const detectedMode = detectPaystackModeFromSecretKey(paystackSecretKey);
      const paystackTestMode =
        body?.testMode ?? detectedMode ?? merchant.paystackTestMode;
      if (paystackTestMode === null || paystackTestMode === undefined) {
        throw new BadRequestException('testMode is required');
      }

      try {
        assertPaystackConfigConsistency(
          resolvePaystackConfig({
            paystackSecretKey,
            paystackTestMode,
          }),
        );
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error
            ? error.message
            : 'Invalid Paystack configuration',
        );
      }

      const updated = await this.prisma.merchant.update({
        where: { id },
        data: {
          paystackSecretKey,
          paystackTestMode,
        },
        select: {
          id: true,
          paystackSecretKey: true,
          paystackTestMode: true,
          updatedAt: true,
        },
      });

      return this.serializePaystackGatewayConnection(updated);
    } catch (error) {
      this.logGatewayServiceError({
        routeName: 'POST /v1/merchants/:merchantId/gateways/paystack',
        merchantId: id,
        requestMethod: 'POST',
        body,
        error,
      });
      throw error;
    }
  }

  /**
   * Revoke an API key (soft revoke by setting revokedAt).
   */
  async revokeApiKey(merchantId: string, apiKeyId: string) {
    const existing = await this.prisma.apiKey.findFirst({
      where: { id: apiKeyId, merchantId },
      select: { id: true, revokedAt: true },
    });

    if (!existing) throw new NotFoundException('API key not found');

    if (existing.revokedAt) {
      return { ok: true, revoked: true, apiKeyId };
    }

    await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { revokedAt: new Date() },
    });

    return { ok: true, revoked: true, apiKeyId };
  }

  /**
   * Validate an API key (plain), ensure not revoked, and optionally update lastUsedAt.
   * This is used by Payments/Webhooks auth.
   */
  async validateApiKey(plainApiKey: string, touchLastUsed = true) {
    if (!plainApiKey || typeof plainApiKey !== 'string') {
      throw new BadRequestException('Missing API key');
    }

    const keyHash = this.hashApiKey(plainApiKey);

    const apiKey = await this.prisma.apiKey.findFirst({
      where: {
        keyHash,
        revokedAt: null,
      },
      select: {
        id: true,
        merchantId: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });

    if (!apiKey) throw new NotFoundException('API key not found');

    if (touchLastUsed) {
      await this.prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      });
    }

    return apiKey;
  }

  private logPrismaError(operation: string, error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      this.logger.error(
        `Prisma ${operation} failed (code=${error.code}, clientVersion=${error.clientVersion})`,
        JSON.stringify(error.meta ?? {}),
      );
      return;
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      this.logger.error(
        `Prisma ${operation} failed with unknown request error (${error.clientVersion})`,
        error.message,
      );
      return;
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      this.logger.error(
        `Prisma ${operation} initialization error (${error.clientVersion})`,
        error.message,
      );
      return;
    }

    if (error instanceof Prisma.PrismaClientRustPanicError) {
      this.logger.error(
        `Prisma ${operation} panic (${error.clientVersion})`,
        error.message,
      );
      return;
    }

    this.logger.error(
      `Prisma ${operation} failed with non-Prisma error`,
      error instanceof Error ? error.stack : String(error),
    );
  }

  private logGatewayServiceError(args: {
    routeName: string;
    merchantId?: string | null;
    requestMethod: 'GET' | 'POST';
    body: unknown;
    error: unknown;
  }) {
    const stack = args.error instanceof Error ? args.error.stack : undefined;
    const payload = {
      event: 'merchant_gateway_service_error',
      routeName: args.routeName,
      merchantId: args.merchantId ?? null,
      requestMethod: args.requestMethod,
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
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return {
        prisma: {
          name: error.name,
          code: error.code,
          clientVersion: error.clientVersion,
          meta: error.meta ?? null,
        },
      };
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      return {
        prisma: {
          name: error.name,
          code: null,
          clientVersion: error.clientVersion,
          meta: null,
        },
      };
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      return {
        prisma: {
          name: error.name,
          code: null,
          clientVersion: error.clientVersion,
          meta: null,
        },
      };
    }

    if (error instanceof Prisma.PrismaClientRustPanicError) {
      return {
        prisma: {
          name: error.name,
          code: null,
          clientVersion: error.clientVersion,
          meta: null,
        },
      };
    }

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

  private serializeOzowGatewayConnection(merchant: {
    id: string;
    ozowSiteCode: string | null;
    ozowPrivateKey: string | null;
    ozowApiKey: string | null;
    ozowIsTest: boolean | null;
    updatedAt: Date;
  }) {
    const siteCode = merchant.ozowSiteCode?.trim() || null;
    const hasPrivateKey = Boolean(merchant.ozowPrivateKey?.trim());
    const hasApiKey = Boolean(merchant.ozowApiKey?.trim());
    const configured = Boolean(siteCode && hasPrivateKey);
    const connected = Boolean(siteCode && hasPrivateKey && hasApiKey);
    const hasAnySavedState = Boolean(
      siteCode ||
        hasPrivateKey ||
        hasApiKey ||
        merchant.ozowIsTest !== null,
    );
    const resolvedConfig = resolveOzowConfig({
      ozowIsTest: merchant.ozowIsTest,
    });

    return {
      id: merchant.id,
      connected,
      configured,
      ozowConfigured: configured,
      siteCode,
      ozowSiteCode: siteCode,
      siteCodeMasked: siteCode,
      hasApiKey,
      hasPrivateKey,
      ozowApiKeyConfigured: hasApiKey,
      ozowPrivateKeyConfigured: hasPrivateKey,
      testMode: resolvedConfig.isTest,
      ozowTestMode: resolvedConfig.isTest,
      updatedAt: hasAnySavedState ? merchant.updatedAt.toISOString() : null,
    };
  }

  private serializeYocoGatewayConnection(merchant: {
    id: string;
    yocoPublicKey: string | null;
    yocoSecretKey: string | null;
    yocoTestMode: boolean | null;
    yocoWebhookId?: string | null;
    yocoWebhookSecret?: string | null;
    yocoWebhookUrl?: string | null;
    updatedAt: Date;
  }) {
    const hasPublicKey = Boolean(merchant.yocoPublicKey?.trim());
    const hasSecretKey = Boolean(merchant.yocoSecretKey?.trim());
    const connected = hasPublicKey && hasSecretKey;
    const hasAnySavedState = Boolean(
      hasPublicKey || hasSecretKey || merchant.yocoTestMode !== null,
    );

    let testMode = merchant.yocoTestMode ?? false;
    try {
      testMode = resolveYocoConfig({
        yocoPublicKey: merchant.yocoPublicKey,
        yocoSecretKey: merchant.yocoSecretKey,
        yocoTestMode: merchant.yocoTestMode,
      }).testMode;
    } catch {
      // Keep GET readback non-fatal even if legacy keys are inconsistent.
    }

    return {
      id: merchant.id,
      connected,
      hasPublicKey,
      hasSecretKey,
      testMode,
      webhookConfigured: Boolean(
        merchant.yocoWebhookSecret?.trim() && merchant.yocoWebhookUrl?.trim(),
      ),
      updatedAt: hasAnySavedState ? merchant.updatedAt.toISOString() : null,
    };
  }

  private serializePaystackGatewayConnection(merchant: {
    id: string;
    paystackSecretKey: string | null;
    paystackTestMode: boolean | null;
    updatedAt: Date;
  }) {
    const hasSecretKey = Boolean(merchant.paystackSecretKey?.trim());
    const hasAnySavedState = Boolean(
      hasSecretKey || merchant.paystackTestMode !== null,
    );

    let testMode = merchant.paystackTestMode ?? false;
    try {
      testMode = resolvePaystackConfig({
        paystackSecretKey: merchant.paystackSecretKey,
        paystackTestMode: merchant.paystackTestMode,
      }).testMode;
    } catch {
      // Keep GET readback non-fatal even if legacy keys are inconsistent.
    }

    return {
      id: merchant.id,
      connected: hasSecretKey,
      hasSecretKey,
      testMode,
      updatedAt: hasAnySavedState ? merchant.updatedAt.toISOString() : null,
    };
  }

  private async registerYocoWebhook(args: {
    merchantId: string;
    publicKey: string;
    secretKey: string;
    testMode: boolean;
    desiredWebhookUrl: string;
  }) {
    const subscription = await this.yocoGateway.registerWebhookSubscription({
      config: {
        yocoPublicKey: args.publicKey,
        yocoSecretKey: args.secretKey,
        yocoTestMode: args.testMode,
      },
      name: this.buildYocoWebhookName(args.merchantId, args.testMode),
      url: args.desiredWebhookUrl,
    });

    if (!subscription.secret) {
      throw new BadRequestException(
        'Yoco webhook registration did not return a secret',
      );
    }

    return {
      id: subscription.id,
      secret: subscription.secret,
      url: subscription.url,
    };
  }

  private buildYocoWebhookName(merchantId: string, testMode: boolean) {
    const compactMerchantId = merchantId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const mode = testMode ? 'test' : 'live';
    return `stackaura-${mode}-${compactMerchantId || 'merchant'}`;
  }
}
