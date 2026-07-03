/**
 * Auction-eligible order tracking — filtered `User`-account subscriptions
 * (`AuctionSubscriber` over websocket, `AuctionSubscriberGrpc` over gRPC/Geyser)
 * scoped to accounts with at least one order currently in its auction window,
 * for keepers/fillers reacting to JIT-fillable or expiring-auction orders.
 */
export * from './types';
export * from './auctionSubscriber';
export * from './auctionSubscriberGrpc';
