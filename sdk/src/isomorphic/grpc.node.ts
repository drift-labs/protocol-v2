import type Client from '@triton-one/yellowstone-grpc';
import type {
	SubscribeRequest,
	SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { ClientDuplexStream, ChannelOptions } from '@grpc/grpc-js';

import {
	CommitmentLevel as LaserCommitmentLevel,
	subscribe as LaserSubscribe,
	LaserstreamConfig,
	SubscribeRequest as LaserSubscribeRequest,
	SubscribeUpdate as LaserSubscribeUpdate,
	CompressionAlgorithms,
} from 'helius-laserstream';

export {
	ClientDuplexStream,
	ChannelOptions,
	SubscribeRequest,
	SubscribeUpdate,
	CommitmentLevel,
	Client,
	LaserSubscribe,
	LaserCommitmentLevel,
	LaserstreamConfig,
	LaserSubscribeRequest,
	LaserSubscribeUpdate,
	CompressionAlgorithms,
};

// Export a function to create a new Client instance
export async function createClient(
	...args: ConstructorParameters<typeof Client>
): Promise<Client> {
	const { default: Client_ } = await import('@triton-one/yellowstone-grpc');
	return new Client_(...args);
}
