import type { ClientDuplexStream, ChannelOptions } from '@grpc/grpc-js';
import type Client from '@triton-one/yellowstone-grpc';
import type {
	SubscribeRequest,
	SubscribeUpdate,
	CommitmentLevel,
} from '@triton-one/yellowstone-grpc';

export {
	ClientDuplexStream,
	ChannelOptions,
	SubscribeRequest,
	SubscribeUpdate,
	CommitmentLevel,
	Client,
};

export function createClient(
	...args: ConstructorParameters<typeof Client>
): Client;
