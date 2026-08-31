import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CommandCenterService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(userId?: string) {
    if (!userId) {
      throw new UnauthorizedException('Authenticated user required');
    }

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId,
        merchant: { isActive: true },
      },
      include: {
        merchant: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!membership) {
      throw new UnauthorizedException('No active merchant membership found');
    }

    const merchantId = membership.merchantId;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [payments, recentPayments, webhookDeliveries] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          merchantId,
          createdAt: { gte: startOfToday },
        },
        select: {
          amount: true,
          status: true,
          gateway: true,
          createdAt: true,
        },
      }),
      this.prisma.payment.findMany({
        where: { merchantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          reference: true,
          amount: true,
          currency: true,
          status: true,
          gateway: true,
          createdAt: true,
        },
      }),
      this.prisma.webhookDelivery.findMany({
        where: {
          endpoint: { merchantId },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: {
          status: true,
          attempts: true,
          lastStatusCode: true,
          lastError: true,
          updatedAt: true,
        },
      }),
    ]);

    const successful = payments.filter((payment) => payment.status === 'PAID');
    const failed = payments.filter((payment) => payment.status === 'FAILED');
    const pending = payments.filter((payment) => payment.status === 'PENDING');
    const revenueCents = successful.reduce((total, payment) => total + payment.amount, 0);
    const successRate = payments.length
      ? Number(((successful.length / payments.length) * 100).toFixed(2))
      : 0;

    const gatewayStats = ['PAYSTACK', 'YOCO', 'OZOW'].reduce<Record<string, { status: string; transactions: number; revenueCents: number }>>(
      (acc, gateway) => {
        const gatewayPayments = successful.filter((payment) => payment.gateway === gateway);
        acc[gateway.toLowerCase()] = {
          status: gatewayPayments.length > 0 ? 'operational' : 'no_recent_activity',
          transactions: gatewayPayments.length,
          revenueCents: gatewayPayments.reduce((total, payment) => total + payment.amount, 0),
        };
        return acc;
      },
      {},
    );

    const successfulDeliveries = webhookDeliveries.filter((delivery) => delivery.status === 'SUCCESS').length;
    const failedDeliveries = webhookDeliveries.filter((delivery) => delivery.status === 'FAILED').length;
    const pendingDeliveries = webhookDeliveries.filter((delivery) => delivery.status === 'PENDING').length;
    const deliveryRate = webhookDeliveries.length
      ? Number(((successfulDeliveries / webhookDeliveries.length) * 100).toFixed(2))
      : 0;

    return {
      status: 'operational',
      merchant: {
        id: membership.merchant.id,
        name: membership.merchant.name,
      },
      business: {
        today: {
          revenueCents,
          transactions: payments.length,
          successful: successful.length,
          failed: failed.length,
          pending: pending.length,
          successRate,
        },
      },
      gateways: gatewayStats,
      webhooks: {
        deliverySuccessRate: deliveryRate,
        pending: pendingDeliveries,
        failed: failedDeliveries,
        sampledDeliveries: webhookDeliveries.length,
      },
      recentPayments,
      updatedAt: new Date().toISOString(),
    };
  }
}
