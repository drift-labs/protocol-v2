import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
	Wallet,
	getMarketOrderParams,
	OrderTriggerCondition,
	getTriggerLimitOrderParams,
	EventSubscriber,
	MarketStatus,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import { AMM_RESERVE_PRECISION, OracleSource, ZERO, isVariant } from '../sdk';
import {
	createAssociatedTokenAccountIdempotentInstruction,
	createMintToInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('stop limit', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let velocityClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let discountMint: PublicKey;

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerVelocityClient: TestClient;
	let fillerUser: User;

	const marketIndex = 0;
	let solUsd;
	let btcUsd;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
			undefined,
			10000
		);
		btcUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			60000,
			-7,
			undefined,
			10000
		);

		const marketIndexes = [marketIndex];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{
				publicKey: solUsd,
				source: OracleSource.PYTH_LAZER,
			},
			{
				publicKey: btcUsd,
				source: OracleSource.PYTH_LAZER,
			},
		];

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await velocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
		await velocityClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await velocityClient.initializePerpMarket(
			1,
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000000) // btc-ish price level
		);
		await velocityClient.updatePerpMarketStatus(1, MarketStatus.ACTIVE);

		[, userAccountPublicKey] =
			await velocityClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

		const discountMintKeypair = await mockUSDCMint(bankrunContextWrapper);

		discountMint = discountMintKeypair.publicKey;

		await velocityClient.updateDiscountMint(discountMint);

		const discountMintAta = getAssociatedTokenAddressSync(
			discountMint,
			bankrunContextWrapper.provider.wallet.publicKey
		);
		const ix = createAssociatedTokenAccountIdempotentInstruction(
			bankrunContextWrapper.context.payer.publicKey,
			discountMintAta,
			bankrunContextWrapper.provider.wallet.publicKey,
			discountMint
		);
		const mintToIx = createMintToInstruction(
			discountMint,
			discountMintAta,
			bankrunContextWrapper.provider.wallet.publicKey,
			1000 * 10 ** 6
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(ix, mintToIx)
		);

		await bankrunContextWrapper.fundKeypair(fillerKeyPair, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			fillerKeyPair.publicKey
		);
		fillerVelocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(fillerKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await fillerVelocityClient.subscribe();

		await fillerVelocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = new User({
			velocityClient: fillerVelocityClient,
			userAccountPublicKey:
				await fillerVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await fillerUser.subscribe();
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
		await fillerUser.unsubscribe();
		await fillerVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Fill stop limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const triggerPrice = PRICE_PRECISION;
		const limitPrice = PRICE_PRECISION.sub(
			velocityClient.getPerpMarketAccount(marketIndex).orderTickSize
		);
		const triggerCondition = OrderTriggerCondition.ABOVE;

		await velocityClient.placeAndTakePerpOrder(
			getMarketOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
			})
		);

		const orderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice,
			triggerCondition,
		});

		await velocityClient.placePerpOrder(orderParams);
		const orderId = 2;
		const orderIndex = new BN(0);
		await velocityClientUser.fetchAccounts();
		let order = velocityClientUser.getOrder(orderId);

		await setFeedPriceNoProgram(bankrunContextWrapper, 1.01, solUsd, 10000);
		await velocityClient.moveAmmToPrice(
			marketIndex,
			new BN(1.01 * PRICE_PRECISION.toNumber())
		);
		await velocityClient.triggerOrder(
			userAccountPublicKey,
			velocityClientUser.getUserAccount(),
			order
		);

		await fillerVelocityClient.fillPerpOrder(
			userAccountPublicKey,
			velocityClientUser.getUserAccount(),
			order
		);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		order = velocityClientUser.getUserAccount().orders[orderIndex.toString()];

		assert(isVariant(order.status, 'filled'));

		const firstPosition = velocityClientUser.getUserAccount().perpPositions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteBreakEvenAmount.eq(expectedQuoteAssetAmount));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(1010000);
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedTradeQuoteAssetAmount)
		);

		const expectedOrderId = 2;
		const expectedFillRecordId = new BN(2);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.takerOrderId === expectedOrderId);
		assert(isVariant(orderRecord.action, 'fill'));
		assert(
			orderRecord.taker.equals(
				await velocityClientUser.getUserAccountPublicKey()
			)
		);
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.fillRecordId.eq(expectedFillRecordId));
	});

	it('Fill stop limit long order', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const triggerPrice = PRICE_PRECISION;
		const limitPrice = PRICE_PRECISION.add(
			velocityClient.getPerpMarketAccount(marketIndex).orderTickSize
		);
		const triggerCondition = OrderTriggerCondition.BELOW;

		await velocityClient.placeAndTakePerpOrder(
			getMarketOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
			})
		);

		const orderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice,
			triggerCondition,
		});

		await velocityClient.placePerpOrder(orderParams);
		const orderId = 4;
		const orderIndex = new BN(0);
		velocityClientUser.getUserAccount();
		let order = velocityClientUser.getOrder(orderId);

		await setFeedPriceNoProgram(bankrunContextWrapper, 0.99, solUsd, 10000);
		await velocityClient.moveAmmToPrice(
			marketIndex,
			new BN(0.99 * PRICE_PRECISION.toNumber())
		);
		await velocityClient.triggerOrder(
			userAccountPublicKey,
			velocityClientUser.getUserAccount(),
			order
		);

		await fillerVelocityClient.fillPerpOrder(
			userAccountPublicKey,
			velocityClientUser.getUserAccount(),
			order
		);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		order = velocityClientUser.getUserAccount().orders[orderIndex.toString()];

		assert(isVariant(order.status, 'filled'));

		const firstPosition = velocityClientUser.getUserAccount().perpPositions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteBreakEvenAmount.eq(expectedQuoteAssetAmount));

		const expectedTradeQuoteAssetAmount = new BN(990001);
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		const expectedOrderId = 4;
		const expectedFillRecord = new BN(4);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.takerOrderId === expectedOrderId);
		assert(isVariant(orderRecord.action, 'fill'));
		assert(
			orderRecord.taker.equals(
				await velocityClientUser.getUserAccountPublicKey()
			)
		);
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(
			orderRecord.quoteAssetAmountFilled.eq(expectedTradeQuoteAssetAmount)
		);
		assert(orderRecord.fillRecordId.eq(expectedFillRecord));
	});
});
