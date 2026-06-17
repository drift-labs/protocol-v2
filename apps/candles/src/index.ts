import { DEFAULT_ENDPOINT, logger } from '@backend/common';
import { Connection, Keypair } from '@solana/web3.js';
import {
	DelistedMarketSetting,
	VelocityClient,
	VelocityEnv,
	initialize,
	Wallet,
} from '@velocity-exchange/sdk';
import { CandleProcessor } from './services/candle-processor';
import { CandleSync } from './services/candle-sync';
import { createHealthServer } from './services/health';

const FIVE_MINUTE = 5 * 60 * 1000;
const IS_GRPC = process.env.IS_GRPC === 'true';

const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'confirmed');
const driftEnv = (process.env.ENV ?? 'mainnet-beta') as VelocityEnv;
const { SPOT_MARKETS, PERP_MARKETS } = initialize({ env: driftEnv });

const driftClient = new VelocityClient({
	env: driftEnv,
	connection,
	wallet: new Wallet(new Keypair()),
	delistedMarketSetting: DelistedMarketSetting.Discard,
});

export const main = async () => {
	await driftClient.subscribe();

	const perpMarkets = driftClient.getPerpMarketAccounts().map((mkt) => mkt.marketIndex);
	const spotMarkets = driftClient.getSpotMarketAccounts().map((mkt) => mkt.marketIndex);

	const symbols = [
		...new Set([
			...PERP_MARKETS.filter((mkt) => perpMarkets.includes(mkt.marketIndex)).map(
				(market) => market.symbol
			),
			...SPOT_MARKETS.filter((mkt) => spotMarkets.includes(mkt.marketIndex)).map(
				(market) => market.symbol
			),
		]),
	];

	const { start } = CandleProcessor({
		symbols,
		isRunning: true,
		isGrpc: IS_GRPC,
	});

	if (IS_GRPC) {
		const { sync } = CandleSync({ symbols });
		setInterval(async () => {
			return sync();
		}, FIVE_MINUTE);
	}

	createHealthServer();

	await start();
};

if (process.env.NODE_ENV !== 'test') {
	main().catch(async (error) => {
		const { message } = error;
		await logger.error(`Unhandled error in main: ${message}`);
		throw error;
	});
}
