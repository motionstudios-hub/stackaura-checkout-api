import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import crypto from 'crypto';

@Injectable()
export class MerchantsService {
  private readonly logger = new Logger(MerchantsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listMerchants() {
    try {
      return await this.prisma.merchant.findMany({
        orderBy: { createdAt: 'desc' },
      });
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
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

    const normalizedEnv = (
      environment ??
      process.env.API_KEY_ENV ??
      'test'
    ).toLowerCase();
    if (normalizedEnv !== 'test' && normalizedEnv !== 'live') {
      throw new BadRequestException('environment must be test or live');
    }

    const keyPrefix = normalizedEnv === 'live' ? 'ck_live' : 'ck_test';
    const apiKeyPlain = this.generateApiKey(keyPrefix);
    const keyHash = this.hashApiKey(apiKeyPlain);

    // Store non-sensitive metadata for UI/debugging
    const storedPrefix = apiKeyPlain.slice(0, 12); // e.g. ck_test_xxxx
    const last4 = apiKeyPlain.slice(-4);

    await this.prisma.apiKey.create({
      data: {
        merchantId,
        keyHash,
        label: label ?? 'default',
        prefix: storedPrefix,
        last4,
      },
    });

    return { apiKey: apiKeyPlain };
  }

  async createMerchantAccount(body: {
    businessName: string;
    email: string;
    password: string;
    country?: string;
  }) {
    const { businessName, email, password, country } = body;

    if (!businessName?.trim()) {
      throw new BadRequestException('businessName is required');
    }

    if (!email?.trim()) {
      throw new BadRequestException('email is required');
    }

    if (!password || password.length < 6) {
      throw new BadRequestException('password must be at least 6 characters');
    }

    const existing = await this.prisma.merchant.findFirst({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('Merchant with this email already exists');
    }

    const merchant = await this.prisma.merchant.create({
      data: {
        name: businessName,
        email: email.toLowerCase(),
      },
    });

    // generate default test API key
    const apiKeyPlain = this.generateApiKey('ck_test');
    const keyHash = this.hashApiKey(apiKeyPlain);

    const storedPrefix = apiKeyPlain.slice(0, 12);
    const last4 = apiKeyPlain.slice(-4);

    await this.prisma.apiKey.create({
      data: {
        merchantId: merchant.id,
        keyHash,
        label: 'default',
        prefix: storedPrefix,
        last4,
      },
    });

    return {
      merchant,
      apiKey: apiKeyPlain,
    };
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
    },
  ) {
    const id = merchantId?.trim();
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

    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

    const updated = await this.prisma.merchant.update({
      where: { id },
      data: {
        // TODO: Encrypt Ozow credentials at rest when encryption helpers are available.
        ozowSiteCode,
        ozowPrivateKey,
        ozowApiKey,
      },
      select: {
        id: true,
        ozowSiteCode: true,
        ozowPrivateKey: true,
      },
    });

    return {
      id: updated.id,
      ozowSiteCode: updated.ozowSiteCode,
      ozowConfigured: Boolean(
        updated.ozowSiteCode?.trim() && updated.ozowPrivateKey?.trim(),
      ),
    };
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
}
