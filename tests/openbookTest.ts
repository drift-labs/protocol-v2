import { assert } from 'chai';
import * as anchor from '@coral-xyz/anchor';

import { Program, Idl, BN } from '@coral-xyz/anchor';

import {
	OracleSource,
	OrderType,
	PositionDirection,
	PublicKey,
	TestClient,
} from '../sdk/src';
import openbookIDL from '../sdk/src/idl/openbook.json';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import {
	createOpenOrdersAccount,
	createOpenOrdersAccountV2,
	OPENBOOK,
	OrderType as ObOrderType,
	placeOrder,
	SelfTradeBehavior,
	Side,
} from './openbookHelpers';
import {
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { createBidsAsksEventHeap, createMarket } from './openbookHelpers';
import { Keypair } from '@solana/web3.js';
import { LAMPORTS_PRECISION, PRICE_PRECISION } from '../sdk/src';
import { WRAPPED_SOL_MINT } from '../sdk/src';
import { ZERO } from '../sdk';

describe('openbook v2', () => {
	const chProgram = anchor.workspace.Drift as Program;
	const openbookProgram = new Program(openbookIDL as Idl, OPENBOOK);

	let driftClient: TestClient;

	let fillerDriftClient: TestClient;
	const fillerKeypair = Keypair.generate();

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	const solSpotMarketIndex = 1;

	const bids = Keypair.generate();
	const asks = Keypair.generate();
	const eventHeap = Keypair.generate();
	const market = Keypair.generate();
	let usdcMint: Keypair;

	const usdcAmount = new anchor.BN(200 * 1_000 * 10 ** 6);
	const solAmount = new anchor.BN(200 * 1_000 * 10 ** 9);

	let userUsdcAccount: Keypair;
	let userWSolAccount: PublicKey;

	let _marketAuthority: PublicKey;
	let marketBaseVault: PublicKey;
	let marketQuoteVault: PublicKey;

	let openOrdersAccount: PublicKey;
	let openOrdersIndexer: PublicKey;
	const openOrdersAccounts: PublicKey[] = [];

	before(async () => {
		const context = await startAnchor(
			'',
			[
				{
					name: 'openbook',
					programId: OPENBOOK,
				},
			],
			[]
		);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		const solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);
		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		userUsdcAccount = await mockUserUSDCAccount(
			usdcMint,
			// @ts-ignore
			usdcAmount.muln(2),
			bankrunContextWrapper
		);

		userWSolAccount = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			solAmount
		);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await createBidsAsksEventHeap(bankrunContextWrapper, bids, asks, eventHeap);

		const quoteSizeLot = new BN(1);
		const baseSizeLot = new BN(100000);
		[_marketAuthority, marketBaseVault, marketQuoteVault] = await createMarket(
			bankrunContextWrapper,
			openbookProgram,
			market,
			WRAPPED_SOL_MINT,
			usdcMint.publicKey,
			bids.publicKey,
			asks.publicKey,
			eventHeap.publicKey,
			quoteSizeLot,
			baseSizeLot
		);

		[openOrdersIndexer, openOrdersAccount] = await createOpenOrdersAccount(
			bankrunContextWrapper,
			openbookProgram,
			market.publicKey
		);
		const names = [
			'Bob',
			'Marley',
			'Nicky',
			'Minaj',
			'Bad',
			'Bunny',
			'Luis',
			'Miguel',
			'Anita',
			'Soul',
			'Bronco',
			'Marilina',
			'Rytmus',
			'Separ',
			'Meiko',
			'Kaji',
			'Karol',
			'G',
			'Ricky',
			'Martin',
		];
		let index = 1;
		for (const name of names) {
			index += 1;
			openOrdersAccounts.push(
				await createOpenOrdersAccountV2(
					bankrunContextWrapper,
					openbookProgram,
					market.publicKey,
					openOrdersIndexer,
					name,
					index
				)
			);
		}
		console.log(`OpenOrdersAccounts: ${openOrdersAccounts}`);

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		await driftClient.updateSpotMarketStepSizeAndTickSize(
			1,
			baseSizeLot,
			quoteSizeLot
		);

		await driftClient.updateSpotMarketOrdersEnabled(1, true);

		await driftClient.initializeUserAccountAndDepositCollateral(
			// @ts-ignore
			usdcAmount,
			userUsdcAccount.publicKey
		);

		await driftClient.addUser(0);
		// @ts-ignore
		// await driftClient.deposit(solAmount, 1, userWSolAccount.publicKey);

		fillerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(fillerKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await fillerDriftClient.subscribe();

		await bankrunContextWrapper.fundKeypair(fillerKeypair, 10 * 10 ** 9);

		await fillerDriftClient.initializeUserAccount();

		await fillerDriftClient.addUser(0);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await fillerDriftClient.unsubscribe();
	});

	it('add market', async () => {
		await driftClient.initializeOpenbookV2FulfillmentConfig(
			solSpotMarketIndex,
			market.publicKey
		);
	});

	it('fill ask and bids', async () => {
		for (let i = 0; i < 10; i++) {
			const ooa = openOrdersAccounts[i];
			for (let j = 0; j < 15; j++) {
				await placeOrder(
					bankrunContextWrapper,
					openbookProgram,
					ooa,
					openOrdersIndexer,
					market.publicKey,
					bids.publicKey,
					asks.publicKey,
					eventHeap.publicKey,
					marketBaseVault,
					userWSolAccount,
					{
						side: Side.ASK,
						priceLots: new anchor.BN(10000 + (j + 1) * 300),
						maxBaseLots: new anchor.BN(1_000_000_000),
						maxQuoteLotsIncludingFees: new anchor.BN(
							100_000_000 + (j + 1) * 3_000_000
						),
						clientOrderId: new anchor.BN(0),
						orderType: ObOrderType.LIMIT,
						expiryTimestamp: new anchor.BN(0),
						selfTradeBehavior: SelfTradeBehavior.DECREMENT_TAKE,
						limit: new anchor.BN(20),
					}
				);
			}
		}
		for (let i = 10; i < 20; i++) {
			const ooa = openOrdersAccounts[i];
			for (let j = 0; j < 15; j++) {
				console.log('BIDING');
				await placeOrder(
					bankrunContextWrapper,
					openbookProgram,
					ooa,
					openOrdersIndexer,
					market.publicKey,
					bids.publicKey,
					asks.publicKey,
					eventHeap.publicKey,
					marketQuoteVault,
					userUsdcAccount.publicKey,
					{
						side: Side.BID,
						priceLots: new anchor.BN(10000 - (j + 1) * 300),
						maxBaseLots: new anchor.BN(1_000_000_000),
						maxQuoteLotsIncludingFees: new anchor.BN(
							100_000_000 - (j + 1) * 3_000_000
						),
						clientOrderId: new anchor.BN(0),
						orderType: ObOrderType.LIMIT,
						expiryTimestamp: new anchor.BN(0),
						selfTradeBehavior: SelfTradeBehavior.DECREMENT_TAKE,
						limit: new anchor.BN(20),
					}
				);
			}
		}
	});

	it('fill long', async () => {
		const quoteTokenAmountBefore = driftClient.getTokenAmount(0);
		const baseTokenAmountBefore = driftClient.getTokenAmount(1);

		console.log(`quoteTokenAmountBefore ${quoteTokenAmountBefore.toString()}`);
		console.log(`baseTokenAmountBefore ${baseTokenAmountBefore.toString()}`);
		await placeOrder(
			bankrunContextWrapper,
			openbookProgram,
			openOrdersAccount,
			openOrdersIndexer,
			market.publicKey,
			bids.publicKey,
			asks.publicKey,
			eventHeap.publicKey,
			marketBaseVault,
			userWSolAccount,
			{
				side: Side.ASK,
				priceLots: new anchor.BN(10000),
				maxBaseLots: new anchor.BN(1_000_000_000),
				maxQuoteLotsIncludingFees: new anchor.BN(100_000_000),
				clientOrderId: new anchor.BN(0),
				orderType: ObOrderType.LIMIT,
				expiryTimestamp: new anchor.BN(0),
				selfTradeBehavior: SelfTradeBehavior.DECREMENT_TAKE,
				limit: new anchor.BN(10),
			}
		);

		await driftClient.placeSpotOrder({
			orderType: OrderType.LIMIT,
			marketIndex: 1,
			// @ts-ignore
			baseAssetAmount: driftClient.convertToSpotPrecision(1, 1),
			direction: PositionDirection.LONG,
			price: PRICE_PRECISION.muln(100),
		});

		const fulfillmentConfig = await driftClient.getOpenbookV2FulfillmentConfig(
			market.publicKey
		);
		fulfillmentConfig.remainingAccounts = [
			openOrdersAccount,
			openOrdersAccounts[2],
			openOrdersAccounts[13],
		];

		const userAccount = driftClient.getUserAccount();
		const order = userAccount.orders.filter(
			(order) => order.marketIndex == 1
		)[0];
		await fillerDriftClient.fillSpotOrder(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			order,
			fulfillmentConfig
		);

		await driftClient.fetchAccounts();

		const quoteTokenAmountAfter = driftClient.getTokenAmount(0);
		const baseTokenAmountAfter = driftClient.getTokenAmount(1);

		const openOrdersAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(openOrdersAccount);
		const openOrdersAccountParsedData =
			await openbookProgram.account.openOrdersAccount.coder.accounts.decode(
				'OpenOrdersAccount',
				openOrdersAccountInfo.data
			);
		assert(
			openOrdersAccountParsedData.position.quoteFreeNative.eq(new BN(100000000))
		);

		console.log(`quoteTokenAmountAfter ${quoteTokenAmountAfter.toString()}`);
		console.log(`baseTokenAmountAfter ${baseTokenAmountAfter.toString()}`);

		assert(baseTokenAmountAfter.eq(LAMPORTS_PRECISION));
		assert(quoteTokenAmountAfter.eq(new BN('199899899999')));
	});

	it('fill short', async () => {
		await placeOrder(
			bankrunContextWrapper,
			openbookProgram,
			openOrdersAccount,
			openOrdersIndexer,
			market.publicKey,
			bids.publicKey,
			asks.publicKey,
			eventHeap.publicKey,
			marketQuoteVault,
			userUsdcAccount.publicKey,
			{
				side: Side.BID,
				priceLots: new anchor.BN(10000),
				maxBaseLots: new anchor.BN(1_000_000_000),
				maxQuoteLotsIncludingFees: new anchor.BN(100_000_000),
				clientOrderId: new anchor.BN(0),
				orderType: ObOrderType.LIMIT,
				expiryTimestamp: new anchor.BN(0),
				selfTradeBehavior: SelfTradeBehavior.DECREMENT_TAKE,
				limit: new anchor.BN(10),
			}
		);

		await driftClient.placeSpotOrder({
			orderType: OrderType.LIMIT,
			marketIndex: 1,
			// @ts-ignore
			baseAssetAmount: driftClient.convertToSpotPrecision(1, 1),
			direction: PositionDirection.SHORT,
			price: PRICE_PRECISION.muln(100),
		});

		const fulfillmentConfig = await driftClient.getOpenbookV2FulfillmentConfig(
			market.publicKey
		);
		fulfillmentConfig.remainingAccounts = [
			openOrdersAccount,
			openOrdersAccounts[1],
			openOrdersAccounts[12],
		];

		const userAccount = driftClient.getUserAccount();
		const order = userAccount.orders.filter(
			(order) => order.marketIndex == 1
		)[0];
		await fillerDriftClient.fillSpotOrder(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			order,
			fulfillmentConfig
		);

		await driftClient.fetchAccounts();

		const quoteTokenAmountAfter = driftClient.getTokenAmount(0);
		const baseTokenAmountAfter = driftClient.getTokenAmount(1);

		console.log(`quoteTokenAmountAfter ${quoteTokenAmountAfter.toString()}`);
		console.log(`baseTokenAmountAfter ${baseTokenAmountAfter.toString()}`);

		assert(baseTokenAmountAfter.eq(ZERO));
		assert(quoteTokenAmountAfter.eq(new BN('199999799999')));

		const openOrdersAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(openOrdersAccount);
		const openOrdersAccountParsedData =
			await openbookProgram.account.openOrdersAccount.coder.accounts.decode(
				'OpenOrdersAccount',
				openOrdersAccountInfo.data
			);
		assert(openOrdersAccountParsedData.position.baseFreeNative.eq(new BN(1e9)));
	});
});
