import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	calculateBaseAssetValue,
	ClearingHouse,
	PositionDirection,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { FeeStructure } from '../sdk';

describe('idempotent curve', () => {
	const provider = anchor.Provider.local(undefined, {
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

		primaryClearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await primaryClearingHouse.initialize(usdcMint.publicKey, true);
		await primaryClearingHouse.subscribe();

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryClearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
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
		const clearingHouse = ClearingHouse.from(
			connection,
			new Wallet(userKeypair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(2)),
			new BN(0)
		);

		let user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		let userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		const numberOfReduces = chunks;
		const market = clearingHouse.getMarket(marketIndex);
		const baseAssetValue = calculateBaseAssetValue(
			market,
			userPositionsAccount.positions[0]
		);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(19999200)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		await clearingHouse.unsubscribe();
	};

	const shrinkUnprofitableLong = async (chunks: number) => {
		const userKeypair = new Keypair();
		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			new Wallet(userKeypair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(2)),
			ammInitialQuoteAssetReserve,
			new BN(0)
		);

		let user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		let userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		const numberOfReduces = chunks;
		const market = clearingHouse.getMarket(marketIndex);
		const baseAssetValue = calculateBaseAssetValue(
			market,
			userPositionsAccount.positions[0]
		);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(4999850)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
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
		const clearingHouse = ClearingHouse.from(
			connection,
			new Wallet(userKeypair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(2)),
			ammInitialQuoteAssetReserve,
			new BN(0)
		);

		let user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		let userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		const numberOfReduces = chunks;
		const market = clearingHouse.getMarket(marketIndex);
		const baseAssetValue = calculateBaseAssetValue(
			market,
			userPositionsAccount.positions[0]
		);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(14999849)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		await clearingHouse.unsubscribe();
	};

	const shrinkUnrofitableShort = async (chunks: number) => {
		const userKeypair = new Keypair();
		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			new Wallet(userKeypair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(3)),
			ammInitialQuoteAssetReserve.mul(new BN(4)),
			new BN(0)
		);

		let user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		let userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		const numberOfReduces = chunks;
		const market = clearingHouse.getMarket(marketIndex);
		const baseAssetValue = calculateBaseAssetValue(
			market,
			userPositionsAccount.positions[0]
		);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(6666311)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		await clearingHouse.unsubscribe();
	};

	it('open and shrink profitable long twice', async () => {
		await shrinkProfitableLong(2);
	});

	it('open and shrink profitable long fource', async () => {
		await shrinkProfitableLong(4);
	});

	it('open and shrink unprofitable long twice', async () => {
		await shrinkUnprofitableLong(2);
	});

	it('open and shrink unprofitable long fource', async () => {
		await shrinkUnprofitableLong(4);
	});

	it('open and shrink profitable short twice', async () => {
		await shrinkProfitableShort(2);
	});

	it('open and shrink profitable short fource', async () => {
		await shrinkProfitableShort(4);
	});

	it('open and shrink unprofitable short twice', async () => {
		await shrinkUnrofitableShort(2);
	});

	it('open and shrink unprofitable short fource', async () => {
		await shrinkUnrofitableShort(4);
	});
});
