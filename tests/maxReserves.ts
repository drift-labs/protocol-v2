import * as anchor from '@project-serum/anchor';
import { BN } from '../sdk';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	EventSubscriber,
	findComputeUnitConsumption,
	MARK_PRICE_PRECISION,
	PositionDirection,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';

describe('max reserves', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));

	// MAX SQRT K WITHOUT MATH ERRORS
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13)
		.mul(mantissaSqrtScale)
		.mul(MARK_PRICE_PRECISION);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13)
		.mul(mantissaSqrtScale)
		.mul(MARK_PRICE_PRECISION);

	const usdcAmount = new BN(QUOTE_PRECISION)
		.mul(mantissaSqrtScale)
		.mul(new BN(1));

	const maxPositions = 5;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0), new BN(1), new BN(2), new BN(3), new BN(4)],
			bankIndexes: [new BN(0)],
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		for (let i = 0; i < maxPositions; i++) {
			const oracle = await mockOracle(1);
			const periodicity = new BN(0);

			await clearingHouse.initializeMarket(
				oracle,
				ammInitialBaseAssetReserve,
				ammInitialQuoteAssetReserve,
				periodicity
			);
		}

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('open max positions', async () => {
		const usdcPerPosition = usdcAmount
			.mul(new BN(5))
			.div(new BN(maxPositions))
			.mul(new BN(99))
			.div(new BN(100));
		for (let i = 0; i < maxPositions; i++) {
			await clearingHouse.fetchAccounts();
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				usdcPerPosition,
				new BN(i),
				new BN(0)
			);
		}
	});

	it('partial liquidate', async () => {
		for (let i = 0; i < maxPositions; i++) {
			const oracle = clearingHouse.getMarketAccount(i).amm.oracle;
			await setFeedPrice(anchor.workspace.Pyth, 0.85, oracle);
			await clearingHouse.updateFundingRate(oracle, new BN(i));
			await clearingHouse.moveAmmToPrice(
				new BN(i),
				new BN(0.85 * MARK_PRICE_PRECISION.toNumber())
			);
		}

		console.log('liquidate');
		const txSig = await clearingHouse.liquidate(userAccountPublicKey);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);

		await clearingHouse.fetchAccounts();
		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.partial);
	});

	it('liquidate', async () => {
		for (let i = 0; i < maxPositions; i++) {
			const oracle = clearingHouse.getMarketAccount(i).amm.oracle;
			await setFeedPrice(anchor.workspace.Pyth, 0.8, oracle);
			await clearingHouse.moveAmmToPrice(
				new BN(i),
				new BN(0.8 * MARK_PRICE_PRECISION.toNumber())
			);
		}

		const txSig = await clearingHouse.liquidate(userAccountPublicKey);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);

		await clearingHouse.fetchAccounts();
		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(!liquidationRecord.partial);
	});
});
