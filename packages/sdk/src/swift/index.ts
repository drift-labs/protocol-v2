/**
 * Swift / signed-message order infrastructure.
 * Supports off-chain signed order messages that are matched and settled on-chain without
 * a separate place-order transaction. Used for low-latency taker flows.
 * `swiftOrderSubscriber.ts` — subscribes to incoming Swift orders via gRPC or WebSocket.
 * `signedMsgUserAccountSubscriber.ts` — caches signed-message user account state.
 */
export * from './swiftOrderSubscriber';
export * from './signedMsgUserAccountSubscriber';
export * from './grpcSignedMsgUserAccountSubscriber';
