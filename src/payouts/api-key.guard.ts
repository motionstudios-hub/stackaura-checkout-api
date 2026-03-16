import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

export type ApiKeyAuthContext = {
  apiKeyId: string;
  merchantId: string;
  keyHash: string;
};

export type ApiKeyRequest = Request & {
  apiKeyAuth?: ApiKeyAuthContext;
};

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const apiKeyPlain = this.resolveApiKey(
      request.headers?.authorization,
      request.headers?.['x-api-key'],
    );
    this.assertApiKeyEnvironment(apiKeyPlain);
    const keyHash = this.hashApiKey(apiKeyPlain);

    try {
      const apiKey = await this.prisma.apiKey.findFirst({
        where: { keyHash, revokedAt: null },
        select: { id: true, merchantId: true },
      });

      if (!apiKey) {
        throw new UnauthorizedException('Invalid API key');
      }

      request.apiKeyAuth = {
        apiKeyId: apiKey.id,
        merchantId: apiKey.merchantId,
        keyHash,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logPrismaError(error);
      throw new UnauthorizedException('Invalid API key');
    }
  }

  private resolveApiKey(
    authorizationHeader: string | string[] | undefined,
    apiKeyHeader: string | string[] | undefined,
  ) {
    const authValue = Array.isArray(authorizationHeader)
      ? authorizationHeader[0]
      : authorizationHeader;

    if (authValue?.trim()) {
      const match = authValue.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        throw new UnauthorizedException('Invalid Authorization header');
      }

      const token = match[1].trim();
      if (!token) {
        throw new UnauthorizedException('Empty API key');
      }

      return token;
    }

    const fallback = Array.isArray(apiKeyHeader)
      ? apiKeyHeader[0]
      : apiKeyHeader;
    const apiKey = fallback?.trim();
    if (!apiKey) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    return apiKey;
  }

  private hashApiKey(plain: string) {
    return createHash('sha256').update(plain).digest('hex');
  }

  private assertApiKeyEnvironment(apiKeyPlain: string) {
    const env = process.env.API_KEY_ENV?.toLowerCase();
    if (!env) return;

    if (env !== 'test' && env !== 'live') {
      throw new BadRequestException('API_KEY_ENV must be test or live');
    }

    const isTestKey = apiKeyPlain.startsWith('ck_test_');
    const isLiveKey = apiKeyPlain.startsWith('ck_live_');

    if (env === 'live' && !isLiveKey) {
      throw new UnauthorizedException('API key not allowed in live mode');
    }

    if (env === 'test' && !isTestKey) {
      throw new UnauthorizedException('API key not allowed in test mode');
    }
  }

  private logPrismaError(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      this.logger.error(
        `Prisma apiKey.findFirst failed (code=${error.code}, clientVersion=${error.clientVersion})`,
        JSON.stringify(error.meta ?? {}),
      );
      return;
    }

    this.logger.error(
      'Prisma apiKey.findFirst failed',
      error instanceof Error ? error.stack : String(error),
    );
  }
}
