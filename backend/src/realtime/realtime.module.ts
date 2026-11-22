import { Module } from '@nestjs/common';
import { AuctionsGateway } from './auctions.gateway.js';
import { OutboxRelayService } from './outbox-relay.service.js';

@Module({
  providers: [AuctionsGateway, OutboxRelayService],
  exports: [OutboxRelayService, AuctionsGateway],
})
export class RealtimeModule {}
