import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	EventSubscriber,
	findComputeUnitConsumption,
	MARK_PRICE_PRECISION,
	PositionDirection,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';

describe('whale liquidation', () => {
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
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(30 * 10 ** 8);

	const maxPositions = 5;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0), new BN(1), new BN(2), new BN(3), new BN(4)],
			[new BN(0)]
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

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

		const usdcPerPosition = usdcAmount
			.mul(new BN(5))
			.div(new BN(maxPositions))
			.mul(new BN(99))
			.div(new BN(100));

		for (let i = 0; i < maxPositions; i++) {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				usdcPerPosition,
				new BN(i),
				new BN(0)
			);
		}
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouse.unsubscribe();
	});

	it('partial liquidate', async () => {
		for (let i = 0; i < maxPositions; i++) {
			const oracle = clearingHouse.getMarketAccount(i).amm.oracle;
			await setFeedPrice(anchor.workspace.Pyth, 0.85, oracle);
			await clearingHouse.moveAmmPrice(
				ammInitialBaseAssetReserve.mul(new BN(10)).div(new BN(71)),
				ammInitialQuoteAssetReserve.mul(new BN(10)).div(new BN(80)),
				new BN(i)
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
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(liquidationRecord.partial);
		// 15% of position closed
		assert(liquidationRecord.baseAssetValue.eq(new BN(12574371680)));
		assert(liquidationRecord.baseAssetValueClosed.eq(new BN(1886155752)));
		// 1.5% of total collateral taken
		assert(liquidationRecord.totalCollateral.eq(new BN(705857160)));
		assert(liquidationRecord.liquidationFee.eq(new BN(10587855)));
	});

	it('liquidate', async () => {
		for (let i = 0; i < maxPositions; i++) {
			const oracle = clearingHouse.getMarketAccount(i).amm.oracle;
			await setFeedPrice(anchor.workspace.Pyth, 0.85, oracle);
			await clearingHouse.moveAmmPrice(
				ammInitialBaseAssetReserve.div(new BN(5)),
				ammInitialQuoteAssetReserve.div(new BN(6)),
				new BN(i)
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
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await eventSubscriber.awaitTx(txSig);
		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(!liquidationRecord.partial);
		// 41% of position closed
		assert(liquidationRecord.baseAssetValue.eq(new BN(10249423566)));
		assert(liquidationRecord.baseAssetValueClosed.eq(new BN(4180276391)));
		// 41% of total collateral taken
		assert(liquidationRecord.totalCollateral.eq(new BN(444063242)));
		assert(liquidationRecord.liquidationFee.eq(new BN(181113314)));
	});
});
