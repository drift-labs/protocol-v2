import type Client from '@triton-one/yellowstone-grpc';
import type {
	SubscribeRequest,
	SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import type { ClientDuplexStream, ChannelOptions } from '@grpc/grpc-js';

// Re-export types for helius-laserstream (these are type-only imports so they don't cause runtime errors)
export type {
	LaserstreamConfig,
	SubscribeRequest as LaserSubscribeRequest,
	SubscribeUpdate as LaserSubscribeUpdate,
} from 'helius-laserstream';

// Lazy-loaded module reference for helius-laserstream
let laserStreamModule: typeof import('helius-laserstream') | null = null;
let laserStreamLoadError: Error | null = null;

// Try to load helius-laserstream (it's an optional dependency that may not be available on all platforms)
async function loadLaserStream(): Promise<typeof import('helius-laserstream')> {
	if (laserStreamModule) {
		return laserStreamModule;
	}
	if (laserStreamLoadError) {
		throw laserStreamLoadError;
	}
	try {
		laserStreamModule = await import('helius-laserstream');
		return laserStreamModule;
	} catch (err) {
		laserStreamLoadError = new Error(
			`helius-laserstream is not available on this platform. ` +
				`LaserStream functionality requires Linux or macOS. ` +
				`Original error: ${err instanceof Error ? err.message : String(err)}`
		);
		throw laserStreamLoadError;
	}
}

// Lazy getters for LaserStream exports - these throw helpful errors if the module isn't available
export const LaserCommitmentLevel = new Proxy(
	{} as typeof import('helius-laserstream').CommitmentLevel,
	{
		get(_target, prop) {
			// Return placeholder values for type checking - actual usage should go through getLaserCommitmentLevel()
			const values: Record<string, number> = {
				PROCESSED: 0,
				CONFIRMED: 1,
				FINALIZED: 2,
			};
			return values[prop as string];
		},
	}
);

export const CompressionAlgorithms = new Proxy(
	{} as typeof import('helius-laserstream').CompressionAlgorithms,
	{
		get(_target, prop) {
			const values: Record<string, number> = {
				none: 0,
				gzip: 1,
				zstd: 2,
			};
			return values[prop as string];
		},
	}
);

// Async function to get the actual LaserSubscribe function
export async function getLaserSubscribe(): Promise<
	typeof import('helius-laserstream').subscribe
> {
	const module = await loadLaserStream();
	return module.subscribe;
}

// Async function to get actual LaserCommitmentLevel
export async function getLaserCommitmentLevel(): Promise<
	typeof import('helius-laserstream').CommitmentLevel
> {
	const module = await loadLaserStream();
	return module.CommitmentLevel;
}

// Async function to get actual CompressionAlgorithms
export async function getLaserCompressionAlgorithms(): Promise<
	typeof import('helius-laserstream').CompressionAlgorithms
> {
	const module = await loadLaserStream();
	return module.CompressionAlgorithms;
}

// Synchronous wrapper that throws if module isn't loaded - for backwards compatibility
export function LaserSubscribe(
	..._args: Parameters<typeof import('helius-laserstream').subscribe>
): ReturnType<typeof import('helius-laserstream').subscribe> {
	throw new Error(
		'LaserSubscribe must be accessed via getLaserSubscribe(). ' +
			'helius-laserstream is an optional dependency that may not be available on all platforms (e.g., Windows).'
	);
}

export { CommitmentLevel, Client };
export type {
	ClientDuplexStream,
	ChannelOptions,
	SubscribeRequest,
	SubscribeUpdate,
};

// Export a function to create a new Client instance
export async function createClient(
	...args: ConstructorParameters<typeof Client>
): Promise<Client> {
	const { default: Client_ } = await import('@triton-one/yellowstone-grpc');
	return new Client_(...args);
}
