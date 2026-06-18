import { PriceServiceConnection } from '@pythnetwork/price-service-client';

export const constants = {
	devnet: {
		USDCMint: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
	},
	'mainnet-beta': {
		USDCMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	},
};

export interface Bot {
	readonly name: string;
	readonly dryRun: boolean;
	readonly defaultIntervalMs?: number;
	readonly pythConnection?: PriceServiceConnection;

	/**
	 * Initialize the bot
	 */
	init: () => Promise<void>;

	/**
	 * Reset the bot. This is called to reset the bot to a fresh state (pre-init).
	 */
	reset: () => Promise<void>;

	/**
	 * Start the bot loop. This is generally a polling loop.
	 */
	startIntervalLoop: (intervalMs?: number) => Promise<void>;

	/**
	 * Returns true if bot is healthy, else false. Typically used for monitoring liveness.
	 */
	healthCheck: () => Promise<boolean>;
}
