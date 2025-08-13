# WebSocketProgramAccountSubscriberV2

This is a new implementation of the WebSocket program account subscriber that utilizes the [gill](https://www.npmjs.com/package/gill) library for improved RPC and WebSocket functionality, with additional smart polling logic for specific accounts.

## Overview

The `WebSocketProgramAccountSubscriberV2` class provides the same interface as the original `WebSocketProgramAccountSubscriber` but uses gill's modern TypeScript client library for Solana blockchain interactions. Additionally, it implements smart polling logic for accounts that don't update frequently (like long-tail markets) to prevent missing updates.

## Key Features

1. **Gill Integration**: Uses gill's `createSolanaClient` for RPC and WebSocket functionality
2. **Smart Polling**: Optional polling for specific accounts that don't update frequently
3. **Missed Update Detection**: Automatically detects when updates are missed and resubscribes
4. **Configurable Polling**: 30-second default polling interval, customizable per instance

## Usage

The usage is similar to the original `WebSocketProgramAccountSubscriber` with additional options:

```typescript
import { WebSocketProgramAccountSubscriberV2 } from './accounts/webSocketProgramAccountSubscriberV2';

// Create subscriber with optional accounts to poll
const subscriber = new WebSocketProgramAccountSubscriberV2(
	'perpMarket', // account name
	'perpMarket', // account discriminator
	program, // Anchor program instance
	decodeBuffer, // decode function
	{ filters: [] }, // options
	resubOpts, // optional resubscription options
	[longTailMarket1, longTailMarket2] // optional list of accounts to poll
);

// Subscribe to program account changes
await subscriber.subscribe((accountId, data, context, buffer) => {
	console.log('Account updated:', accountId.toBase58(), data);
});

// Add more accounts to poll dynamically
subscriber.addAccountToPoll(newMarketPublicKey);

// Remove accounts from polling
subscriber.removeAccountFromPoll(oldMarketPublicKey);

// Change polling interval
subscriber.setPollingInterval(60000); // 60 seconds

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

### Smart Polling Logic

1. **Account Selection**: Only accounts in the `accountsToMonitor` set are monitored
2. **Monitoring Period**: Default 30 seconds before starting to poll an account
3. **WebSocket Tracking**: Tracks the last WebSocket notification time for each account
4. **Conditional Polling**: Only starts polling if no WebSocket notification received in 30 seconds
5. **Batch Polling**: Uses `getMultipleAccounts` to poll all accounts in a single RPC call
6. **Dynamic Polling**: Stops polling individual accounts when WebSocket notifications are received
7. **Missed Update Detection**: Compares current slot and buffer with cached data
8. **Automatic Resubscription**: If a missed update is detected, the entire subscription is resubscribed

### Key Differences from Original

1. **RPC Client**: Uses gill's `rpc` client for account fetching
2. **WebSocket Subscriptions**: Uses gill's `rpcSubscriptions` for real-time updates
3. **Address Handling**: Converts `PublicKey` to gill's `Address` type for compatibility
4. **Response Formatting**: Converts gill responses to match the expected `AccountInfo<Buffer>` format
5. **Abort Signal**: Utilizes AbortSignal nodejs/web class to shutdown websocket connection synchronously
6. **Smart Polling**: Implements polling logic for specific accounts to prevent missed updates

## Configuration Options

### Constructor Parameters

- `subscriptionName`: Name for logging purposes
- `accountDiscriminator`: Account discriminator for decoding
- `program`: Anchor program instance
- `decodeBufferFn`: Function to decode account data
- `options`: Subscription options (filters, commitment)
- `resubOpts`: Resubscription options
- `accountsToPoll`: Optional array of PublicKeys to poll

### Polling Configuration

- **Default Monitoring Period**: 30 seconds before starting to poll
- **WebSocket Tracking**: Records timestamp of last WebSocket notification per account
- **Conditional Polling**: Only polls accounts that haven't received WebSocket updates recently
- **Batch Polling**: Uses `getMultipleAccounts` for efficient polling of multiple accounts
- **Dynamic Management**: Automatically starts/stops polling based on WebSocket activity
- **Detection Logic**: Compares slot numbers and buffer contents
- **Resubscription**: Triggers when missed updates are detected
- **Logging**: Optional logging of polling events

## Current Limitations

1. **Gill API Compatibility**: Some type mismatches exist with the current gill version
2. **Account Key Handling**: The account key extraction from gill notifications needs refinement
3. **Encoding Types**: Some encoding type comparisons need to be resolved

## Future Improvements

1. **Better Gill Integration**: Resolve remaining type compatibility issues
2. **Enhanced Logging**: More detailed logging for debugging
3. **Performance Optimization**: Optimize polling frequency based on account activity
4. **Batch Polling**: Poll multiple accounts in a single RPC call

## Migration from V1

The V2 implementation maintains the same interface as V1, making migration straightforward:

```typescript
// V1
const subscriber = new WebSocketProgramAccountSubscriber(...);

// V2 (same interface)
const subscriber = new WebSocketProgramAccountSubscriberV2(...);

// V2 with polling (new feature)
const subscriber = new WebSocketProgramAccountSubscriberV2(..., accountsToPoll);
```
