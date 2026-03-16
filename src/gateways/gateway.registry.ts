import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayProvider } from '@prisma/client';
import { OzowGateway } from './ozow.gateway';
import { PayfastGateway } from './payfast.gateway';

@Injectable()
export class GatewayRegistry {
  constructor(
    private readonly payfastGateway: PayfastGateway,
    private readonly ozowGateway: OzowGateway,
  ) {}

  get(provider: GatewayProvider) {
    switch (provider) {
      case GatewayProvider.PAYFAST:
        return this.payfastGateway;
      case GatewayProvider.OZOW:
        return this.ozowGateway;
      default:
        throw new NotFoundException(
          `No adapter registered for ${provider}`,
        );
    }
  }
}