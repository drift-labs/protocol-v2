import * as anchor from '@project-serum/anchor';
import {
	BASE_PRECISION,
	BN,
	getLimitOrderParams,
	isVariant,
	OracleSource,
	ZERO,
} from '../sdk';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	ClearingHouse,
	EventSubscriber,
	findComputeUnitConsumption,
	MARK_PRICE_PRECISION,
	PositionDirection,
	Wallet,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteAssetBank,
} from './testHelpers';

describe('liquidate perp', () => {
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

	let usdcMint;
	let userUSDCAccount;

	const liquidatorKeyPair = new Keypair();
	let liquidatorUSDCAccount: Keypair;
	let liquidatorClearingHouse: ClearingHouse;

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
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const oracle = await mockOracle(1);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializeMarket(
			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(175).mul(BASE_PRECISION).div(new BN(10)), // 25 SOL
			new BN(0),
			new BN(0)
		);

		for (let i = 0; i < 32; i++) {
			await clearingHouse.placeOrder(
				getLimitOrderParams({
					baseAssetAmount: BASE_PRECISION,
					marketIndex: ZERO,
					direction: PositionDirection.LONG,
					price: MARK_PRICE_PRECISION,
				})
			);
		}

		provider.connection.requestAirdrop(liquidatorKeyPair.publicKey, 10 ** 9);
		liquidatorUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			liquidatorKeyPair.publicKey
		);
		liquidatorClearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(liquidatorKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await liquidatorClearingHouse.subscribe();

		await liquidatorClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			liquidatorUSDCAccount.publicKey
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const oracle = clearingHouse.getMarketAccount(0).amm.oracle;
		await setFeedPrice(anchor.workspace.Pyth, 0.25, oracle);

		const txSig = await liquidatorClearingHouse.liquidatePerp(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0),
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

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

		for (let i = 0; i < 32; i++) {
			assert(
				isVariant(clearingHouse.getUserAccount().orders[i].status, 'init')
			);
		}

		assert(
			liquidatorClearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(new BN(175000000000000))
		);

		assert(!clearingHouse.getUserAccount().beingLiquidated);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(isVariant(liquidationRecord.liquidationType, 'liquidatePerp'));
		assert(liquidationRecord.liquidatePerp.marketIndex.eq(ZERO));
		assert(liquidationRecord.liquidatePerp.orderIds.length === 32);
		assert(
			liquidationRecord.liquidatePerp.oraclePrice.eq(
				MARK_PRICE_PRECISION.div(new BN(4))
			)
		);
		assert(
			liquidationRecord.liquidatePerp.baseAssetAmount.eq(
				new BN(-175000000000000)
			)
		);
		assert(
			liquidationRecord.liquidatePerp.quoteAssetAmount.eq(new BN(4375000))
		);
		assert(liquidationRecord.liquidatePerp.userPnl.eq(new BN(-13125613)));
		assert(liquidationRecord.liquidatePerp.liquidatorPnl.eq(new BN(0)));
	});
});
