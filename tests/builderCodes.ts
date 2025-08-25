import * as anchor from '@coral-xyz/anchor';

import { Program } from '@coral-xyz/anchor';

import {
	AccountInfo,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
} from '@solana/web3.js';

import {
	TestClient,
	OracleSource,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	PTYH_LAZER_PROGRAM_ID,
	assert,
	getBuilderAccountPublicKey,
	getBuilderEscrowAccountPublicKey,
	BuilderAccount,
	BuilderEscrow,
	BASE_PRECISION,
	BN,
	PRICE_PRECISION,
	getMarketOrderParams,
	PositionDirection,
	PostOnlyParams,
	MarketType,
	OrderParams,
	PEG_PRECISION,
	ZERO,
	isVariant,
	hasBuilder,
	parseLogs,
	BuilderEscrowMap,
	getTokenAmount,
	BuilderSettleRecord,
	getLimitOrderParams,
	SignedMsgOrderParamsMessage,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { PYTH_STORAGE_DATA } from './pythLazerData';
import { nanoid } from 'nanoid';
import {
	isBuilderOrderCompleted,
	isBuilderOrderReferral,
} from '../sdk/src/math/builder';

dotenv.config();

const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

describe('builder codes', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let usdcMint: Keypair;

	let builderClient: TestClient;
	let builderUSDCAccount: Keypair = null;

	let makerClient: TestClient;
	let makerUSDCAccount: PublicKey = null;

	let userUSDCAccount: PublicKey = null;
	let userClient: TestClient;

	// user without BuilderEscrow
	let user2USDCAccount: PublicKey = null;
	let user2Client: TestClient;

	let builderEscrowMap: BuilderEscrowMap;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let solUsd: PublicKey;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	const usdcAmount = new BN(10000 * 10 ** 6);

	before(async () => {
		const context = await startAnchor(
			'',
			[],
			[
				{
					address: PYTH_LAZER_STORAGE_ACCOUNT_KEY,
					info: PYTH_STORAGE_ACCOUNT_INFO,
				},
			]
		);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 224.3);
		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		builderClient = new TestClient({
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
		await builderClient.initialize(usdcMint.publicKey, true);
		await builderClient.subscribe();

		await builderClient.updateFeatureBitFlagsBuilderReferral(true);

		await initializeQuoteSpotMarket(builderClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await builderClient.initializePerpMarket(
			0,
			solUsd,
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);
		builderUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.add(new BN(1000000000)),
			bankrunContextWrapper,
			builderClient.wallet.publicKey
		);
		await builderClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			builderUSDCAccount.publicKey
		);
		// await builderClient.depositIntoSpotMarketRevenuePool(0, new BN(1000000000), builderUSDCAccount.publicKey);
		await builderClient.depositIntoPerpMarketFeePool(
			0,
			new BN(1000000000),
			builderUSDCAccount.publicKey
		);

		[userClient, userUSDCAccount] = await createUserWithUSDCAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader,
			{
				referrer: await builderClient.getUserAccountPublicKey(),
				referrerStats: builderClient.getUserStatsAccountPublicKey(),
			}
		);
		await userClient.deposit(
			usdcAmount,
			0,
			userUSDCAccount,
			undefined,
			false,
			undefined,
			true
		);

		[user2Client, user2USDCAccount] = await createUserWithUSDCAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader,
			{
				referrer: await builderClient.getUserAccountPublicKey(),
				referrerStats: builderClient.getUserStatsAccountPublicKey(),
			}
		);
		await user2Client.deposit(
			usdcAmount,
			0,
			user2USDCAccount,
			undefined,
			false,
			undefined,
			true
		);

		[makerClient, makerUSDCAccount] = await createUserWithUSDCAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader
		);
		await makerClient.deposit(
			usdcAmount,
			0,
			makerUSDCAccount,
			undefined,
			false,
			undefined,
			true
		);

		builderEscrowMap = new BuilderEscrowMap(userClient, false);
	});

	after(async () => {
		await builderClient.unsubscribe();
		await userClient.unsubscribe();
		await user2Client.unsubscribe();
		await makerClient.unsubscribe();
	});

	it('builder can create builder', async () => {
		await builderClient.initializeBuilder(builderClient.wallet.publicKey);

		const builderAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getBuilderAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);

		const builderAcc: BuilderAccount =
			builderClient.program.account.builder.coder.accounts.decodeUnchecked(
				'Builder',
				builderAccountInfo.data
			);
		assert(
			builderAcc.authority.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);
		assert(builderAcc.totalBuilderRewards.toNumber() === 0);
		assert(builderAcc.totalReferrerRewards.toNumber() === 0);
	});

	it('user can initialize a BuilderEscrow', async () => {
		const numOrders = 2;

		// Test the instruction creation
		const ix = await userClient.getInitializeBuilderEscrowIx(
			userClient.wallet.publicKey,
			numOrders
		);

		assert(ix !== null, 'Instruction should be created');
		assert(ix.programId.toBase58() === userClient.program.programId.toBase58());

		// Test the full transaction
		await userClient.initializeBuilderEscrow(
			userClient.wallet.publicKey,
			numOrders
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getBuilderEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		assert(accountInfo !== null, 'BuilderEscrow account should exist');
		assert(
			accountInfo.owner.toBase58() === userClient.program.programId.toBase58()
		);

		const revShareEscrow: BuilderEscrow =
			builderClient.program.coder.accounts.decodeUnchecked(
				'BuilderEscrow',
				accountInfo.data
			);
		assert(
			revShareEscrow.authority.toBase58() ===
				userClient.wallet.publicKey.toBase58()
		);
		assert(
			revShareEscrow.referrer.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);
		assert(revShareEscrow.orders.length === numOrders);
		assert(revShareEscrow.approvedBuilders.length === 0);
	});

	it('user can resize BuilderEscrow account', async () => {
		const newNumOrders = 10;

		// Test the instruction creation
		const ix = await userClient.getResizeBuilderEscrowOrdersIx(
			userClient.wallet.publicKey,
			newNumOrders
		);

		assert(ix !== null, 'Instruction should be created');
		assert(ix.programId.toBase58() === userClient.program.programId.toBase58());

		// Test the full transaction
		await userClient.resizeBuilderEscrowOrders(
			userClient.wallet.publicKey,
			newNumOrders
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getBuilderEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		assert(
			accountInfo !== null,
			'BuilderEscrow account should exist after resize'
		);
		assert(
			accountInfo.owner.toBase58() === userClient.program.programId.toBase58()
		);

		const revShareEscrow: BuilderEscrow =
			builderClient.program.coder.accounts.decodeUnchecked(
				'BuilderEscrow',
				accountInfo.data
			);
		assert(
			revShareEscrow.authority.toBase58() ===
				userClient.wallet.publicKey.toBase58()
		);
		assert(
			revShareEscrow.referrer.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);
		assert(revShareEscrow.orders.length === newNumOrders);
	});

	it('user can add/update/remove approved builder from BuilderEscrow', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150; // 1.5%

		// First add a builder
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			true // add
		);

		// Verify the builder was added
		let accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getBuilderEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		let revShareEscrow: BuilderEscrow =
			userClient.program.coder.accounts.decodeUnchecked(
				'BuilderEscrow',
				accountInfo.data
			);
		const addedBuilder = revShareEscrow.approvedBuilders.find(
			(b) => b.authority.toBase58() === builder.publicKey.toBase58()
		);
		assert(
			addedBuilder !== undefined,
			'Builder should be in approved builders list before removal'
		);
		assert(
			revShareEscrow.approvedBuilders.length === 1,
			'Approved builders list should contain 1 builder'
		);
		assert(
			addedBuilder.maxFeeBps === maxFeeBps,
			'Builder should have correct max fee bps before removal'
		);

		// update the user fee
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps * 5,
			true // update existing builder
		);

		// Verify the builder was updated
		accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getBuilderEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		revShareEscrow = userClient.program.coder.accounts.decodeUnchecked(
			'BuilderEscrow',
			accountInfo.data
		);
		const updatedBuilder = revShareEscrow.approvedBuilders.find(
			(b) => b.authority.toBase58() === builder.publicKey.toBase58()
		);
		assert(
			updatedBuilder !== undefined,
			'Builder should be in approved builders list after update'
		);
		assert(
			updatedBuilder.maxFeeBps === maxFeeBps * 5,
			'Builder should have correct max fee bps after update'
		);

		// Now remove the builder
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			false // remove
		);

		// Verify the builder was removed
		accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getBuilderEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		revShareEscrow = userClient.program.coder.accounts.decodeUnchecked(
			'BuilderEscrow',
			accountInfo.data
		);
		const removedBuilder = revShareEscrow.approvedBuilders.find(
			(b) => b.authority.toBase58() === builder.publicKey.toBase58()
		);
		assert(
			removedBuilder.maxFeeBps === 0,
			'Builder should have 0 max fee bps after removal'
		);
	});

	it('user with no BuilderEscrow can place and fill order with no builder', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));

		let userOrders = user2Client.getUser().getOpenOrders();
		assert(userOrders.length === 0);

		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: {
				triggerPrice: new BN(235).mul(PRICE_PRECISION),
				baseAssetAmount: takerOrderParams.baseAssetAmount,
			},
			stopLossOrderParams: {
				triggerPrice: new BN(220).mul(PRICE_PRECISION),
				baseAssetAmount: takerOrderParams.baseAssetAmount,
			},
			builderIdx: null,
			builderFeeBps: null,
		};

		const signedOrderParams = user2Client.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage,
			false
		);

		await builderClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			marketIndex,
			{
				taker: await user2Client.getUserAccountPublicKey(),
				takerUserAccount: user2Client.getUserAccount(),
				takerStats: user2Client.getUserStatsAccountPublicKey(),
				signingAuthority: user2Client.wallet.publicKey,
			},
			undefined,
			2
		);

		await user2Client.fetchAccounts();

		userOrders = user2Client.getUser().getOpenOrders();
		assert(userOrders.length === 3);
		assert(userOrders[0].orderId === 1);
		assert(userOrders[0].reduceOnly === true);
		assert(hasBuilder(userOrders[0]) === false);
		assert(userOrders[1].orderId === 2);
		assert(userOrders[1].reduceOnly === true);
		assert(hasBuilder(userOrders[1]) === false);
		assert(userOrders[2].orderId === 3);
		assert(userOrders[2].reduceOnly === false);
		assert(hasBuilder(userOrders[2]) === false);

		await user2Client.fetchAccounts();

		// fill order with vamm
		await builderClient.fetchAccounts();
		const fillTx = await makerClient.fillPerpOrder(
			await user2Client.getUserAccountPublicKey(),
			user2Client.getUserAccount(),
			{
				marketIndex,
				orderId: 3,
			},
			undefined,
			{
				referrer: await builderClient.getUserAccountPublicKey(),
				referrerStats: builderClient.getUserStatsAccountPublicKey(),
			},
			undefined,
			undefined,
			undefined,
			true
		);
		const logs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			fillTx
		);
		const events = parseLogs(builderClient.program, logs);
		assert(events[0].name === 'OrderActionRecord');
		const fillQuoteAssetAmount = events[0].data['quoteAssetAmountFilled'] as BN;
		const builderFee = events[0].data['builderFee'];
		const takerFee = events[0].data['takerFee'] as BN;
		const totalFeePaid = takerFee;
		const referrerReward = new BN(events[0].data['referrerReward'] as number);
		assert(builderFee == null);
		assert(referrerReward.gt(ZERO));

		await user2Client.fetchAccounts();
		userOrders = user2Client.getUser().getOpenOrders();
		assert(userOrders.length === 2);

		await bankrunContextWrapper.moveTimeForward(100);

		// cancel remaining orders
		await user2Client.cancelOrders();
		await user2Client.fetchAccounts();

		userOrders = user2Client.getUser().getOpenOrders();
		assert(userOrders.length === 0);

		const perpPos = user2Client.getUser().getPerpPosition(0);
		assert(
			perpPos.quoteAssetAmount.eq(fillQuoteAssetAmount.add(totalFeePaid).neg())
		);

		await builderClient.fetchAccounts();
		let usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcBeforeSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);

		await builderClient.fetchAccounts();
		usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcAfterSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);
		assert(builderUsdcAfterSettle.eq(builderUsdcBeforeSettle));
	});

	it('user can place and fill order with builder', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// approve builder again
		const builder = builderClient.wallet;
		const maxFeeBps = 150; // 1.5%
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			true // update existing builder
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));

		// Should fail if we try first without encoding properly

		let userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 0);

		const builderFeeBps = 7;
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: {
				triggerPrice: new BN(235).mul(PRICE_PRECISION),
				baseAssetAmount: takerOrderParams.baseAssetAmount,
			},
			stopLossOrderParams: {
				triggerPrice: new BN(220).mul(PRICE_PRECISION),
				baseAssetAmount: takerOrderParams.baseAssetAmount,
			},
			builderIdx: 0,
			builderFeeBps: builderFeeBps,
		};

		const signedOrderParams = userClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage,
			false
		);

		await builderClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			marketIndex,
			{
				taker: await userClient.getUserAccountPublicKey(),
				takerUserAccount: userClient.getUserAccount(),
				takerStats: userClient.getUserStatsAccountPublicKey(),
				signingAuthority: userClient.wallet.publicKey,
			},
			undefined,
			2
		);

		await userClient.fetchAccounts();

		// try to revoke builder with open orders
		try {
			await userClient.changeApprovedBuilder(
				userClient.wallet.publicKey,
				builder.publicKey,
				0,
				false // remove
			);
			assert(
				false,
				'should throw error when revoking builder with open orders'
			);
		} catch (e) {
			assert(e.message.includes('0x18b6'));
		}

		userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 3);
		assert(userOrders[0].orderId === 1);
		assert(userOrders[0].reduceOnly === true);
		assert(hasBuilder(userOrders[0]) === true);
		assert(userOrders[1].orderId === 2);
		assert(userOrders[1].reduceOnly === true);
		assert(hasBuilder(userOrders[1]) === true);
		assert(userOrders[2].orderId === 3);
		assert(userOrders[2].reduceOnly === false);
		assert(hasBuilder(userOrders[2]) === true);

		await builderEscrowMap.slowSync();
		let builderEscrow = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;

		// check the corresponding revShareEscrow orders are added
		for (let i = 0; i < userOrders.length; i++) {
			assert(builderEscrow.orders[i]!.builderIdx === 0);
			assert(builderEscrow.orders[i]!.feesAccrued.eq(ZERO));
			assert(builderEscrow.orders[i]!.feeBps === builderFeeBps);
			assert(
				builderEscrow.orders[i]!.orderId === i + 1,
				`orderId ${i} is ${builderEscrow.orders[i]!.orderId}`
			);
			assert(isVariant(builderEscrow.orders[i]!.marketType, 'perp'));
			assert(builderEscrow.orders[i]!.marketIndex === marketIndex);
		}

		assert(
			builderEscrow.approvedBuilders[0]!.authority.equals(builder.publicKey)
		);
		assert(builderEscrow.approvedBuilders[0]!.maxFeeBps === maxFeeBps);

		await userClient.fetchAccounts();

		// fill order with vamm
		await builderClient.fetchAccounts();
		const fillTx = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{
				marketIndex,
				orderId: 3,
			},
			undefined,
			{
				referrer: await builderClient.getUserAccountPublicKey(),
				referrerStats: builderClient.getUserStatsAccountPublicKey(),
			},
			undefined,
			undefined,
			undefined,
			true
		);
		const logs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			fillTx
		);
		const events = parseLogs(builderClient.program, logs);
		assert(events[0].name === 'OrderActionRecord');
		const fillQuoteAssetAmount = events[0].data['quoteAssetAmountFilled'] as BN;
		const builderFee = events[0].data['builderFee'] as BN;
		const takerFee = events[0].data['takerFee'] as BN;
		const totalFeePaid = takerFee.add(builderFee);
		const referrerReward = events[0].data['referrerReward'] as number;
		assert(builderFee.eq(fillQuoteAssetAmount.muln(builderFeeBps).divn(10000)));

		await userClient.fetchAccounts();
		userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 2);

		await bankrunContextWrapper.moveTimeForward(100);

		await builderEscrowMap.slowSync();
		builderEscrow = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		assert(builderEscrow.orders[2].orderId === 3);
		assert(builderEscrow.orders[2].feesAccrued.gt(ZERO));
		assert(isBuilderOrderCompleted(builderEscrow.orders[2]));

		// cancel remaining orders
		await userClient.cancelOrders();
		await userClient.fetchAccounts();

		userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 0);

		const perpPos = userClient.getUser().getPerpPosition(0);
		assert(
			perpPos.quoteAssetAmount.eq(fillQuoteAssetAmount.add(totalFeePaid).neg())
		);

		await builderEscrowMap.slowSync();
		builderEscrow = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		assert(builderEscrow.orders[2].bitFlags === 3);
		assert(builderEscrow.orders[2].feesAccrued.eq(builderFee));

		await builderClient.fetchAccounts();
		let usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcBeforeSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);

		const settleTx = await builderClient.settlePNL(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			builderEscrowMap
		);

		const settleLogs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			settleTx
		);
		const settleEvents = parseLogs(builderClient.program, settleLogs);
		const builderSettleEvents = settleEvents
			.filter((e) => e.name === 'BuilderSettleRecord')
			.map((e) => e.data) as BuilderSettleRecord[];
		assert(builderSettleEvents.length === 2);
		assert(builderSettleEvents[0].builder.equals(builder.publicKey));
		assert(builderSettleEvents[0].referrer == null);
		assert(builderSettleEvents[0].feeSettled.eq(builderFee));
		assert(builderSettleEvents[0].marketIndex === marketIndex);
		assert(isVariant(builderSettleEvents[0].marketType, 'perp'));
		assert(builderSettleEvents[0].builderTotalReferrerRewards.eq(ZERO));
		assert(builderSettleEvents[0].builderTotalBuilderRewards.eq(builderFee));

		assert(builderSettleEvents[1].builder === null);
		assert(builderSettleEvents[1].referrer.equals(builder.publicKey));
		assert(builderSettleEvents[1].feeSettled.eq(new BN(referrerReward)));
		assert(builderSettleEvents[1].marketIndex === marketIndex);
		assert(isVariant(builderSettleEvents[1].marketType, 'spot'));
		assert(
			builderSettleEvents[1].builderTotalReferrerRewards.eq(
				new BN(referrerReward)
			)
		);
		assert(builderSettleEvents[1].builderTotalBuilderRewards.eq(builderFee));

		await builderEscrowMap.slowSync();
		builderEscrow = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		for (const order of builderEscrow.orders) {
			assert(order.feesAccrued.eq(ZERO));
		}

		await builderClient.fetchAccounts();
		usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcAfterSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);
		assert(
			builderUsdcAfterSettle
				.sub(builderUsdcBeforeSettle)
				.sub(new BN(referrerReward))
				.eq(builderFee)
		);
	});

	it('user can place and cancel with no fill (no fees accrued, escrow unchanged)', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150;
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			true
		);

		await builderEscrowMap.slowSync();
		const beforeEscrow = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		const beforeTotalFees = beforeEscrow.orders.reduce(
			(sum, o) => sum.add(o.feesAccrued ?? ZERO),
			ZERO
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 7,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const builderFeeBps = 5;
		const msg: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: orderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
			builderIdx: 0,
			builderFeeBps,
		};

		const signed = userClient.signSignedMsgOrderParamsMessage(msg, false);
		await builderClient.placeSignedMsgTakerOrder(
			signed,
			marketIndex,
			{
				taker: await userClient.getUserAccountPublicKey(),
				takerUserAccount: userClient.getUserAccount(),
				takerStats: userClient.getUserStatsAccountPublicKey(),
				signingAuthority: userClient.wallet.publicKey,
			},
			undefined,
			2
		);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();
		assert(userClient.getUser().getOpenOrders().length === 0);

		await builderEscrowMap.slowSync();
		const afterEscrow = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		const afterTotalFees = afterEscrow.orders.reduce(
			(sum, o) => sum.add(o.feesAccrued ?? ZERO),
			ZERO
		);
		assert(afterTotalFees.eq(beforeTotalFees));
	});

	it('user can place and fill multiple orders (fees accumulate and settle)', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150;
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			true
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;

		function buildMsg(userOrderId: number, feeBps: number, slot: BN) {
			const params = getMarketOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				price: new BN(230).mul(PRICE_PRECISION),
				auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
				auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
				auctionDuration: 10,
				userOrderId,
				postOnly: PostOnlyParams.NONE,
				marketType: MarketType.PERP,
			}) as OrderParams;
			return {
				signedMsgOrderParams: params,
				subAccountId: 0,
				slot,
				uuid: Uint8Array.from(Buffer.from(nanoid(8))),
				builderIdx: 0,
				builderFeeBps: feeBps,
				takeProfitOrderParams: null,
				stopLossOrderParams: null,
			} as SignedMsgOrderParamsMessage;
		}

		await builderEscrowMap.slowSync();
		const escrowStart = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		const totalFeesInEscrowStart = escrowStart.orders.reduce(
			(sum, o) => sum.add(o.feesAccrued ?? ZERO),
			ZERO
		);

		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const feeBpsA = 6;
		const feeBpsB = 9;

		const signedA = userClient.signSignedMsgOrderParamsMessage(
			buildMsg(10, feeBpsA, slot),
			false
		);
		await builderClient.placeSignedMsgTakerOrder(
			signedA,
			marketIndex,
			{
				taker: await userClient.getUserAccountPublicKey(),
				takerUserAccount: userClient.getUserAccount(),
				takerStats: userClient.getUserStatsAccountPublicKey(),
				signingAuthority: userClient.wallet.publicKey,
			},
			undefined,
			2
		);
		await userClient.fetchAccounts();

		const signedB = userClient.signSignedMsgOrderParamsMessage(
			buildMsg(11, feeBpsB, slot),
			false
		);
		await builderClient.placeSignedMsgTakerOrder(
			signedB,
			marketIndex,
			{
				taker: await userClient.getUserAccountPublicKey(),
				takerUserAccount: userClient.getUserAccount(),
				takerStats: userClient.getUserStatsAccountPublicKey(),
				signingAuthority: userClient.wallet.publicKey,
			},
			undefined,
			2
		);
		await userClient.fetchAccounts();

		const userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 2);

		// Fill both orders
		const fillTxA = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId: userOrders[0].orderId },
			undefined,
			{
				referrer: await builderClient.getUserAccountPublicKey(),
				referrerStats: builderClient.getUserStatsAccountPublicKey(),
			},
			undefined,
			undefined,
			undefined,
			true
		);
		const logsA = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			fillTxA
		);
		const eventsA = parseLogs(builderClient.program, logsA);
		const fillEventA = eventsA.find((e) => e.name === 'OrderActionRecord');
		assert(fillEventA !== undefined);
		const builderFeeA = fillEventA.data['builderFee'] as BN;
		const referrerRewardA = new BN(fillEventA.data['referrerReward'] as number);

		const fillTxB = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId: userOrders[1].orderId },
			undefined,
			{
				referrer: await builderClient.getUserAccountPublicKey(),
				referrerStats: builderClient.getUserStatsAccountPublicKey(),
			},
			undefined,
			undefined,
			undefined,
			true
		);
		const logsB = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			fillTxB
		);
		const eventsB = parseLogs(builderClient.program, logsB);
		const fillEventB = eventsB.find((e) => e.name === 'OrderActionRecord');
		assert(fillEventB !== undefined);
		const builderFeeB = fillEventB.data['builderFee'] as BN;
		const referrerRewardB = new BN(fillEventB.data['referrerReward'] as number);

		await bankrunContextWrapper.moveTimeForward(100);

		await builderEscrowMap.slowSync();
		const escrowAfterFills = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		const totalFeesAccrued = escrowAfterFills.orders.reduce(
			(sum, o) => sum.add(o.feesAccrued ?? ZERO),
			ZERO
		);
		const expectedTotal = builderFeeA
			.add(builderFeeB)
			.add(referrerRewardA)
			.add(referrerRewardB);
		assert(
			totalFeesAccrued.sub(totalFeesInEscrowStart).eq(expectedTotal),
			`totalFeesAccrued: ${totalFeesAccrued.toString()}, expectedTotal: ${expectedTotal.toString()}`
		);

		// Settle and verify fees swept to builder
		await builderClient.fetchAccounts();
		let usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcBefore = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);

		await builderClient.settlePNL(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			builderEscrowMap
		);

		await builderEscrowMap.slowSync();
		const escrowAfterSettle = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		for (const order of escrowAfterSettle.orders) {
			assert(order.feesAccrued.eq(ZERO));
		}

		await builderClient.fetchAccounts();
		usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcAfter = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);
		const usdcDiff = builderUsdcAfter.sub(builderUsdcBefore);
		assert(
			usdcDiff.eq(expectedTotal),
			`usdcDiff: ${usdcDiff.toString()}, expectedTotal: ${expectedTotal.toString()}`
		);
	});

	it('user can place and fill with multiple maker orders', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150;
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			true
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;

		function buildMsg(userOrderId: number, feeBps: number, slot: BN) {
			const params = getMarketOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				price: new BN(230).mul(PRICE_PRECISION),
				auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
				auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
				auctionDuration: 10,
				userOrderId,
				postOnly: PostOnlyParams.NONE,
				marketType: MarketType.PERP,
			}) as OrderParams;
			return {
				signedMsgOrderParams: params,
				subAccountId: 0,
				slot,
				uuid: Uint8Array.from(Buffer.from(nanoid(8))),
				builderIdx: 0,
				builderFeeBps: feeBps,
				takeProfitOrderParams: null,
				stopLossOrderParams: null,
			} as SignedMsgOrderParamsMessage;
		}

		// place maker orders
		await makerClient.placeOrders([
			getLimitOrderParams({
				marketIndex: 0,
				baseAssetAmount: baseAssetAmount.divn(3),
				direction: PositionDirection.SHORT,
				price: new BN(223000000),
				marketType: MarketType.PERP,
				postOnly: PostOnlyParams.SLIDE,
			}) as OrderParams,
			getLimitOrderParams({
				marketIndex: 0,
				baseAssetAmount: baseAssetAmount.divn(3),
				direction: PositionDirection.SHORT,
				price: new BN(223500000),
				marketType: MarketType.PERP,
				postOnly: PostOnlyParams.SLIDE,
			}) as OrderParams,
		]);
		await makerClient.fetchAccounts();
		const makerOrders = makerClient.getUser().getOpenOrders();
		assert(makerOrders.length === 2);

		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const feeBpsA = 6;

		const signedA = userClient.signSignedMsgOrderParamsMessage(
			buildMsg(10, feeBpsA, slot),
			false
		);
		await builderClient.placeSignedMsgTakerOrder(
			signedA,
			marketIndex,
			{
				taker: await userClient.getUserAccountPublicKey(),
				takerUserAccount: userClient.getUserAccount(),
				takerStats: userClient.getUserStatsAccountPublicKey(),
				signingAuthority: userClient.wallet.publicKey,
			},
			undefined,
			2
		);
		await userClient.fetchAccounts();

		const userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 1);

		// Fill taker against maker orders
		const fillTxA = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId: userOrders[0].orderId },
			{
				maker: await makerClient.getUserAccountPublicKey(),
				makerStats: makerClient.getUserStatsAccountPublicKey(),
				makerUserAccount: makerClient.getUserAccount(),
				// order?: Order;
			},
			{
				referrer: await builderClient.getUserAccountPublicKey(),
				referrerStats: builderClient.getUserStatsAccountPublicKey(),
			},
			undefined,
			undefined,
			undefined,
			true
		);
		const logsA = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			fillTxA
		);
		const eventsA = parseLogs(builderClient.program, logsA);
		const fillEventA = eventsA.filter((e) => e.name === 'OrderActionRecord');
		assert(fillEventA !== undefined);
		const builderFeeA = fillEventA.reduce(
			(sum, e) => sum.add(e.data['builderFee'] as BN),
			ZERO
		);
		const referrerRewardA = fillEventA.reduce(
			(sum, e) => sum.add(new BN(e.data['referrerReward'] as number)),
			ZERO
		);

		await bankrunContextWrapper.moveTimeForward(100);

		await builderEscrowMap.slowSync();
		const escrowAfterFills = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		const totalFeesAccrued = escrowAfterFills.orders
			.filter((o) => !isBuilderOrderReferral(o))
			.reduce((sum, o) => sum.add(o.feesAccrued ?? ZERO), ZERO);
		assert(
			totalFeesAccrued.eq(builderFeeA),
			`totalFeesAccrued: ${totalFeesAccrued.toString()}, builderFeeA: ${builderFeeA.toString()}`
		);

		// Settle and verify fees swept to builder
		await builderClient.fetchAccounts();
		let usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcBefore = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);

		const settleTx = await builderClient.settlePNL(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			builderEscrowMap
		);
		await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			settleTx
		);

		await builderEscrowMap.slowSync();
		const escrowAfterSettle = (await builderEscrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as BuilderEscrow;
		for (const order of escrowAfterSettle.orders) {
			assert(order.feesAccrued.eq(ZERO));
		}

		await builderClient.fetchAccounts();
		usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcAfter = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);
		assert(
			builderUsdcAfter
				.sub(builderUsdcBefore)
				.eq(builderFeeA.add(referrerRewardA))
		);

		const builderAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getBuilderAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);
		const builderAcc: BuilderAccount =
			builderClient.program.account.builder.coder.accounts.decodeUnchecked(
				'Builder',
				builderAccountInfo.data
			);
		assert(
			builderAcc.authority.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);
	});
});
