import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	TestClient,
	BN,
	OracleSource,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {
	getInsuranceFundVaultPublicKey,
	getSpotMarketPublicKey,
	getSpotMarketVaultPublicKey,
} from '../sdk';
import { PublicKey } from '@solana/web3.js';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('max deposit', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let _userUSDCAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		_userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
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

		bankrunContextWrapper.connection.printTxLogs(txSig);

		const spotMarketKey = await getSpotMarketPublicKey(
			driftClient.program.programId,
			0
		);

		let result =
			await bankrunContextWrapper.connection.getAccountInfoAndContext(
				spotMarketKey,
				'processed'
			);
		assert(result.value === null);

		const spotMarketVaultKey = await getSpotMarketVaultPublicKey(
			driftClient.program.programId,
			0
		);

		result = await bankrunContextWrapper.connection.getAccountInfoAndContext(
			spotMarketVaultKey,
			'processed'
		);
		assert(result.value === null);

		const ifVaultKey = await getInsuranceFundVaultPublicKey(
			driftClient.program.programId,
			0
		);

		result = await bankrunContextWrapper.connection.getAccountInfoAndContext(
			ifVaultKey,
			'processed'
		);
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
