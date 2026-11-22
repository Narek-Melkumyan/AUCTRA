import { Global, Module } from '@nestjs/common';
import { AuctionsController } from './auctions.controller.js';
import { AuctionsService } from './auctions.service.js';
import { AuctionLifecycleService } from './auction-lifecycle.service.js';
import { CategoriesModule } from '../categories/categories.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { BidsController } from '../bids/bids.controller.js';
import { BidsService } from '../bids/bids.service.js';
import { BidGate } from '../bids/bid-gate.js';

@Global()
@Module({
  imports: [CategoriesModule, NotificationsModule],
  controllers: [AuctionsController, BidsController],
  providers: [AuctionsService, AuctionLifecycleService, BidsService, BidGate],
  exports: [AuctionsService, AuctionLifecycleService, BidsService],
})
export class AuctionsModule {}
