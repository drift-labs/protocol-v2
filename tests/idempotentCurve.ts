import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BASE_PRECISION, BN } from '../sdk';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { FeeStructure } from '../sdk/src';

describe('idempotent curve', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let usdcMint;
	let primaryClearingHouse: Admin;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

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
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});
		await primaryClearingHouse.initialize(usdcMint.publicKey, true);
		await primaryClearingHouse.subscribe();

		await initializeQuoteAssetBank(primaryClearingHouse, usdcMint.publicKey);
		await primaryClearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		const newFeeStructure: FeeStructure = {
			feeNumerator: new BN(0),
			feeDenominator: new BN(1),
			makerRebateNumerator: new BN(0),
			makerRebateDenominator: new BN(1),
			fillerRewardStructure: {
				rewardNumerator: new BN(0),
				rewardDenominator: new BN(1),
				timeBasedRewardLowerBound: new BN(1),
			},
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

	beforeEach(async () => {
		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0)
		);
	});

	after(async () => {
		await primaryClearingHouse.unsubscribe();
	});

	const shrinkProfitableLong = async (chunks: number) => {
		const userKeypair = new Keypair();
		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(4));
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(2)),
			new BN(0)
		);

		const numberOfReduces = chunks;
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				baseAssetAmount.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		assert(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteAssetAmount.eq(new BN(3999903))
		);
		assert(
			clearingHouse.getUserAccount().positions[0].quoteEntryAmount.eq(new BN(0))
		);
		await clearingHouse.unsubscribe();
	};

	const shrinkUnprofitableLong = async (
		chunks: number,
		expectedQuoteTokenAmount: BN
	) => {
		const userKeypair = new Keypair();
		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(4));
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(2)),
			ammInitialQuoteAssetReserve,
			new BN(0)
		);

		const numberOfReduces = chunks;
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				baseAssetAmount.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		await clearingHouse.fetchAccounts();

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();

		assert(
			clearingHouse.getQuoteAssetTokenAmount().eq(expectedQuoteTokenAmount)
		);
		assert(
			clearingHouse.getUserAccount().positions[0].quoteEntryAmount.eq(new BN(0))
		);
		await clearingHouse.unsubscribe();
	};

	const shrinkProfitableShort = async (chunks: number) => {
		const userKeypair = new Keypair();
		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		await clearingHouse.fetchAccounts();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(4));
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(2)),
			ammInitialQuoteAssetReserve,
			new BN(0)
		);

		const numberOfReduces = chunks;
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				baseAssetAmount.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(11999958)));
		assert(
			clearingHouse.getUserAccount().positions[0].quoteEntryAmount.eq(new BN(0))
		);
		await clearingHouse.unsubscribe();
	};

	const shrinkUnrofitableShort = async (
		chunks: number,
		expectedQuoteTokenAmount: BN
	) => {
		const userKeypair = new Keypair();
		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(4));
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(3)),
			ammInitialQuoteAssetReserve.mul(new BN(4)),
			new BN(0)
		);

		const numberOfReduces = chunks;
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				baseAssetAmount.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		assert(
			clearingHouse.getQuoteAssetTokenAmount().eq(expectedQuoteTokenAmount)
		);
		assert(
			clearingHouse.getUserAccount().positions[0].quoteEntryAmount.eq(new BN(0))
		);
		await clearingHouse.unsubscribe();
	};

	it('open and shrink profitable long twice', async () => {
		await shrinkProfitableLong(2);
	});

	it('open and shrink profitable long fource', async () => {
		await shrinkProfitableLong(4);
	});

	it('open and shrink unprofitable long twice', async () => {
		await shrinkUnprofitableLong(2, new BN(7999959));
	});

	it('open and shrink unprofitable long fource', async () => {
		await shrinkUnprofitableLong(4, new BN(7999957));
	});

	it('open and shrink profitable short twice', async () => {
		await shrinkProfitableShort(2);
	});

	it('open and shrink profitable short fource', async () => {
		await shrinkProfitableShort(4);
	});

	it('open and shrink unprofitable short twice', async () => {
		await shrinkUnrofitableShort(2, new BN(8666619));
	});

	it('open and shrink unprofitable short fource', async () => {
		await shrinkUnrofitableShort(4, new BN(8666618));
	});
});
