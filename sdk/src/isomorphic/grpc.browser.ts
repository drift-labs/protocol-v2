import { Client } from './grpc';

// Export a function to create a new Client instance
export function createClient(
	..._args: ConstructorParameters<typeof Client>
): Client {
	throw new Error('Only available in node context');
}
