import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	getMarketOrderParams,
	OracleSource,
	Wallet,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import { Admin, ClearingHouse, PositionDirection } from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('round in favor', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let usdcMint;

	let primaryClearingHouse: Admin;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);
	const ammInitialBaseAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);

	const usdcAmount = new BN(9999 * 10 ** 3);

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		const solUsd = await mockOracle(63000);

		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		primaryClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await primaryClearingHouse.initialize(usdcMint.publicKey, true);
		await primaryClearingHouse.subscribe();

		await initializeQuoteSpotMarket(primaryClearingHouse, usdcMint.publicKey);
		await primaryClearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000000)
		);
	});

	after(async () => {
		await primaryClearingHouse.unsubscribe();
	});

	it('short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		await clearingHouse.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = new BN(789640);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(orderParams);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await clearingHouse.fetchAccounts();
		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();

		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-99409))
		);
		await clearingHouse.unsubscribe();
	});

	it('long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		await clearingHouse.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = new BN(789566);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(orderParams);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await clearingHouse.closePosition(marketIndex);
		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-99419))
		);
		await clearingHouse.unsubscribe();
	});
});
