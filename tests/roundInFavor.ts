import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	ClearingHouse,
	MAX_LEVERAGE,
	PositionDirection,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

const calculateTradeAmount = (amountOfCollateral: BN) => {
	const ONE_MANTISSA = new BN(100000);
	const fee = ONE_MANTISSA.div(new BN(1000));
	const tradeAmount = amountOfCollateral
		.mul(MAX_LEVERAGE)
		.mul(ONE_MANTISSA.sub(MAX_LEVERAGE.mul(fee)))
		.div(ONE_MANTISSA);
	return tradeAmount;
};

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

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		primaryClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0)],
		});
		await primaryClearingHouse.initialize(usdcMint.publicKey, true);
		await primaryClearingHouse.subscribe();

		await initializeQuoteSpotMarket(primaryClearingHouse, usdcMint.publicKey);
		await primaryClearingHouse.updatePerpAuctionDuration(new BN(0));

		const solUsd = await mockOracle(63000);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000)
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
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [
				new BN(0),
				new BN(1),
				new BN(2),
				new BN(3),
				new BN(4),
			],
			spotMarketIndexes: [new BN(0)],
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			calculateTradeAmount(usdcAmount),
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await clearingHouse.closePosition(marketIndex);

		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-504))
		);

		await clearingHouse.fetchAccounts();
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
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [
				new BN(0),
				new BN(1),
				new BN(2),
				new BN(3),
				new BN(4),
			],
			spotMarketIndexes: [new BN(0)],
		});
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			calculateTradeAmount(usdcAmount),
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-505))
		);
		await clearingHouse.unsubscribe();
	});
});
