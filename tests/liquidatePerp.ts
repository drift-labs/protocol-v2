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
	initializeQuoteSpotMarket,
	printTxLogs,
} from './testHelpers';

describe('liquidate perp and lp', () => {
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
	const nLpShares = new BN(10000000);

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
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0)],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
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

		const txSig = await clearingHouse.addLiquidity(nLpShares, ZERO);
		await printTxLogs(connection, txSig);

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
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0)],
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
		const lpShares = clearingHouse.getUserAccount().perpPositions[0].lpShares;
		assert(lpShares.eq(nLpShares));

		const oracle = clearingHouse.getPerpMarketAccount(0).amm.oracle;
		await setFeedPrice(anchor.workspace.Pyth, 0.1, oracle);

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
				.perpPositions[0].baseAssetAmount.eq(new BN(175000000000000))
		);

		assert(clearingHouse.getUserAccount().beingLiquidated);
		assert(clearingHouse.getUserAccount().nextLiquidationId === 2);

		// try to add liq when being liquidated -- should fail
		try {
			await clearingHouse.addLiquidity(nLpShares, ZERO);
			assert(false);
		} catch (err) {
			assert(err.message.includes('0x17d6'));
		}

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidatePerp'));
		assert(liquidationRecord.liquidatePerp.marketIndex.eq(ZERO));
		assert(liquidationRecord.liquidatePerp.orderIds.length === 32);
		assert(
			liquidationRecord.liquidatePerp.oraclePrice.eq(
				MARK_PRICE_PRECISION.div(new BN(10))
			)
		);
		assert(
			liquidationRecord.liquidatePerp.baseAssetAmount.eq(
				new BN(-175000000000000)
			)
		);

		assert(
			liquidationRecord.liquidatePerp.quoteAssetAmount.eq(new BN(1750000))
		);
		assert(liquidationRecord.liquidatePerp.userPnl.eq(new BN(-15750613)));
		assert(liquidationRecord.liquidatePerp.liquidatorPnl.eq(new BN(0)));
		assert(liquidationRecord.liquidatePerp.lpShares.eq(nLpShares));

		await liquidatorClearingHouse.liquidatePerpPnlForDeposit(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0),
			new BN(0),
			clearingHouse.getUserAccount().perpPositions[0].quoteAssetAmount
		);

		assert(clearingHouse.getUserAccount().bankrupt);
		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-6088113))
		);

		// try to add liq when bankrupt -- should fail
		try {
			await clearingHouse.addLiquidity(nLpShares, ZERO);
			assert(false);
		} catch (err) {
			// cant add when bankrupt
			assert(err.message.includes('0x17de'));
		}

		await liquidatorClearingHouse.resolvePerpBankruptcy(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();

		assert(!clearingHouse.getUserAccount().bankrupt);
		assert(!clearingHouse.getUserAccount().beingLiquidated);
		assert(
			clearingHouse.getUserAccount().perpPositions[0].quoteAssetAmount.eq(ZERO)
		);
		assert(clearingHouse.getUserAccount().perpPositions[0].lpShares.eq(ZERO));

		const perpBankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(isVariant(perpBankruptcyRecord.liquidationType, 'perpBankruptcy'));
		assert(perpBankruptcyRecord.perpBankruptcy.marketIndex.eq(ZERO));
		assert(perpBankruptcyRecord.perpBankruptcy.pnl.eq(new BN(-6088113)));
		assert(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.eq(
				new BN(34789200000000)
			)
		);

		const market = clearingHouse.getPerpMarketAccount(0);
		assert(market.amm.cumulativeFundingRateLong.eq(new BN(34789200000000)));
		assert(market.amm.cumulativeFundingRateShort.eq(new BN(-34789200000000)));
	});
});
