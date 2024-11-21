import Client from '@triton-one/yellowstone-grpc';
import {
	SubscribeRequest,
	SubscribeUpdate,
	CommitmentLevel,
} from '@triton-one/yellowstone-grpc';
import { ClientDuplexStream, ChannelOptions } from '@grpc/grpc-js';

export {
	ClientDuplexStream,
	ChannelOptions,
	SubscribeRequest,
	SubscribeUpdate,
	CommitmentLevel,
	Client,
};

// Export a function to create a new Client instance
export function createClient(
	...args: ConstructorParameters<typeof Client>
): Client {
	return new Client(...args);
}
