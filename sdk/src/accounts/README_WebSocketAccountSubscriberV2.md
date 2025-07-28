# WebSocketAccountSubscriberV2

This is a new implementation of the WebSocket account subscriber that utilizes the [gill](https://www.npmjs.com/package/gill) library for improved RPC and WebSocket functionality.

## Overview

The `WebSocketAccountSubscriberV2` class provides the same interface as the original `WebSocketAccountSubscriber` but uses gill's modern JavaScript/TypeScript client library for Solana blockchain interactions.

## Key Benefits

1. **Modern Library**: Uses gill, which is built on top of Anza's `@solana/kit` (formerly web3.js v2)
2. **Better Performance**: Optimized RPC calls and WebSocket subscriptions
3. **Type Safety**: Full TypeScript support with better type definitions
4. **Compatibility**: Drop-in replacement for existing `WebSocketAccountSubscriber`

## Installation

First, install the gill dependency:

```bash
npm install gill
```

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

// Fetch initial data
await subscriber.fetch();

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

### Fallback Implementation

The current implementation includes fallback code that uses the original web3.js methods when gill is not available. This ensures backward compatibility while the gill integration is being set up.

## Migration Guide

To migrate from `WebSocketAccountSubscriber` to `WebSocketAccountSubscriberV2`:

1. **Install gill**: `npm install gill`
2. **Update imports**: Replace the import statement
3. **Uncomment gill code**: Remove the TODO comments and uncomment the gill-specific code
4. **Test thoroughly**: Ensure all functionality works as expected

## Example with Gill Integration

Here's how the implementation looks when fully integrated with gill:

```typescript
// Constructor with gill initialization
const rpcUrl = (this.program.provider as AnchorProvider).connection.rpcEndpoint;
const { rpc, rpcSubscriptions } = createSolanaClient({
	urlOrMoniker: rpcUrl,
});
this.rpc = rpc;
this.rpcSubscriptions = rpcSubscriptions;

// Subscribe using gill's WebSocket
const accountAddress = this.accountPublicKey.toBase58() as Address;
this.listenerId = this.rpcSubscriptions
	.accountNotifications(accountAddress)
	.subscribe(
		{
			commitment: this.commitment,
			encoding: 'base64',
		},
		(notification) => {
			this.handleRpcResponse(notification.context, notification.value);
		}
	);

// Fetch using gill's RPC
const rpcResponse = await this.rpc
	.getAccountInfo(accountAddress, {
		commitment: this.commitment,
		encoding: 'base64',
	})
	.send();
```

## Benefits of Using Gill

1. **Performance**: Better connection management and optimized RPC calls
2. **Reliability**: Improved error handling and reconnection logic
3. **Modern APIs**: Uses the latest Solana JavaScript client libraries
4. **Type Safety**: Better TypeScript support and type definitions
5. **Future-Proof**: Built on the foundation of Solana's modern tooling

## Troubleshooting

### Common Issues

1. **Module not found**: Ensure gill is installed: `npm install gill`
2. **Type errors**: Make sure TypeScript can find gill's type definitions
3. **Connection issues**: Verify the RPC URL is accessible and supports WebSocket connections

### Debug Mode

Gill supports debug mode for troubleshooting:

```typescript
// Enable debug mode
process.env.GILL_DEBUG = 'true';

// Or in browser console
window.__GILL_DEBUG__ = true;
```

## References

- [Gill NPM Package](https://www.npmjs.com/package/gill)
- [Gill GitHub Repository](https://github.com/solana-foundation/gill)
- [Solana Kit Documentation](https://kit.solana.com/)
