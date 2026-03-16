import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ApiKeyGuard } from './api-key.guard';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

@Module({
  imports: [PrismaModule],
  controllers: [PayoutsController],
  providers: [PayoutsService, ApiKeyGuard],
})
export class PayoutsModule {}
