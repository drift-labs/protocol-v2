import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	TestClient,
	QUOTE_PRECISION,
	BN,
	OracleSource,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';
import {
	BulkAccountLoader,
	getInsuranceFundVaultPublicKey,
	getSpotMarketPublicKey,
	getSpotMarketVaultPublicKey,
} from '../sdk';
import { PublicKey } from '@solana/web3.js';

describe('max deposit', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

		const solUsd = await mockOracle(1);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.toNumber();
		const maxRate = SPOT_MARKET_RATE_PRECISION.toNumber();
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const imfFactor = 0;

		await driftClient.initializeSpotMarket(
			usdcMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			PublicKey.default,
			OracleSource.QUOTE_ASSET,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor,
			undefined,
			undefined,
			false
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('delete', async () => {
		const txSig = await driftClient.deleteInitializedSpotMarket(0);

		await printTxLogs(connection, txSig);

		const spotMarketKey = await getSpotMarketPublicKey(
			driftClient.program.programId,
			0
		);

		let result = await connection.getAccountInfoAndContext(
			spotMarketKey,
			'processed'
		);
		assert(result.value === null);

		const spotMarketVaultKey = await getSpotMarketVaultPublicKey(
			driftClient.program.programId,
			0
		);

		result = await connection.getAccountInfoAndContext(
			spotMarketVaultKey,
			'processed'
		);
		assert(result.value === null);

		const ifVaultKey = await getInsuranceFundVaultPublicKey(
			driftClient.program.programId,
			0
		);

		result = await connection.getAccountInfoAndContext(ifVaultKey, 'processed');
		assert(result.value === null);
	});

	it('re initialize', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.toNumber();
		const maxRate = SPOT_MARKET_RATE_PRECISION.toNumber();
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const imfFactor = 0;

		try {
			await driftClient.initializeSpotMarket(
				usdcMint.publicKey,
				optimalUtilization,
				optimalRate,
				maxRate,
				PublicKey.default,
				OracleSource.QUOTE_ASSET,
				initialAssetWeight,
				maintenanceAssetWeight,
				initialLiabilityWeight,
				maintenanceLiabilityWeight,
				imfFactor,
				undefined,
				undefined,
				false
			);
		} catch (e) {
			console.error(e);
		}
	});
});
