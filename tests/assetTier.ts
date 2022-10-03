import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	Admin,
	BN,
	ClearingHouse,
	EventSubscriber,
	ZERO,
	ONE,
	// SPOT_MARKET_RATE_PRECISION,
	// SpotBalanceType,
	isVariant,
	OracleSource,
	// SPOT_MARKET_WEIGHT_PRECISION,
	// SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	// OracleInfo,
	AMM_RESERVE_PRECISION,
	MarketStatus,
	PEG_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	AssetTier,
	SPOT_MARKET_WEIGHT_PRECISION,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	// setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	printTxLogs,
	createUSDCAccountForUser,
	// getFeedData,
	// sleep,
} from './testHelpers';

describe('asset tiers', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let dogeMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;
	let dogeOracle: PublicKey;
	const usdcAmount = new BN(1000000 * 10 ** 6); //1M

	let secondUserClearingHouse: ClearingHouse;
	let secondUserClearingHouseWSOLAccount: PublicKey;
	let secondUserClearingHouseUSDCAccount: PublicKey;
	let secondUserClearingHouseDogeAccount: PublicKey;
	let secondUserKeyPair: Keypair;

	const solAmount = new BN(10000 * 10 ** 9);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		dogeMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			provider
		);

		solOracle = await mockOracle(22500); // a future we all need to believe in
		dogeOracle = await mockOracle(0.05);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(clearingHouse, solOracle);
		await initializeSolSpotMarket(
			clearingHouse,
			dogeOracle,
			dogeMint.publicKey
		);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await clearingHouse.initializeMarket(
			solOracle,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION,
			periodicity,
			new BN(22500 * PEG_PRECISION.toNumber()),
			undefined,
			1000
		);
		await clearingHouse.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
		await clearingHouse.updateMarketBaseSpread(0, 2000);
		await clearingHouse.updateCurveUpdateIntensity(0, 100);

		const userId = 0;
		const name = 'BIGZ';
		await clearingHouse.initializeUserAccount(userId, name);
		await clearingHouse.deposit(
			// $10k
			QUOTE_PRECISION.mul(new BN(10000)),
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		[
			secondUserClearingHouse,
			secondUserClearingHouseWSOLAccount,
			secondUserClearingHouseUSDCAccount,
			secondUserKeyPair,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			chProgram,
			solAmount,
			ZERO,
			[0],
			[0, 1, 2],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
				{
					publicKey: dogeOracle,
					source: OracleSource.PYTH,
				},
			]
		);

		secondUserClearingHouseDogeAccount = await createUSDCAccountForUser(
			provider,
			secondUserKeyPair,
			dogeMint,
			usdcAmount
		);

		secondUserClearingHouse.subscribe();

		const marketIndex = 1;
		const txSig = await secondUserClearingHouse.deposit(
			solAmount,
			marketIndex,
			secondUserClearingHouseWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const txSig2 = await secondUserClearingHouse.deposit(
			usdcAmount,
			2,
			secondUserClearingHouseDogeAccount
		);
		await printTxLogs(connection, txSig2);
	});

	after(async () => {
		await eventSubscriber.unsubscribe();
		await clearingHouse.unsubscribe();
		await secondUserClearingHouse.unsubscribe();
	});

	it('fail trying to borrow protected asset', async () => {
		const usdcBorrowAmount = QUOTE_PRECISION;

		const quoteMarket = clearingHouse.getSpotMarketAccount(0);
		assert(isVariant(quoteMarket.assetTier, 'collateral'));

		await clearingHouse.updateSpotMarketAssetTier(0, AssetTier.PROTECTED);
		await clearingHouse.fetchAccounts();

		const quoteMarketAfter = clearingHouse.getSpotMarketAccount(0);
		assert(isVariant(quoteMarketAfter.assetTier, 'protected'));
		console.log('updateSpotMarketAssetTier for USDC to PROTECTED');

		try {
			const txSig = await secondUserClearingHouse.withdraw(
				usdcBorrowAmount,
				0,
				secondUserClearingHouseUSDCAccount,
				false
			);
			await printTxLogs(connection, txSig);

			// assert(false);
		} catch (err) {
			console.error(err);
			// assert(err.message.includes('0x17e2'));
		}

		console.log('updateSpotMarketAssetTier for USDC back to COLLATERAL');
		await clearingHouse.updateSpotMarketAssetTier(0, AssetTier.COLLATERAL);

		await secondUserClearingHouse.fetchAccounts();

		const quoteMarketAfterAgain =
			secondUserClearingHouse.getSpotMarketAccount(0);
		assert(isVariant(quoteMarketAfterAgain.assetTier, 'collateral'));
		console.log('USDC tier:', quoteMarketAfterAgain.assetTier);

		// make doge isolated asset
		try {
			await clearingHouse.updateSpotMarketMarginWeights(
				2,
				ZERO,
				ONE,
				SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(2)),
				SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(10)).div(new BN(9))
			);

			await clearingHouse.updateSpotMarketAssetTier(2, AssetTier.ISOLATED);
		} catch (e) {
			console.error(e);
		}
		await clearingHouse.fetchAccounts();
		await secondUserClearingHouse.fetchAccounts();
		console.log('updateSpotMarketAssetTier for DOGE to isolated');
		const dogeMarketAfter = secondUserClearingHouse.getSpotMarketAccount(2);
		assert(isVariant(dogeMarketAfter.assetTier, 'isolated'));
		console.log('DOGE asset tier:', dogeMarketAfter.assetTier);

		const txSig = await secondUserClearingHouse.withdraw(
			new BN(1),
			2,
			secondUserClearingHouseDogeAccount,
			false
		);
		await printTxLogs(connection, txSig);

		await secondUserClearingHouse.fetchAccounts();

		try {
			const txSig = await secondUserClearingHouse.withdraw(
				usdcBorrowAmount,
				0,
				secondUserClearingHouseUSDCAccount,
				false
			);
			await printTxLogs(connection, txSig);

			console.log('usdc borrow succeed (should have fail!)');
			assert(false);
		} catch (err) {
			console.log('failed!');
			// assert(err.message.includes('Transaction simulation failed:'));
		}

		// make doge CROSS
		await clearingHouse.updateSpotMarketAssetTier(2, AssetTier.CROSS);
		const dogeMarketAfterAgain = clearingHouse.getSpotMarketAccount(2);
		assert(isVariant(dogeMarketAfterAgain.assetTier, 'cross'));

		await secondUserClearingHouse.fetchAccounts();
		const scQuoteMarketAfterAgain =
			secondUserClearingHouse.getSpotMarketAccount(0);
		assert(isVariant(scQuoteMarketAfterAgain.assetTier, 'collateral'));
		console.log('USDC asset tier:', scQuoteMarketAfterAgain.assetTier);

		try {
			const txSig2 = await secondUserClearingHouse.withdraw(
				QUOTE_PRECISION,
				0,
				secondUserClearingHouseUSDCAccount,
				false
			);
			await printTxLogs(connection, txSig2);
		} catch (e) {
			console.error(e);
			assert(false);
		}
	});
});
