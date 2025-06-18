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

		const lookupTables = await mainnetDriftClient.fetchAllLookupTableAccounts();
		lutAccounts = lookupTables
			.map((lut) => lut.state.addresses.map((x) => x.toBase58()))
			.flat();
	});

	after(async () => {
		await devnetDriftClient.unsubscribe();
		await mainnetDriftClient.unsubscribe();
	});

	it('has all mainnet markets', async () => {
		const errors: string[] = [];
		const missingLutAddresses: {
			type: string;
			marketIndex: number;
			address: string;
			description: string;
		}[] = [];

		const spotMarkets = mainnetDriftClient.getSpotMarketAccounts();
		spotMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of spotMarkets) {
			const correspondingConfigMarket = MainnetSpotMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);

			if (correspondingConfigMarket === undefined) {
				errors.push(
					`Market ${
						market.marketIndex
					} not found in MainnetSpotMarkets. market: ${market.pubkey.toBase58()}`
				);
				continue;
			}

			if (
				correspondingConfigMarket.oracle.toBase58() !== market.oracle.toBase58()
			) {
				errors.push(
					`Oracle mismatch for mainnet spot market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.oracle.toBase58()}`
				);
			}

			if (
				getVariant(correspondingConfigMarket.oracleSource) !==
				getVariant(market.oracleSource)
			) {
				errors.push(
					`Oracle source mismatch for mainnet spot market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
						correspondingConfigMarket.oracleSource
					)}, chain: ${getVariant(market.oracleSource)}`
				);
			}

			if (
				correspondingConfigMarket.mint.toBase58() !== market.mint.toBase58()
			) {
				errors.push(
					`Mint mismatch for mainnet spot market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.mint.toBase58()}, chain: ${market.mint.toBase58()}`
				);
			}

			const lutHasMarket = lutAccounts.includes(market.pubkey.toBase58());
			if (!lutHasMarket) {
				missingLutAddresses.push({
					type: 'spot',
					marketIndex: market.marketIndex,
					address: market.pubkey.toBase58(),
					description: 'market',
				});
			}

			const lutHasMarketOracle = lutAccounts.includes(market.oracle.toBase58());
			if (!lutHasMarketOracle) {
				missingLutAddresses.push({
					type: 'spot',
					marketIndex: market.marketIndex,
					address: market.oracle.toBase58(),
					description: 'oracle',
				});
			}

			if (
				isOneOfVariant(market.oracleSource, [
					'pythPull',
					'pyth1KPull',
					'pyth1MPull',
					'pythStableCoinPull',
				])
			) {
				if (!correspondingConfigMarket.pythFeedId) {
					errors.push(`spot market ${market.marketIndex} missing feed id`);
				}
			}
		}

		const perpMarkets = mainnetDriftClient.getPerpMarketAccounts();
		perpMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of perpMarkets) {
			const correspondingConfigMarket = MainnetPerpMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);

			if (correspondingConfigMarket === undefined) {
				errors.push(
					`Market ${
						market.marketIndex
					} not found in MainnetPerpMarkets, market: ${market.pubkey.toBase58()}`
				);
				continue;
			}

			if (
				correspondingConfigMarket.oracle.toBase58() !==
				market.amm.oracle.toBase58()
			) {
				errors.push(
					`Oracle mismatch for mainnet perp market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.amm.oracle.toBase58()}`
				);
			}

			if (
				getVariant(correspondingConfigMarket.oracleSource) !==
				getVariant(market.amm.oracleSource)
			) {
				errors.push(
					`Oracle source mismatch for mainnet perp market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
						correspondingConfigMarket.oracleSource
					)}, chain: ${getVariant(market.amm.oracleSource)}`
				);
			}

			const lutHasMarket = lutAccounts.includes(market.pubkey.toBase58());
			if (!lutHasMarket) {
				missingLutAddresses.push({
					type: 'perp',
					marketIndex: market.marketIndex,
					address: market.pubkey.toBase58(),
					description: 'market',
				});
			}

			const lutHasMarketOracle = lutAccounts.includes(
				market.amm.oracle.toBase58()
			);
			if (!lutHasMarketOracle) {
				missingLutAddresses.push({
					type: 'perp',
					marketIndex: market.marketIndex,
					address: market.amm.oracle.toBase58(),
					description: 'oracle',
				});
			}

			if (
				isOneOfVariant(market.amm.oracleSource, [
					'pythPull',
					'pyth1KPull',
					'pyth1MPull',
					'pythStableCoinPull',
				])
			) {
				if (!correspondingConfigMarket.pythFeedId) {
					errors.push(`perp market ${market.marketIndex} missing feed id`);
				}
			}
		}

		// Print all missing LUT addresses
		if (missingLutAddresses.length > 0) {
			console.log('\n=== MISSING LUT ADDRESSES ===');
			missingLutAddresses.forEach(
				({ type, marketIndex, address, description }) => {
					console.log(
						`${type.toUpperCase()} Market ${marketIndex} ${description}: ${address}`
					);
				}
			);
			console.log(
				`\nTotal missing LUT addresses: ${missingLutAddresses.length}`
			);
		}

		// Print all errors
		if (errors.length > 0) {
			console.log('\n=== VALIDATION ERRORS ===');
			errors.forEach((error, index) => {
				console.log(`${index + 1}. ${error}`);
			});
			console.log(`\nTotal errors: ${errors.length}`);
		}

		// Fail if there are any issues
		const totalIssues = errors.length + missingLutAddresses.length;
		if (totalIssues > 0) {
			assert(
				false,
				`Found ${totalIssues} issues (${errors.length} validation errors, ${missingLutAddresses.length} missing LUT addresses). See details above.`
			);
		}
	});

	it('has all devnet markets', async () => {
		const errors: string[] = [];

		const spotMarkets = devnetDriftClient.getSpotMarketAccounts();
		spotMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of spotMarkets) {
			const correspondingConfigMarket = DevnetSpotMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);

			if (correspondingConfigMarket === undefined) {
				errors.push(
					`Market ${
						market.marketIndex
					} not found in DevnetSpotMarkets, market: ${market.pubkey.toBase58()}`
				);
				continue;
			}

			if (
				correspondingConfigMarket.oracle.toBase58() !== market.oracle.toBase58()
			) {
				errors.push(
					`Oracle mismatch for devnet spot market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.oracle.toBase58()}`
				);
			}

			if (
				getVariant(correspondingConfigMarket.oracleSource) !==
				getVariant(market.oracleSource)
			) {
				errors.push(
					`Oracle source mismatch for devnet spot market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
						correspondingConfigMarket.oracleSource
					)}, chain: ${getVariant(market.oracleSource)}`
				);
			}

			if (
				correspondingConfigMarket.mint.toBase58() !== market.mint.toBase58()
			) {
				errors.push(
					`Mint mismatch for devnet spot market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.mint.toBase58()}, chain: ${market.mint.toBase58()}`
				);
			}
		}

		const perpMarkets = devnetDriftClient.getPerpMarketAccounts();
		perpMarkets.sort((a, b) => a.marketIndex - b.marketIndex);

		for (const market of perpMarkets) {
			const correspondingConfigMarket = DevnetPerpMarkets.find(
				(configMarket) => configMarket.marketIndex === market.marketIndex
			);

			if (correspondingConfigMarket === undefined) {
				errors.push(
					`Market ${
						market.marketIndex
					} not found in DevnetPerpMarkets, market: ${market.pubkey.toBase58()}`
				);
				continue;
			}

			if (
				correspondingConfigMarket.oracle.toBase58() !==
				market.amm.oracle.toBase58()
			) {
				errors.push(
					`Oracle mismatch for devnet perp market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${correspondingConfigMarket.oracle.toBase58()}, chain: ${market.amm.oracle.toBase58()}`
				);
			}

			if (
				getVariant(correspondingConfigMarket.oracleSource) !==
				getVariant(market.amm.oracleSource)
			) {
				errors.push(
					`Oracle source mismatch for devnet perp market ${
						market.marketIndex
					}, market: ${market.pubkey.toBase58()}, constants: ${getVariant(
						correspondingConfigMarket.oracleSource
					)}, chain: ${getVariant(market.amm.oracleSource)}`
				);
			}
		}

		// Print all errors
		if (errors.length > 0) {
			console.log('\n=== DEVNET VALIDATION ERRORS ===');
			errors.forEach((error, index) => {
				console.log(`${index + 1}. ${error}`);
			});
			console.log(`\nTotal devnet errors: ${errors.length}`);
		}

		// Fail if there are any issues
		if (errors.length > 0) {
			assert(
				false,
				`Found ${errors.length} devnet validation errors. See details above.`
			);
		}
	});
});
