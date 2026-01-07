import type Client from '@triton-one/yellowstone-grpc';
import type {
	SubscribeRequest,
	SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import type { ClientDuplexStream, ChannelOptions } from '@grpc/grpc-js';

import {
	CommitmentLevel as LaserCommitmentLevel,
	subscribe as LaserSubscribe,
	CompressionAlgorithms,
} from 'helius-laserstream';
import type {
	LaserstreamConfig,
	SubscribeRequest as LaserSubscribeRequest,
	SubscribeUpdate as LaserSubscribeUpdate,
} from 'helius-laserstream';

export {
	CommitmentLevel,
	Client,
	LaserSubscribe,
	LaserCommitmentLevel,
	CompressionAlgorithms,
};
export type {
	ClientDuplexStream,
	ChannelOptions,
	SubscribeRequest,
	SubscribeUpdate,
	LaserstreamConfig,
	LaserSubscribeRequest,
	LaserSubscribeUpdate,
};

// Export a function to create a new Client instance
export async function createClient(
	...args: ConstructorParameters<typeof Client>
): Promise<Client> {
	const { default: Client_ } = await import('@triton-one/yellowstone-grpc');
	return new Client_(...args);
}
