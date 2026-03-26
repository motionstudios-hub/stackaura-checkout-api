import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayProvider } from '@prisma/client';
import { OzowGateway } from './ozow.gateway';
import { PayfastGateway } from './payfast.gateway';
import { PaystackGateway } from './paystack.gateway';
import { YocoGateway } from './yoco.gateway';

@Injectable()
export class GatewayRegistry {
  constructor(
    private readonly payfastGateway: PayfastGateway,
    private readonly ozowGateway: OzowGateway,
    private readonly yocoGateway: YocoGateway,
    private readonly paystackGateway: PaystackGateway,
  ) {}

  get(provider: GatewayProvider) {
    switch (provider) {
      case GatewayProvider.PAYFAST:
        return this.payfastGateway;
      case GatewayProvider.OZOW:
        return this.ozowGateway;
      case GatewayProvider.YOCO:
        return this.yocoGateway;
      case GatewayProvider.PAYSTACK:
        return this.paystackGateway;
      default:
        throw new NotFoundException(`No adapter registered for ${provider}`);
    }
  }
}
