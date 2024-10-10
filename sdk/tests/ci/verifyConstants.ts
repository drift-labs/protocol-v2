import {
	DriftClient,
	DevnetSpotMarkets,
	MainnetSpotMarkets,
	DevnetPerpMarkets,
	MainnetPerpMarkets,
	BulkAccountLoader,
	getVariant,
	isOneOfVariant,
} from '../../src';
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import dotenv from 'dotenv';
import { assert } from 'chai';

dotenv.config();

describe('Verify Constants', function () {
	this.timeout(100_000);
	const MAINNET_RPC_ENDPOINT = process.env.MAINNET_RPC_ENDPOINT;
	const DEVNET_RPC_ENDPOINT = process.env.DEVNET_RPC_ENDPOINT;

	// avoid breaking pre-commit
	if (MAINNET_RPC_ENDPOINT === undefined || DEVNET_RPC_ENDPOINT === undefined) {
		return;
	}

	const wallet = new Wallet(Keypair.generate());

	const devnetConnection = new Connection(DEVNET_RPC_ENDPOINT);
	const mainnetConnection = new Connection(MAINNET_RPC_ENDPOINT);

	const devnetBulkAccountLoader = new BulkAccountLoader(
		devnetConnection,
		'processed',
		1
	);

	const mainnetBulkAccountLoader = new BulkAccountLoader(
		mainnetConnection,
		'processed',
		1
	);

	const devnetDriftClient = new DriftClient({
		connection: devnetConnection,
		wallet,
		env: 'devnet',
		accountSubscription: {
			type: 'polling',
			accountLoader: devnetBulkAccountLoader,
		},
	});

	const mainnetDriftClient = new DriftClient({
		connection: mainnetConnection,
		wallet,
		env: 'mainnet-beta',
		accountSubscription: {
			type: 'polling',
			accountLoader: mainnetBulkAccountLoader,
		},
	});

	let lutAccounts: string[];

	before(async () => {
		await devnetDriftClient.subscribe();
		await mainnetDriftClient.subscribe();

		const lookupTable =
			await mainnetDriftClient.fetchMarketLookupTableAccount();
		lutAccounts = lookupTable.state.addresses.map((x) => x.toBase58());
	});

	after(async () => {
		await devnetDriftClient.unsubscribe();
		await mainnetDriftClient.unsubscribe();
	});

	it('has all mainnet markets', async () => {
		const spotMarkets = mainnetDriftClient.getSpotMarketAccounts();
		spotMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of spotMarkets) {
			const correspondingConfigMarket = MainnetSpotMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);
			assert(
				correspondingConfigMarket !== undefined,
				`Market ${
					market.marketIndex
				} not found in MainnetSpotMarkets. market: ${market.pubkey.toBase58()}`
			);
			assert(
				correspondingConfigMarket.oracle.toBase58() == market.oracle.toBase58(),
				`Oracle mismatch for mainnet spot market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.oracle.toBase58()}`
			);
			assert(
				getVariant(correspondingConfigMarket.oracleSource) ===
					getVariant(market.oracleSource),
				`Oracle source mismatch for mainnet spot market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
					correspondingConfigMarket.oracleSource
				)}, chain: ${getVariant(market.oracleSource)}`
			);
			assert(
				correspondingConfigMarket.mint.toBase58() === market.mint.toBase58(),
				`Mint mismatch for mainnet spot market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.mint.toBase58()}, chain: ${market.mint.toBase58()}`
			);

			const lutHasMarket = lutAccounts.includes(market.pubkey.toBase58());
			assert(
				lutHasMarket,
				`Mainnet LUT is missing spot market ${
					market.marketIndex
				} pubkey ${market.pubkey.toBase58()}`
			);

			const lutHasMarketOracle = lutAccounts.includes(market.oracle.toBase58());
			assert(
				lutHasMarketOracle,
				`Mainnet LUT is missing spot market ${
					market.marketIndex
				} oracle ${market.oracle.toBase58()}`
			);

			if (
				isOneOfVariant(market.oracleSource, [
					'pythPull',
					'pyth1KPull',
					'pyth1MPull',
					'pythStableCoinPull',
				])
			) {
				if (!correspondingConfigMarket.pythFeedId) {
					assert(false, `spot market ${market.marketIndex} missing feed id`);
				}
			}
		}

		const perpMarkets = mainnetDriftClient.getPerpMarketAccounts();
		perpMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of perpMarkets) {
			const correspondingConfigMarket = MainnetPerpMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);
			assert(
				correspondingConfigMarket !== undefined,
				`Market ${
					market.marketIndex
				} not found in MainnetPerpMarkets, market: ${market.pubkey.toBase58()}`
			);
			assert(
				correspondingConfigMarket.oracle.toBase58() ==
					market.amm.oracle.toBase58(),
				`Oracle mismatch for mainnet perp market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.amm.oracle.toBase58()}`
			);
			assert(
				getVariant(correspondingConfigMarket.oracleSource) ===
					getVariant(market.amm.oracleSource),
				`Oracle source mismatch for mainnet perp market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
					correspondingConfigMarket.oracleSource
				)}, chain: ${getVariant(market.amm.oracleSource)}`
			);

			const lutHasMarket = lutAccounts.includes(market.pubkey.toBase58());
			assert(
				lutHasMarket,
				`Mainnet LUT is missing perp market ${
					market.marketIndex
				} pubkey ${market.pubkey.toBase58()}`
			);

			const lutHasMarketOracle = lutAccounts.includes(
				market.amm.oracle.toBase58()
			);
			assert(
				lutHasMarketOracle,
				`Mainnet LUT is missing perp market ${
					market.marketIndex
				} oracle ${market.amm.oracle.toBase58()}`
			);

			if (
				isOneOfVariant(market.amm.oracleSource, [
					'pythPull',
					'pyth1KPull',
					'pyth1MPull',
					'pythStableCoinPull',
				])
			) {
				if (!correspondingConfigMarket.pythFeedId) {
					assert(false, `perp market ${market.marketIndex} missing feed id`);
				}
			}
		}
	});

	it('has all devnet markets', async () => {
		const spotMarkets = devnetDriftClient.getSpotMarketAccounts();
		spotMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of spotMarkets) {
			const correspondingConfigMarket = DevnetSpotMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);
			assert(
				correspondingConfigMarket !== undefined,
				`Market ${
					market.marketIndex
				} not found in DevnetSpotMarkets, market: ${market.pubkey.toBase58()}`
			);
			assert(
				correspondingConfigMarket.oracle.toBase58() == market.oracle.toBase58(),
				`Oracle mismatch for devnet spot market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.oracle.toBase58()}`
			);
			assert(
				getVariant(correspondingConfigMarket.oracleSource) ===
					getVariant(market.oracleSource),
				`Oracle source mismatch for devnet spot market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
					correspondingConfigMarket.oracleSource
				)}, chain: ${getVariant(market.oracleSource)}`
			);
			assert(
				correspondingConfigMarket.mint.toBase58() === market.mint.toBase58(),
				`Mint mismatch for devnet spot market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.mint.toBase58()}, chain: ${market.mint.toBase58()}`
			);
		}

		const perpMarkets = devnetDriftClient.getPerpMarketAccounts();
		perpMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of perpMarkets) {
			const correspondingConfigMarket = DevnetPerpMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);
			assert(
				correspondingConfigMarket !== undefined,
				`Market ${
					market.marketIndex
				} not found in DevnetPerpMarkets, market: ${market.pubkey.toBase58()}`
			);
			assert(
				correspondingConfigMarket.oracle.toBase58() ==
					market.amm.oracle.toBase58(),
				`Oracle mismatch for devnet perp market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.amm.oracle.toBase58()}`
			);
			assert(
				getVariant(correspondingConfigMarket.oracleSource) ===
					getVariant(market.amm.oracleSource),
				`Oracle source mismatch for devnet perp market ${
					market.marketIndex
				}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
					correspondingConfigMarket.oracleSource
				)}, chain: ${getVariant(market.amm.oracleSource)}`
			);
		}
	});
});
