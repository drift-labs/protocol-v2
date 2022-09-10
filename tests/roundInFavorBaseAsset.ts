import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, OracleSource, Wallet } from '../sdk';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import { Admin, ClearingHouse, PositionDirection } from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { FeeStructure } from '../sdk';

describe('round in favor', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let usdcMint;

	let primaryClearingHouse: Admin;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetReserve = new anchor.BN(17 * 10 ** 13);
	const ammInitialBaseAssetReserve = new anchor.BN(17 * 10 ** 13);

	const usdcAmount = new BN(9999 * 10 ** 3);

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		const solUsd = await mockOracle(63000);

		marketIndexes = [new BN(0)];
		spotMarketIndexes = [new BN(0)];
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
		await primaryClearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000)
		);

		const newFeeStructure: FeeStructure = {
			feeNumerator: new BN(0),
			feeDenominator: new BN(1),
			discountTokenTiers: {
				firstTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				secondTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				thirdTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				fourthTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
			},
			referralDiscount: {
				referrerRewardNumerator: new BN(1),
				referrerRewardDenominator: new BN(1),
				refereeDiscountNumerator: new BN(1),
				refereeDiscountDenominator: new BN(1),
			},
		};

		await primaryClearingHouse.updateFee(newFeeStructure);
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

		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(7896402480);
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
				.perpPositions[0].quoteAssetAmount.eq(new BN(-1))
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

		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(7895668982);
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
				.perpPositions[0].quoteAssetAmount.eq(new BN(-1))
		);
		await clearingHouse.unsubscribe();
	});
});
