import type Client from '@triton-one/yellowstone-grpc';
import type {
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
export async function createClient(
	...args: ConstructorParameters<typeof Client>
): Promise<Client> {
	const { default: Client_ } = await import('@triton-one/yellowstone-grpc');
	return new Client_(...args);
}
