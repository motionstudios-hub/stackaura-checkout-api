import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveMerchantPlan } from '../payments/monetization.config';
import * as argon2 from 'argon2';
import crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

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

  private get ttlMs() {
    const ttlDays = Number(process.env.SESSION_TTL_DAYS ?? 14);
    return ttlDays * 24 * 60 * 60 * 1000;
  }

  private resolveSessionSecret() {
    const secret = process.env.SESSION_SECRET?.trim();
    if (!secret) {
      throw new Error('SESSION_SECRET is required');
    }

    return secret;
  }

  private signSession(userId: string, expiresAt: number) {
    const secret = this.resolveSessionSecret();
    const payload = `${userId}.${expiresAt}`;
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  private verifySession(token?: string) {
    if (!token) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [userId, expiresAtRaw, sig] = parts;
    const expiresAt = Number(expiresAtRaw);
    if (!userId || !expiresAt || Number.isNaN(expiresAt)) return null;
    if (Date.now() > expiresAt) return null;

    const secret = this.resolveSessionSecret();
    const payload = `${userId}.${expiresAt}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');

    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    return { userId, expiresAt };
  }

  async login(emailRaw: string, password: string) {
    const email = (emailRaw ?? '').trim().toLowerCase();
    if (!email || !password) {
      throw new BadRequestException('email and password are required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true, isActive: true },
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account not active. Complete signup to continue.');
    }

    const expiresAt = Date.now() + this.ttlMs;
    const sessionToken = this.signSession(user.id, expiresAt);

    return { userId: user.id, sessionToken, expiresAt: new Date(expiresAt) };
  }

  async logoutByUserId(_userId: string) {
    return { ok: true };
  }

  async resolveSession(sessionToken?: string) {
    const parsed = this.verifySession(sessionToken);
    if (!parsed) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: parsed.userId },
      select: { id: true, email: true },
    });

    if (!user) return null;

    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        role: true,
        merchant: {
          select: {
            id: true,
            name: true,
            email: true,
            isActive: true,
            planCode: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      user,
      memberships: memberships.map((membership) => ({
        ...membership,
        merchant: {
          ...membership.merchant,
          ...this.buildMerchantPlanReadback(membership.merchant.planCode),
        },
      })),
    };
  }
}
