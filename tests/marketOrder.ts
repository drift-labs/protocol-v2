import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	BN,
	PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	getMarketOrderParams,
	EventSubscriber,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	isVariant,
	OracleSource,
	PEG_PRECISION,
	ZERO,
} from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('market order', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let discountMint: Token;
	let discountTokenAccount: AccountInfo;

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerClearingHouse: ClearingHouse;
	let fillerUser: ClearingHouseUser;

	const marketIndex = 0;
	let solUsd;
	let btcUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);

		const marketIndexes = [0, 1];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: btcUsd, source: OracleSource.PYTH },
		];

		clearingHouse = new Admin({
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
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000).mul(PEG_PRECISION) // btc-ish price level
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		discountMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			6,
			TOKEN_PROGRAM_ID
		);

		await clearingHouse.updateDiscountMint(discountMint.publicKey);

		discountTokenAccount = await discountMint.getOrCreateAssociatedAccountInfo(
			provider.wallet.publicKey
		);

		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			fillerKeyPair.publicKey
		);
		fillerClearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(fillerKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await fillerClearingHouse.subscribe();

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = new ClearingHouseUser({
			clearingHouse: fillerClearingHouse,
			userAccountPublicKey: await fillerClearingHouse.getUserAccountPublicKey(),
		});
		await fillerUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerUser.unsubscribe();
		await fillerClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Fill market long order with base asset', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = PRICE_PRECISION.mul(new BN(1049)).div(new BN(1000)); // dont breach oracle price bands

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
		});
		await clearingHouse.placeAndTake(orderParams);
		const orderIndex = new BN(0);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order =
			clearingHouseUser.getUserAccount().orders[orderIndex.toString()];

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const expectedFeeToMarket = new BN(1000);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex === 0);

		const firstPosition = clearingHouseUser.getUserAccount().perpPositions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

		const expectedQuoteAssetAmount = new BN(-1000001);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderActionRecord.quoteAssetAmountFilled.eq(
				expectedQuoteAssetAmount.abs()
			)
		);

		const expectedFillRecordId = new BN(1);
		const expectedFee = new BN(1000);
		assert(orderActionRecord.ts.gt(ZERO));
		assert(orderActionRecord.takerFee.eq(expectedFee));
		assert(orderActionRecord.takerOrderFee.eq(expectedFee));
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(
			orderActionRecord.taker.equals(
				await clearingHouseUser.getUserAccountPublicKey()
			)
		);
		assert(orderActionRecord.fillerReward.eq(ZERO));
		assert(orderActionRecord.fillRecordId.eq(expectedFillRecordId));
	});

	it('Fill market short order with base asset', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const firstPosition = clearingHouseUser.getUserAccount().perpPositions[0];
		assert(firstPosition.baseAssetAmount.eq(ZERO));

		assert(firstPosition.quoteEntryAmount.eq(ZERO));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		const expectedQuoteAssetAmount = new BN(1000000);
		assert.ok(
			orderActionRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount)
		);

		const expectedFillRecord = new BN(2);
		const expectedFee = new BN(1000);
		assert(orderActionRecord.ts.gt(ZERO));
		assert(orderActionRecord.takerFee.eq(expectedFee));
		assert(orderActionRecord.takerOrderFee.eq(expectedFee));
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(
			orderActionRecord.taker.equals(
				await clearingHouseUser.getUserAccountPublicKey()
			)
		);
		assert(orderActionRecord.fillerReward.eq(ZERO));
		assert(orderActionRecord.fillRecordId.eq(expectedFillRecord));
	});
});
