import { Module } from '@nestjs/common';
import { GatewayRegistry } from './gateway.registry';
import { OzowGateway } from './ozow.gateway';
import { PayfastGateway } from './payfast.gateway';

@Module({
  providers: [GatewayRegistry, PayfastGateway, OzowGateway],
  exports: [GatewayRegistry, PayfastGateway, OzowGateway],
})
export class GatewaysModule {}