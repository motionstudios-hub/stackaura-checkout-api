import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PayoutRail, PayoutStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePayoutDto } from './payout.dto';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly payoutSelect = {
    id: true,
    merchantId: true,
    reference: true,
    idempotencyKey: true,
    currency: true,
    amountCents: true,
    status: true,
    rail: true,
    provider: true,
    providerRef: true,
    failureCode: true,
    failureMessage: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  constructor(private readonly prisma: PrismaService) {}

  async createPayout(
    merchantIdPlain: string,
    idempotencyKeyPlain: string,
    dto: CreatePayoutDto,
  ) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) {
      throw new BadRequestException('merchantId is required');
    }

    const idempotencyKey = idempotencyKeyPlain?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException('idempotencyKey is required');
    }

    if (dto.currency !== 'ZAR') {
      throw new BadRequestException('Only ZAR supported for now');
    }
    if (dto.rail !== 'DERIV') {
      throw new BadRequestException('Only DERIV rail supported for now');
    }
    if (!dto.reference?.trim()) {
      throw new BadRequestException('reference is required');
    }
    if (!dto.derivAccountId?.trim()) {
      throw new BadRequestException('derivAccountId is required');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.payout.findFirst({
          where: { merchantId, idempotencyKey },
          select: this.payoutSelect,
        });
        if (existing) {
          this.logger.log(
            `Returning existing payout for idempotency replay (merchantId=${merchantId}, payoutId=${existing.id})`,
          );
          return existing;
        }

        return tx.payout.create({
          data: {
            merchantId,
            reference: dto.reference.trim(),
            idempotencyKey,
            currency: dto.currency,
            amountCents: dto.amountCents,
            rail: PayoutRail.DERIV,
            status: PayoutStatus.CREATED,
            derivAccountId: dto.derivAccountId.trim(),
            beneficiaryName: dto.beneficiaryName?.trim() || null,
            provider: 'DERIV_PA',
          },
          select: this.payoutSelect,
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = this.uniqueTarget(error);
        if (
          target.includes('merchantId') &&
          target.includes('idempotencyKey')
        ) {
          const existing = await this.prisma.payout.findFirst({
            where: { merchantId, idempotencyKey },
            select: this.payoutSelect,
          });
          if (existing) {
            return existing;
          }
        }

        if (target.includes('reference')) {
          throw new ConflictException('Payout reference already exists');
        }
      }

      this.logPrismaError('payout.create', error);
      throw error;
    }
  }

  async getPayoutById(merchantIdPlain: string, payoutId: string) {
    const merchantId = merchantIdPlain?.trim();
    if (!merchantId) {
      throw new BadRequestException('merchantId is required');
    }

    const id = payoutId?.trim();
    if (!id) {
      throw new BadRequestException('id is required');
    }

    try {
      const payout = await this.prisma.payout.findFirst({
        where: { merchantId, id },
        select: this.payoutSelect,
      });

      if (!payout) {
        throw new NotFoundException('Payout not found');
      }

      return payout;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logPrismaError('payout.findFirst', error);
      throw error;
    }
  }

  private uniqueTarget(error: Prisma.PrismaClientKnownRequestError) {
    const target = error.meta?.target;
    if (Array.isArray(target)) {
      return target.filter(
        (entry): entry is string => typeof entry === 'string',
      );
    }
    if (typeof target === 'string') return [target];
    return [];
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
