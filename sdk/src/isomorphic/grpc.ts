/**
 * DO NOT DO A STRAIGHT EXPORT FROM grpc.node.ts
 *
 * You will break the isomorphic build if you import anything from the bad packages except for the types (using "import type").
 */

import type Client from '@triton-one/yellowstone-grpc';
import type {
	SubscribeRequest,
	SubscribeUpdate,
	CommitmentLevel,
} from '@triton-one/yellowstone-grpc';
import type { ClientDuplexStream, ChannelOptions } from '@grpc/grpc-js';

export {
	ClientDuplexStream,
	ChannelOptions,
	SubscribeRequest,
	SubscribeUpdate,
	CommitmentLevel,
	Client,
};

// Declare the function type without implementation
export declare function createClient(...args: ConstructorParameters<typeof Client>): Client;