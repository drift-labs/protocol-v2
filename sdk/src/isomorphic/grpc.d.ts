import { ClientDuplexStream, ChannelOptions } from '@grpc/grpc-js';
import Client from '@triton-one/yellowstone-grpc';
import {
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
