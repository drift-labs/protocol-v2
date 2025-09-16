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

### Polling Instead of Resubscribing

For accounts that rarely update (like long-tail markets), you can use polling instead of resubscribing to reduce resource usage:

```typescript
const resubOpts = {
	resubTimeoutMs: 30000, // 30 seconds
	logResubMessages: true,
	usePollingInsteadOfResub: true, // Enable polling mode
	pollingIntervalMs: 30000, // Poll every 30 seconds (optional, defaults to 30000)
};

const subscriber = new WebSocketAccountSubscriberV2(
	'perpMarket', // account name
	program,
	marketPublicKey,
	undefined, // decodeBuffer
	resubOpts
);
```

**How it works:**
1. Initially subscribes to WebSocket updates
2. If no WebSocket data is received for `resubTimeoutMs` (30s), switches to websocket+polling mode if `usePollingInsteadOfResub` is specified true, else just resubscribes(unsub, sub).
3. Polls every `pollingIntervalMs` (alongside websocket connection) to check for updates by:
   - Storing current account buffer state
   - Fetching latest account data
   - Comparing buffers to detect any missed updates
4. If polling detects new data (indicating missed WebSocket events):
   - Immediately stops polling
   - Resubscribes to WebSocket to restore real-time updates
   - This helps recover from degraded WebSocket connections
5. If a WebSocket event is received while polling:
   - Polling is automatically stopped
   - System continues with normal WebSocket updates
6. This approach provides:
   - Efficient handling of rarely-updated accounts
   - Automatic recovery from WebSocket connection issues
   - Seamless fallback between polling and WebSocket modes

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
6. **Polling Mode**: Optional polling mechanism for accounts that rarely update
