import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import { AMM_MANTISSA, ClearingHouse, PositionDirection } from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from '../utils/mockAccounts';
import { FeeStructure } from '../sdk';

describe('idempotent curve', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let usdcMint;
	let primaryClearingHouse: ClearingHouse;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		primaryClearingHouse = new ClearingHouse(
			connection,
			provider.wallet,
			chProgram.programId
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
			driftTokenRebate: {
				firstTier: {
					minimumBalance: new BN(1),
					rebateNumerator: new BN(1),
					rebateDenominator: new BN(1),
				},
				secondTier: {
					minimumBalance: new BN(1),
					rebateNumerator: new BN(1),
					rebateDenominator: new BN(1),
				},
				thirdTier: {
					minimumBalance: new BN(1),
					rebateNumerator: new BN(1),
					rebateDenominator: new BN(1),
				},
				fourthTier: {
					minimumBalance: new BN(1),
					rebateNumerator: new BN(1),
					rebateDenominator: new BN(1),
				},
			},
			referralRebate: {
				referrerRewardNumerator: new BN(1),
				referrerRewardDenominator: new BN(1),
				refereeRebateNumerator: new BN(1),
				refereeRebateDenominator: new BN(1),
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
		const clearingHouse = new ClearingHouse(
			connection,
			new Wallet(userKeypair),
			chProgram.programId
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
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
		const baseAssetValue = await clearingHouse
			.calculateBaseAssetValue(userPositionsAccount.positions[0])
			.div(AMM_MANTISSA);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				userAccountPublicKey,
				PositionDirection.SHORT,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(19999200)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		// await clearingHouse.unsubscribe();
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
		const clearingHouse = new ClearingHouse(
			connection,
			new Wallet(userKeypair),
			chProgram.programId
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
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
		const baseAssetValue = await clearingHouse
			.calculateBaseAssetValue(userPositionsAccount.positions[0])
			.div(AMM_MANTISSA);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				userAccountPublicKey,
				PositionDirection.SHORT,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(4999850)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		// await clearingHouse.unsubscribe();
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
		const clearingHouse = new ClearingHouse(
			connection,
			new Wallet(userKeypair),
			chProgram.programId
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
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
		const baseAssetValue = await clearingHouse
			.calculateBaseAssetValue(userPositionsAccount.positions[0])
			.div(AMM_MANTISSA);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				userAccountPublicKey,
				PositionDirection.LONG,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(14999849)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
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
		const clearingHouse = new ClearingHouse(
			connection,
			new Wallet(userKeypair),
			chProgram.programId
		);
		await clearingHouse.subscribe();

		const [, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
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
		const baseAssetValue = await clearingHouse
			.calculateBaseAssetValue(userPositionsAccount.positions[0])
			.div(AMM_MANTISSA);
		for (let i = 0; i < numberOfReduces - 1; i++) {
			await clearingHouse.openPosition(
				userAccountPublicKey,
				PositionDirection.LONG,
				baseAssetValue.div(new BN(numberOfReduces)),
				marketIndex,
				new BN(0)
			);
		}
		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		userPositionsAccount =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert(user.collateral.eq(new BN(6666311)));
		assert(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		// await clearingHouse.unsubscribe();
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
