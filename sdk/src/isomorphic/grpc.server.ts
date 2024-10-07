import Client from '@triton-one/yellowstone-grpc';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';

export { CommitmentLevel };

// Export a function to create a new Client instance
export function createClient(
	...args: ConstructorParameters<typeof Client>
): Client {
	return new Client(...args);
}
