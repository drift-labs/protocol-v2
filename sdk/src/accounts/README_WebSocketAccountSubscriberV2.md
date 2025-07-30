# WebSocketAccountSubscriberV2

This is a new implementation of the WebSocket account subscriber that utilizes the [gill](https://www.npmjs.com/package/gill) library for improved RPC and WebSocket functionality.

## Overview

The `WebSocketAccountSubscriberV2` class provides the same interface as the original `WebSocketAccountSubscriber` but uses gill's modern TypeScript client library for Solana blockchain interactions.

## Usage

The usage is identical to the original `WebSocketAccountSubscriber`:

```typescript
import { WebSocketAccountSubscriberV2 } from './accounts/webSocketAccountSubscriberV2';

const subscriber = new WebSocketAccountSubscriberV2(
	'userAccount', // account name
	program, // Anchor program instance
	userAccountPublicKey, // PublicKey of the account to subscribe to
	decodeBuffer, // optional custom decode function
	resubOpts, // optional resubscription options
	commitment // optional commitment level
);

// Subscribe to account changes
await subscriber.subscribe((data) => {
	console.log('Account updated:', data);
});

// Unsubscribe when done
await subscriber.unsubscribe();
```

## Implementation Details

### Gill Integration

The implementation uses gill's `createSolanaClient` function to create RPC and WebSocket clients:

```typescript
import { createSolanaClient } from 'gill';

const { rpc, rpcSubscriptions } = createSolanaClient({
	urlOrMoniker: rpcUrl, // or "mainnet", "devnet", etc.
});
```

### Key Differences from Original

1. **RPC Client**: Uses gill's `rpc` client for account fetching
2. **WebSocket Subscriptions**: Uses gill's `rpcSubscriptions` for real-time updates
3. **Address Handling**: Converts `PublicKey` to gill's `Address` type for compatibility
4. **Response Formatting**: Converts gill responses to match the expected `AccountInfo<Buffer>` format
5. **Abort Signal**: Utilizes AbortSignal nodejs/web class to shutdown websocket connection synchronously
