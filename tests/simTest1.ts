import { startAnchor } from 'solana-bankrun';
import { BankrunProvider } from 'anchor-bankrun';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { Drift, IDL as DriftIDL } from '../target/types/drift';

import { DriftClient, DRIFT_PROGRAM_ID } from '../sdk/src';
import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import {
	TestClient,
	BN,
	EventSubscriber,
	SPOT_MARKET_RATE_PRECISION,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	OracleInfo,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';
import {
	QUOTE_PRECISION,
	BulkAccountLoader,
	getUserAccountPublicKey,
} from '../sdk';
import { calculateInitUserFee } from '../sdk/lib/math/state';

describe('surge pricing', () => {
	let solOracle: PublicKey;
	let admin: TestClient;
	let usdcMint;

	const usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		const context = await startAnchor('', [], []);

		const provider = new BankrunProvider(context);
		const connection = provider.connection;

		const chProgram = new Program<Drift>(DriftIDL, DRIFT_PROGRAM_ID, provider);

		const eventSubscriber = new EventSubscriber(connection, chProgram, {
			commitment: 'recent',
		});
		eventSubscriber.subscribe();

		const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

		usdcMint = await mockUSDCMint(provider);
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, provider);

		solOracle = await mockOracle(30);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		admin = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await admin.initialize(usdcMint.publicKey, true);
		await admin.subscribe();
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize USDC Market', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(50)).toNumber(); // 5000% APR
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		await admin.initializeSpotMarket(
			usdcMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			PublicKey.default,
			OracleSource.QUOTE_ASSET,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);
		const txSig = await admin.updateWithdrawGuardThreshold(
			0,
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		await printTxLogs(connection, txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(0);
		assert(spotMarket.marketIndex === 0);
		assert(spotMarket.optimalUtilization === optimalUtilization);
		assert(spotMarket.optimalBorrowRate === optimalRate);
		assert(spotMarket.maxBorrowRate === maxRate);
		assert(
			spotMarket.cumulativeBorrowInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(
			spotMarket.cumulativeDepositInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(spotMarket.initialAssetWeight === initialAssetWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);
		assert(spotMarket.initialLiabilityWeight === initialLiabilityWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);

		assert(admin.getStateAccount().numberOfSpotMarkets === 1);

		await admin.updateStateMaxNumberOfSubAccounts(5);
		await admin.updateStateMaxInitializeUserFee(1);
	});

	it('Create users', async () => {
		for (let i = 0; i < 5; i++) {
			const expectedFee = calculateInitUserFee(admin.getStateAccount());
			const [driftClient, _, keyPair] = await createUserWithUSDCAccount(
				provider,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

			const userAccount = await getUserAccountPublicKey(
				driftClient.program.programId,
				keyPair.publicKey,
				0
			);

			const accountInfo = await connection.getAccountInfo(userAccount);
			const baseLamports = 31347840;
			console.log('expected fee', expectedFee.toNumber());
			if (i === 4) {
				// assert(expectedFee.toNumber() === LAMPORTS_PER_SOL / 100);
			}
			console.log('account info', accountInfo.lamports);
			assert(accountInfo.lamports === baseLamports + expectedFee.toNumber());
			await sleep(1000);

			if (i === 4) {
				await admin.updateStateMaxNumberOfSubAccounts(0);
				await driftClient.reclaimRent(0);
				const accountInfoAfterReclaim = await connection.getAccountInfo(
					userAccount
				);
				console.log(
					'account info after reclaim',
					accountInfoAfterReclaim.lamports
				);
				assert(accountInfoAfterReclaim.lamports === baseLamports);
			}
			await driftClient.unsubscribe();
		}
	});
});
