import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CheckoutController } from './checkout.controller';

@Module({
  imports: [PrismaModule, PaymentsModule],
  controllers: [CheckoutController],
})
export class CheckoutModule {}
