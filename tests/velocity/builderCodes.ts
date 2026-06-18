import * as anchor from '@coral-xyz/anchor';

import { Program } from '@coral-xyz/anchor';

import {
	AccountInfo,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Transaction,
} from '@solana/web3.js';

import {
	TestClient,
	OracleSource,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	PTYH_LAZER_PROGRAM_ID,
	assert,
	getRevenueShareAccountPublicKey,
	getRevenueShareEscrowAccountPublicKey,
	RevenueShareAccount,
	RevenueShareEscrowAccount,
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
	RevenueShareEscrowMap,
	getTokenAmount,
	RevenueShareSettleRecord,
	getLimitOrderParams,
	SignedMsgOrderParamsMessage,
	QUOTE_PRECISION,
	SettlePnlMode,
	UserStatsAccount,
} from '../../packages/sdk/src';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { PYTH_STORAGE_DATA } from './pythLazerData';
import { nanoid } from 'nanoid';
import {
	isBuilderOrderCompleted,
	isBuilderOrderReferral,
	isBuilderReferral,
} from '../../packages/sdk/src/math/builder';
import { createTransferInstruction } from '@solana/spl-token';

dotenv.config();

const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

function buildMsg(
	marketIndex: number,
	baseAssetAmount: BN,
	userOrderId: number,
	feeBps: number,
	slot: BN
) {
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
		builderFeeTenthBps: feeBps,
		takeProfitOrderParams: null,
		stopLossOrderParams: null,
	} as SignedMsgOrderParamsMessage;
}

// the TestClients in this suite don't subscribe to UserStats, so fetch + decode
// the account directly when a test needs referrer_status
async function fetchUserStats(
	client: TestClient,
	ctx: BankrunContextWrapper
): Promise<UserStatsAccount> {
	const info = await ctx.connection.getAccountInfo(
		client.getUserStatsAccountPublicKey()
	);
	return client.program.account.userStats.coder.accounts.decodeUnchecked(
		'userStats',
		info.data
	) as UserStatsAccount;
}

describe('builder codes', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let usdcMint: Keypair;

	let builderClient: TestClient;
	let builderUSDCAccount: Keypair = null;

	let makerClient: TestClient;
	let makerUSDCAccount: PublicKey = null;

	let userUSDCAccount: PublicKey = null;
	let userClient: TestClient;

	// user without RevenueShareEscrow
	let user2USDCAccount: PublicKey = null;
	let user2Client: TestClient;

	let escrowMap: RevenueShareEscrowMap;
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

		solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			84,
			-7,
			undefined,
			10000
		);
		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		marketIndexes = [0, 1];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }];

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

		await builderClient.updateFeatureBitFlagsBuilderCodes(true);
		// await builderClient.updateFeatureBitFlagsBuilderReferral(true);

		await initializeQuoteSpotMarket(builderClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await builderClient.initializePerpMarket(
			0,
			solUsd,
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			periodicity,
			new BN(84 * PEG_PRECISION.toNumber())
		);
		await builderClient.initializePerpMarket(
			1,
			solUsd,
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			periodicity,
			new BN(84 * PEG_PRECISION.toNumber())
		);
		builderUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.add(new BN(1e9).mul(QUOTE_PRECISION)),
			bankrunContextWrapper,
			builderClient.wallet.publicKey
		);
		await builderClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			builderUSDCAccount.publicKey
		);

		// top up pnl pool for mkt 0 and mkt 1
		const spotMarket = builderClient.getSpotMarketAccount(0);
		const pnlPoolTopupAmount = new BN(500).mul(QUOTE_PRECISION);

		const transferIx0 = createTransferInstruction(
			builderUSDCAccount.publicKey,
			spotMarket.vault,
			builderClient.wallet.publicKey,
			pnlPoolTopupAmount.toNumber()
		);
		const tx0 = new Transaction().add(transferIx0);
		tx0.recentBlockhash = (
			await bankrunContextWrapper.connection.getLatestBlockhash()
		).blockhash;
		tx0.sign(builderClient.wallet.payer);
		await bankrunContextWrapper.connection.sendTransaction(tx0);

		// top up pnl pool for mkt 1
		const transferIx1 = createTransferInstruction(
			builderUSDCAccount.publicKey,
			spotMarket.vault,
			builderClient.wallet.publicKey,
			pnlPoolTopupAmount.toNumber()
		);
		const tx1 = new Transaction().add(transferIx1);
		tx1.recentBlockhash = (
			await bankrunContextWrapper.connection.getLatestBlockhash()
		).blockhash;
		tx1.sign(builderClient.wallet.payer);
		await bankrunContextWrapper.connection.sendTransaction(tx1);

		await builderClient.updatePerpMarketPnlPool(0, pnlPoolTopupAmount);
		await builderClient.updatePerpMarketPnlPool(1, pnlPoolTopupAmount);

		// await builderClient.depositIntoPerpMarketFeePool(
		// 	0,
		// 	new BN(1e6).mul(QUOTE_PRECISION),
		// 	builderUSDCAccount.publicKey
		// );

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

		escrowMap = new RevenueShareEscrowMap(userClient, false);
	});

	after(async () => {
		await builderClient.unsubscribe();
		await userClient.unsubscribe();
		await user2Client.unsubscribe();
		await makerClient.unsubscribe();
	});

	it('builder can create builder', async () => {
		await builderClient.initializeRevenueShare(builderClient.wallet.publicKey);

		const builderAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);

		const builderAcc: RevenueShareAccount =
			builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				builderAccountInfo.data
			);
		assert(
			builderAcc.authority.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);
		assert(builderAcc.totalBuilderRewards.toNumber() === 0);
		assert(builderAcc.totalReferrerRewards.toNumber() === 0);
	});

	it('user can initialize a RevenueShareEscrow', async () => {
		const numOrders = 2;

		// Test the instruction creation
		const ix = await userClient.getInitializeRevenueShareEscrowIx(
			userClient.wallet.publicKey,
			numOrders
		);

		assert(ix !== null, 'Instruction should be created');
		assert(ix.programId.toBase58() === userClient.program.programId.toBase58());

		// Test the full transaction
		await userClient.initializeRevenueShareEscrow(
			userClient.wallet.publicKey,
			numOrders
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		assert(accountInfo !== null, 'RevenueShareEscrow account should exist');
		assert(
			accountInfo.owner.toBase58() === userClient.program.programId.toBase58()
		);

		const revShareEscrow: RevenueShareEscrowAccount =
			builderClient.program.coder.accounts.decodeUnchecked(
				'revenueShareEscrow',
				accountInfo.data
			);
		assert(
			revShareEscrow.authority.toBase58() ===
				userClient.wallet.publicKey.toBase58()
		);
		// assert(
		// 	revShareEscrow.referrer.toBase58() ===
		// 		builderClient.wallet.publicKey.toBase58()
		// );
		assert(revShareEscrow.orders.length === numOrders);
		assert(revShareEscrow.approvedBuilders.length === 0);
	});

	it('user can resize RevenueShareEscrow account', async () => {
		const newNumOrders = 10;

		// Test the instruction creation
		const ix = await userClient.getResizeRevenueShareEscrowOrdersIx(
			userClient.wallet.publicKey,
			newNumOrders
		);

		assert(ix !== null, 'Instruction should be created');
		assert(ix.programId.toBase58() === userClient.program.programId.toBase58());

		// Test the full transaction
		await userClient.resizeRevenueShareEscrowOrders(
			userClient.wallet.publicKey,
			newNumOrders
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		assert(
			accountInfo !== null,
			'RevenueShareEscrow account should exist after resize'
		);
		assert(
			accountInfo.owner.toBase58() === userClient.program.programId.toBase58()
		);

		const revShareEscrow: RevenueShareEscrowAccount =
			builderClient.program.coder.accounts.decodeUnchecked(
				'revenueShareEscrow',
				accountInfo.data
			);
		assert(
			revShareEscrow.authority.toBase58() ===
				userClient.wallet.publicKey.toBase58()
		);
		// assert(
		// 	revShareEscrow.referrer.toBase58() ===
		// 		builderClient.wallet.publicKey.toBase58()
		// );
		assert(revShareEscrow.orders.length === newNumOrders);
	});

	it('user can add/update/remove approved builder from RevenueShareEscrow', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10; // 1.5%

		// First add a builder
		await userClient.changeApprovedBuilder(
			builder.publicKey,
			maxFeeBps,
			true // add
		);

		// Verify the builder was added
		let accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		let revShareEscrow: RevenueShareEscrowAccount =
			userClient.program.coder.accounts.decodeUnchecked(
				'revenueShareEscrow',
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
			addedBuilder.maxFeeTenthBps === maxFeeBps,
			'Builder should have correct max fee bps before removal'
		);

		// update the user fee
		await userClient.changeApprovedBuilder(
			builder.publicKey,
			maxFeeBps * 2,
			true // update existing builder
		);

		// Verify the builder was updated
		accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		revShareEscrow = userClient.program.coder.accounts.decodeUnchecked(
			'revenueShareEscrow',
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
			updatedBuilder.maxFeeTenthBps === maxFeeBps * 2,
			'Builder should have correct max fee bps after update'
		);

		// Now remove the builder
		await userClient.changeApprovedBuilder(
			builder.publicKey,
			maxFeeBps,
			false // remove
		);

		// Verify the builder was removed
		accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		revShareEscrow = userClient.program.coder.accounts.decodeUnchecked(
			'revenueShareEscrow',
			accountInfo.data
		);
		const removedBuilder = revShareEscrow.approvedBuilders.find(
			(b) => b.authority.toBase58() === builder.publicKey.toBase58()
		);
		assert(
			removedBuilder.maxFeeTenthBps === 0,
			'Builder should have 0 max fee bps after removal'
		);
	});

	it('user with no RevenueShareEscrow can place and fill order with no builder', async () => {
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
			builderFeeTenthBps: null,
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
		const orderActionRecords = events.filter(
			(e) => e.name === 'orderActionRecord'
		);
		assert(orderActionRecords.length > 0);
		const fillEvent = orderActionRecords[orderActionRecords.length - 1];
		const fillQuoteAssetAmount = fillEvent.data['quoteAssetAmountFilled'] as BN;
		const builderFee = fillEvent.data['builderFee'] as BN | null;
		const takerFee = fillEvent.data['takerFee'] as BN;
		const totalFeePaid = takerFee;
		// referrerReward is an Option<u32> on-chain and is emitted as null when 0.
		const referrerReward = new BN(
			(fillEvent.data['referrerReward'] as number | null) ?? 0
		);
		assert(builderFee === null);
		// user2 has no RevenueShareEscrow, so no referral reward accrues (the
		// on-chain legacy referral path was removed; rewards flow only through an
		// escrow now).
		assert(referrerReward.eq(ZERO));

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
		const maxFeeBps = 150 * 10; // 1.5%
		await userClient.changeApprovedBuilder(
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

		const builderFeeBps = 7 * 10;
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
			builderFeeTenthBps: builderFeeBps,
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
				builder.publicKey,
				0,
				false // remove
			);
			console.log("didn't throw error on revoke builder with open orders");
			assert(
				false,
				'should throw error when revoking builder with open orders'
			);
		} catch (e) {
			assert(e.message.includes('0x18b3')); // CannotRevokeBuilderWithOpenOrders
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

		await escrowMap.slowSync();
		let escrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;

		// check the corresponding revShareEscrow orders are added
		for (let i = 0; i < userOrders.length; i++) {
			assert(escrow.orders[i]!.builderIdx === 0);
			assert(escrow.orders[i]!.feesAccrued.eq(ZERO));
			assert(
				escrow.orders[i]!.feeTenthBps === builderFeeBps,
				`builderFeeBps ${escrow.orders[i]!.feeTenthBps} !== ${builderFeeBps}`
			);
			assert(
				escrow.orders[i]!.orderId === i + 1,
				`orderId ${i} is ${escrow.orders[i]!.orderId}`
			);
			assert(isVariant(escrow.orders[i]!.marketType, 'perp'));
			assert(escrow.orders[i]!.marketIndex === marketIndex);
		}

		assert(escrow.approvedBuilders[0]!.authority.equals(builder.publicKey));
		assert(escrow.approvedBuilders[0]!.maxFeeTenthBps === maxFeeBps);

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
		const orderActionRecords = events.filter(
			(e) => e.name === 'orderActionRecord'
		);
		assert(orderActionRecords.length > 0);
		const fillEvent = orderActionRecords[orderActionRecords.length - 1];
		const fillQuoteAssetAmount = fillEvent.data['quoteAssetAmountFilled'] as BN;
		const builderFee = fillEvent.data['builderFee'] as BN;
		const takerFee = fillEvent.data['takerFee'] as BN;
		// referrerReward is an Option<u32> on-chain, emitted as null when 0. userClient
		// has a RevenueShareEscrow and is referred by the builder, so this accrues.
		const referrerReward = new BN(
			(fillEvent.data['referrerReward'] as number | null) ?? 0
		);
		assert(referrerReward.gt(ZERO));
		assert(
			builderFee.eq(fillQuoteAssetAmount.muln(builderFeeBps).divn(100000))
		);

		await userClient.fetchAccounts();
		userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 2);

		const pos = userClient.getUser().getPerpPosition(0);
		const takerOrderCumulativeQuoteAssetAmountFilled = fillEvent.data[
			'takerOrderCumulativeQuoteAssetAmountFilled'
		] as BN;
		assert(
			pos.quoteEntryAmount.abs().eq(takerOrderCumulativeQuoteAssetAmountFilled),
			`pos.quoteEntryAmount ${pos.quoteEntryAmount.toNumber()} !== takerOrderCumulativeQuoteAssetAmountFilled ${takerOrderCumulativeQuoteAssetAmountFilled.toNumber()}`
		);

		const builderFeePaidBps =
			(builderFee.toNumber() / Math.abs(pos.quoteEntryAmount.toNumber())) *
			10_000;
		assert(
			Math.round(builderFeePaidBps) === builderFeeBps / 10,
			`builderFeePaidBps ${builderFeePaidBps} !== builderFeeBps ${
				builderFeeBps / 10
			}`
		);

		// expect 9.5 bps (taker fee - discount) + 7 bps (builder fee)
		const takerFeePaidBps =
			(takerFee.toNumber() / Math.abs(pos.quoteEntryAmount.toNumber())) *
			10_000;
		assert(
			Math.round(takerFeePaidBps * 10) === 165,
			`takerFeePaidBps ${takerFeePaidBps} !== 16.5 bps`
		);

		await bankrunContextWrapper.moveTimeForward(100);

		await escrowMap.slowSync();
		escrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		assert(escrow.orders[2].orderId === 3);
		assert(escrow.orders[2].feesAccrued.gt(ZERO));
		assert(isBuilderOrderCompleted(escrow.orders[2]));

		// cancel remaining orders
		await userClient.cancelOrders();
		await userClient.fetchAccounts();

		userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 0);

		const perpPos = userClient.getUser().getPerpPosition(0);
		assert(
			perpPos.quoteAssetAmount.eq(fillQuoteAssetAmount.add(takerFee).neg())
		);

		await escrowMap.slowSync();
		escrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		assert(escrow.orders[2].bitFlags === 3);
		assert(escrow.orders[2].feesAccrued.eq(builderFee));

		await builderClient.fetchAccounts();
		let usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcBeforeSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);

		await userClient.fetchAccounts();
		const settleTx = await builderClient.settlePNL(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			escrowMap
		);

		const settleLogs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			settleTx
		);
		const settleEvents = parseLogs(builderClient.program, settleLogs);
		const builderSettleEvents = settleEvents
			.filter((e) => e.name === 'revenueShareSettleRecord')
			.map((e) => e.data) as RevenueShareSettleRecord[];

		// userClient both pays a builder fee and is referred by the builder, so the
		// settle sweeps two records: a builder-fee record and a referral-reward
		// record (both crediting the same authority, the builder).
		const builderRecord = builderSettleEvents.find((e) => e.builder != null);
		const referrerRecord = builderSettleEvents.find((e) => e.referrer != null);
		assert(builderSettleEvents.length === 2);

		assert(builderRecord !== undefined);
		assert(builderRecord.builder.equals(builder.publicKey));
		assert(builderRecord.referrer == null);
		assert(builderRecord.feeSettled.eq(builderFee));
		assert(builderRecord.marketIndex === marketIndex);
		assert(isVariant(builderRecord.marketType, 'perp'));
		assert(builderRecord.builderTotalBuilderRewards.eq(builderFee));

		assert(referrerRecord !== undefined);
		assert(referrerRecord.builder == null);
		assert(referrerRecord.referrer.equals(builder.publicKey));
		assert(referrerRecord.feeSettled.eq(referrerReward));
		assert(referrerRecord.marketIndex === marketIndex);
		assert(isVariant(referrerRecord.marketType, 'perp'));
		assert(referrerRecord.builderTotalReferrerRewards.eq(referrerReward));

		await escrowMap.slowSync();
		escrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		for (const order of escrow.orders) {
			assert(order.feesAccrued.eq(ZERO));
		}

		await builderClient.fetchAccounts();
		usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcAfterSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);

		// The builder is also the referrer here, so its USDC balance grew by the
		// builder fee plus the referral reward; back out the referral reward to
		// isolate the builder fee.
		const finalBuilderFee = builderUsdcAfterSettle
			.sub(builderUsdcBeforeSettle)
			.sub(referrerReward);
		assert(
			finalBuilderFee.eq(builderFee),
			`finalBuilderFee ${finalBuilderFee.toString()} !== builderFee ${builderFee.toString()}`
		);
	});

	it('user can place and cancel with no fill (no fees accrued, escrow unchanged)', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10;
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		await escrowMap.slowSync();
		const beforeEscrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
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
			builderFeeTenthBps: builderFeeBps,
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

		await escrowMap.slowSync();
		const afterEscrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const afterTotalFees = afterEscrow.orders.reduce(
			(sum, o) => sum.add(o.feesAccrued ?? ZERO),
			ZERO
		);
		assert(afterTotalFees.eq(beforeTotalFees));
	});

	it('user can place and fill multiple orders (fees accumulate and settle)', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10;
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;

		await escrowMap.slowSync();
		const escrowStart = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
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
			buildMsg(marketIndex, baseAssetAmount, 10, feeBpsA, slot),
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
			buildMsg(marketIndex, baseAssetAmount, 11, feeBpsB, slot),
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
		const fillEventA = eventsA.find((e) => e.name === 'orderActionRecord');
		assert(fillEventA !== undefined);
		const builderFeeA = fillEventA.data['builderFee'] as BN;
		const referrerRewardA = new BN(
			(fillEventA.data['referrerReward'] as number | null) ?? 0
		);

		const fillTxB = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId: userOrders[1].orderId },
			undefined,
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
		const fillEventB = eventsB.find((e) => e.name === 'orderActionRecord');
		assert(fillEventB !== undefined);
		const builderFeeB = fillEventB.data['builderFee'] as BN;
		const referrerRewardB = new BN(
			(fillEventB.data['referrerReward'] as number | null) ?? 0
		);

		await bankrunContextWrapper.moveTimeForward(100);

		await escrowMap.slowSync();
		const escrowAfterFills = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const totalFeesAccrued = escrowAfterFills.orders.reduce(
			(sum, o) => sum.add(o.feesAccrued ?? ZERO),
			ZERO
		);
		// userClient has an escrow and is referred by the builder, so each fill
		// accrues both a builder fee and a referral reward into the escrow.
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

		await userClient.fetchAccounts();
		await builderClient.settlePNL(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			escrowMap
		);

		await escrowMap.slowSync();
		const escrowAfterSettle = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
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
		const maxFeeBps = 150 * 10;
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		const builderAccountInfoBefore =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);
		const builderAccBefore: RevenueShareAccount =
			builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				builderAccountInfoBefore.data
			);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;

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
			buildMsg(marketIndex, baseAssetAmount, 10, feeBpsA, slot),
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
		const fillEventA = eventsA.filter((e) => e.name === 'orderActionRecord');
		assert(fillEventA !== undefined);
		const builderFeeA = fillEventA.reduce(
			(sum, e) => sum.add(e.data['builderFee'] as BN),
			ZERO
		);
		// userClient has an escrow and is referred by the builder, so referral
		// rewards accrue alongside the builder fee.
		const referrerRewardA = fillEventA.reduce(
			(sum, e) =>
				sum.add(new BN((e.data['referrerReward'] as number | null) ?? 0)),
			ZERO
		);

		await bankrunContextWrapper.moveTimeForward(100);

		await escrowMap.slowSync();
		const escrowAfterFills = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
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

		await userClient.fetchAccounts();
		const settleTx = await builderClient.settlePNL(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			escrowMap
		);
		await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			settleTx
		);

		await escrowMap.slowSync();
		const escrowAfterSettle = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
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
		// The builder is also the referrer, so its USDC grows by both the builder
		// fee and the referral reward.
		assert(
			builderUsdcAfter
				.sub(builderUsdcBefore)
				.eq(builderFeeA.add(referrerRewardA)),
			`builderUsdcAfter: ${builderUsdcAfter.toString()} !== builderUsdcBefore ${builderUsdcBefore.toString()} + builderFeeA ${builderFeeA.toString()} + referrerRewardA ${referrerRewardA.toString()}`
		);

		const builderAccountInfoAfter =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);
		const builderAccAfter: RevenueShareAccount =
			builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				builderAccountInfoAfter.data
			);
		assert(
			builderAccAfter.authority.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);

		const builderFeeChange = builderAccAfter.totalBuilderRewards.sub(
			builderAccBefore.totalBuilderRewards
		);
		assert(
			builderFeeChange.eq(builderFeeA),
			`builderFeeChange: ${builderFeeChange.toString()}, builderFeeA: ${builderFeeA.toString()}`
		);

		const referrerRewardChange = builderAccAfter.totalReferrerRewards.sub(
			builderAccBefore.totalReferrerRewards
		);
		assert(
			referrerRewardChange.eq(referrerRewardA),
			`referrerRewardChange: ${referrerRewardChange.toString()}, referrerRewardA: ${referrerRewardA.toString()}`
		);
	});

	it('can track referral rewards for 2 markets', async () => {
		// userClient is referred by the builder (builder == referrer here) and has
		// a RevenueShareEscrow, so each fill accrues a referral reward into a
		// Referral-flagged order slot for that market.
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10;
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		const builderAccountInfoBefore =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);
		const builderAccBefore: RevenueShareAccount =
			builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				builderAccountInfoBefore.data
			);

		// Capture any referral fees already accrued for these markets (earlier
		// tests share this user's escrow), so we can assert on the delta.
		await escrowMap.slowSync();
		const escrowBeforeFills = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const referralAccruedBefore = (marketIndex: number) =>
			escrowBeforeFills.orders
				.filter(
					(o) => o.marketIndex === marketIndex && isBuilderOrderReferral(o)
				)
				.reduce((sum, o) => sum.add(o.feesAccrued ?? ZERO), ZERO);
		const referralMarket0Before = referralAccruedBefore(0);
		const referralMarket1Before = referralAccruedBefore(1);

		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// place 2 orders in different markets
		const signedA = userClient.signSignedMsgOrderParamsMessage(
			buildMsg(0, BASE_PRECISION, 20, 5, slot),
			false
		);
		await builderClient.placeSignedMsgTakerOrder(
			signedA,
			0,
			{
				taker: await userClient.getUserAccountPublicKey(),
				takerUserAccount: userClient.getUserAccount(),
				takerStats: userClient.getUserStatsAccountPublicKey(),
				signingAuthority: userClient.wallet.publicKey,
			},
			undefined,
			2
		);

		const signedB = userClient.signSignedMsgOrderParamsMessage(
			buildMsg(1, BASE_PRECISION, 21, 5, slot),
			false
		);
		await builderClient.placeSignedMsgTakerOrder(
			signedB,
			1,
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
		const openOrders = userClient.getUser().getOpenOrders();

		const fillTxA = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{
				marketIndex: 0,
				orderId: openOrders.find(
					(o) => isVariant(o.status, 'open') && o.marketIndex === 0
				)!.orderId,
			},
			undefined,
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
		const fillsA = eventsA.filter((e) => e.name === 'orderActionRecord');
		assert(fillsA.length > 0);
		const fillAReferrerReward = fillsA[0]['data']['referrerReward'] as number;

		const fillTxB = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{
				marketIndex: 1,
				orderId: openOrders.find(
					(o) => isVariant(o.status, 'open') && o.marketIndex === 1
				)!.orderId,
			},
			undefined,
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
		const fillsB = eventsB.filter((e) => e.name === 'orderActionRecord');
		assert(fillsB.length > 0);
		const fillBReferrerReward = fillsB[0]['data']['referrerReward'] as number;

		await bankrunContextWrapper.moveTimeForward(100);

		await escrowMap.slowSync();
		const escrowAfterFills = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;

		const referrerOrdersMarket0 = escrowAfterFills.orders.filter(
			(o) => o.marketIndex === 0 && isBuilderOrderReferral(o)
		);
		const referrerOrdersMarket1 = escrowAfterFills.orders.filter(
			(o) => o.marketIndex === 1 && isBuilderOrderReferral(o)
		);
		// One referral order per market; its accrued fees grew by exactly this
		// test's fill reward.
		assert(referrerOrdersMarket0.length === 1);
		assert(referrerOrdersMarket0[0].marketIndex === 0);
		assert(
			referrerOrdersMarket0[0].feesAccrued
				.sub(referralMarket0Before)
				.eq(new BN(fillAReferrerReward))
		);
		assert(referrerOrdersMarket1.length === 1);
		assert(referrerOrdersMarket1[0].marketIndex === 1);
		assert(
			referrerOrdersMarket1[0].feesAccrued
				.sub(referralMarket1Before)
				.eq(new BN(fillBReferrerReward))
		);

		// Total referral fees sitting in the escrow for these markets, awaiting sweep.
		const referralMarket0Pending = referrerOrdersMarket0[0].feesAccrued;
		const referralMarket1Pending = referrerOrdersMarket1[0].feesAccrued;

		// Settle pnl across both markets; the escrowMap drives inclusion of the
		// referrer's User + RevenueShare accounts so the sweep can credit them.
		const settleTxA = await builderClient.settleMultiplePNLs(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			[0, 1],
			SettlePnlMode.MUST_SETTLE,
			escrowMap
		);
		await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			settleTxA
		);

		await escrowMap.slowSync();
		const escrowAfterSettle = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const referrerOrdersMarket0AfterSettle = escrowAfterSettle.orders.filter(
			(o) => o.marketIndex === 0 && isBuilderOrderReferral(o)
		);
		const referrerOrdersMarket1AfterSettle = escrowAfterSettle.orders.filter(
			(o) => o.marketIndex === 1 && isBuilderOrderReferral(o)
		);
		assert(referrerOrdersMarket0AfterSettle.length === 1);
		assert(referrerOrdersMarket1AfterSettle.length === 1);
		assert(referrerOrdersMarket0AfterSettle[0].feesAccrued.eq(ZERO));
		assert(referrerOrdersMarket1AfterSettle[0].feesAccrued.eq(ZERO));

		const builderAccountInfoAfter =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);
		const builderAccAfter: RevenueShareAccount =
			builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				builderAccountInfoAfter.data
			);
		const referrerRewards = builderAccAfter.totalReferrerRewards.sub(
			builderAccBefore.totalReferrerRewards
		);
		// The sweep credits the referrer with every pending referral fee for the
		// settled markets (including any accrued by earlier tests).
		const expectedReferrerRewards = referralMarket0Pending.add(
			referralMarket1Pending
		);
		assert(
			referrerRewards.eq(expectedReferrerRewards),
			`referrerRewards ${referrerRewards.toString()} !== ${expectedReferrerRewards.toString()}`
		);
	});

	it('user can place a NORMAL (non-swift) perp order with builder and fill it', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10; // 1.5%
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		// start from a clean slate of open orders
		await userClient.cancelOrders();
		await userClient.fetchAccounts();

		const marketIndex = 0;
		const builderFeeBps = 7 * 10; // 7 bps, in tenths
		const userOrderId = 51;
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
			builderIdx: 0,
			builderFeeTenthBps: builderFeeBps,
		}) as OrderParams;

		// place via the normal (non-swift) place_perp_order path
		await userClient.placePerpOrder(orderParams);
		await userClient.fetchAccounts();

		const placedOrder = userClient
			.getUser()
			.getOpenOrders()
			.find((o) => o.userOrderId === userOrderId);
		assert(placedOrder !== undefined);
		assert(hasBuilder(placedOrder) === true);
		const orderId = placedOrder.orderId;

		// the escrow should have a corresponding open builder order
		await escrowMap.slowSync();
		let escrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const escrowOrder = escrow.orders.find((o) => o.orderId === orderId);
		assert(escrowOrder !== undefined);
		assert(escrowOrder.builderIdx === 0);
		assert(escrowOrder.feeTenthBps === builderFeeBps);
		assert(isVariant(escrowOrder.marketType, 'perp'));
		assert(escrowOrder.marketIndex === marketIndex);
		assert(escrowOrder.feesAccrued.eq(ZERO));

		// fill the resting order against the vAMM via a keeper
		await builderClient.fetchAccounts();
		const fillTx = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId },
			undefined,
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
		const orderActionRecords = events.filter(
			(e) => e.name === 'orderActionRecord'
		);
		assert(orderActionRecords.length > 0);
		const fillEvent = orderActionRecords[orderActionRecords.length - 1];
		const fillQuoteAssetAmount = fillEvent.data['quoteAssetAmountFilled'] as BN;
		const builderFee = fillEvent.data['builderFee'] as BN;
		assert(
			builderFee.eq(fillQuoteAssetAmount.muln(builderFeeBps).divn(100000)),
			`builderFee ${builderFee.toString()} !== expected ${fillQuoteAssetAmount
				.muln(builderFeeBps)
				.divn(100000)
				.toString()}`
		);
		// userClient is referred by the builder, so a referral reward also accrues.
		const referrerReward = new BN(
			(fillEvent.data['referrerReward'] as number | null) ?? 0
		);

		await bankrunContextWrapper.moveTimeForward(100);

		await escrowMap.slowSync();
		escrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const filledEscrowOrder = escrow.orders.find((o) => o.orderId === orderId);
		assert(filledEscrowOrder !== undefined);
		assert(filledEscrowOrder.feesAccrued.eq(builderFee));

		// settle: the builder fee is swept to the builder
		await builderClient.fetchAccounts();
		let usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcBeforeSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);

		await userClient.fetchAccounts();
		const settleTx = await builderClient.settlePNL(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			escrowMap
		);
		const settleLogs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			settleTx
		);
		const settleEvents = parseLogs(builderClient.program, settleLogs);
		const builderSettleEvents = settleEvents
			.filter((e) => e.name === 'revenueShareSettleRecord')
			.map((e) => e.data) as RevenueShareSettleRecord[];
		const builderRecord = builderSettleEvents.find((e) => e.builder != null);
		assert(builderRecord !== undefined);
		assert(builderRecord.builder.equals(builder.publicKey));
		assert(builderRecord.feeSettled.eq(builderFee));
		assert(builderRecord.marketIndex === marketIndex);
		assert(isVariant(builderRecord.marketType, 'perp'));

		await builderClient.fetchAccounts();
		usdcPos = builderClient.getSpotPosition(0);
		const builderUsdcAfterSettle = getTokenAmount(
			usdcPos.scaledBalance,
			builderClient.getSpotMarketAccount(0),
			usdcPos.balanceType
		);
		// builder is also the referrer; back out the referral reward to isolate the builder fee
		const finalBuilderFee = builderUsdcAfterSettle
			.sub(builderUsdcBeforeSettle)
			.sub(referrerReward);
		assert(
			finalBuilderFee.eq(builderFee),
			`finalBuilderFee ${finalBuilderFee.toString()} !== builderFee ${builderFee.toString()}`
		);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();
	});

	it('fill of a builder order fails when the escrow account is omitted', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10; // 1.5%
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		// start from a clean slate of open orders
		await userClient.cancelOrders();
		await userClient.fetchAccounts();

		const marketIndex = 0;
		const builderFeeBps = 7 * 10; // 7 bps, in tenths
		const userOrderId = 61;
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
			builderIdx: 0,
			builderFeeTenthBps: builderFeeBps,
		}) as OrderParams;

		await userClient.placePerpOrder(orderParams);
		await userClient.fetchAccounts();

		const placedOrder = userClient
			.getUser()
			.getOpenOrders()
			.find((o) => o.userOrderId === userOrderId);
		assert(placedOrder !== undefined);
		assert(hasBuilder(placedOrder) === true);
		const orderId = placedOrder.orderId;

		// Build a fill ix the normal way (with the escrow appended) and then strip
		// the escrow remaining account, simulating a keeper trying to dodge the
		// builder fee by leaving the optional account out.
		const ix = await makerClient.getFillPerpOrderIx(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId },
			undefined,
			undefined,
			undefined,
			undefined,
			true
		);
		const escrowPk = getRevenueShareEscrowAccountPublicKey(
			makerClient.program.programId,
			userClient.wallet.publicKey
		);
		const keysBefore = ix.keys.length;
		ix.keys = ix.keys.filter((k) => !k.pubkey.equals(escrowPk));
		assert(
			ix.keys.length === keysBefore - 1,
			'escrow account should have been appended then stripped'
		);

		const tx = new Transaction().add(ix);
		tx.recentBlockhash = (
			await bankrunContextWrapper.connection.getLatestBlockhash()
		).blockhash;
		tx.feePayer = makerClient.wallet.publicKey;
		tx.sign(makerClient.wallet.payer);

		try {
			await bankrunContextWrapper.connection.sendTransaction(tx);
			assert(false, 'fill of builder order without escrow should fail');
		} catch (e) {
			assert(
				e.message.includes('0x18b4'), // UnableToLoadRevenueShareAccount
				`expected UnableToLoadRevenueShareAccount (0x18b4), got ${e.message}`
			);
		}

		// the order is untouched and remains fillable once the escrow is included
		await userClient.fetchAccounts();
		const stillOpen = userClient
			.getUser()
			.getOpenOrders()
			.find((o) => o.orderId === orderId);
		assert(
			stillOpen !== undefined,
			'order should remain open after the rejected fill'
		);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();
	});

	it('user can placeAndTake a NORMAL perp order with builder (in-ix fill)', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10;
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();

		const marketIndex = 0;
		const builderFeeBps = 9 * 10; // 9 bps, in tenths
		const userOrderId = 52;
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
			builderIdx: 0,
			builderFeeTenthBps: builderFeeBps,
		}) as OrderParams;

		await escrowMap.slowSync();
		const placeAndTakeTx = await userClient.placeAndTakePerpOrder(
			orderParams,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			escrowMap.get(userClient.wallet.publicKey.toBase58())
		);
		const logs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			placeAndTakeTx
		);
		const events = parseLogs(userClient.program, logs);
		const orderActionRecords = events.filter(
			(e) => e.name === 'orderActionRecord'
		);
		assert(orderActionRecords.length > 0);
		const fillEvent = orderActionRecords[orderActionRecords.length - 1];
		const fillQuoteAssetAmount = fillEvent.data['quoteAssetAmountFilled'] as BN;
		const builderFee = fillEvent.data['builderFee'] as BN;
		assert(
			builderFee.eq(fillQuoteAssetAmount.muln(builderFeeBps).divn(100000)),
			`builderFee ${builderFee.toString()} !== expected`
		);

		await bankrunContextWrapper.moveTimeForward(100);
		await escrowMap.slowSync();
		const escrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const escrowOrder = escrow.orders.find(
			(o) => o.feeTenthBps === builderFeeBps && o.feesAccrued.eq(builderFee)
		);
		assert(escrowOrder !== undefined);
		assert(escrowOrder.builderIdx === 0);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();
	});

	it('NORMAL perp order with builder fee above max is rejected', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150 * 10;
		await userClient.changeApprovedBuilder(builder.publicKey, maxFeeBps, true);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();

		const userOrderId = 53;
		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
			builderIdx: 0,
			builderFeeTenthBps: maxFeeBps + 10, // above the builder's max
		}) as OrderParams;

		try {
			await userClient.placePerpOrder(orderParams);
			assert(false, 'should reject builder fee above max');
		} catch (e) {
			assert(e.message.includes('0x18af'), e.message); // InvalidBuilderFee
		}

		await userClient.fetchAccounts();
		const open = userClient
			.getUser()
			.getOpenOrders()
			.find((o) => o.userOrderId === userOrderId);
		assert(open === undefined);
	});

	it('fill of a referred user order (no builder) fails when the escrow account is omitted', async () => {
		// userClient is referred by builderClient and has a RevenueShareEscrow, so
		// its UserStats carries the BuilderReferral flag and every fill must
		// include the escrow so the referrer reward accrues.
		await userClient.fetchAccounts();
		assert(
			isBuilderReferral(
				await fetchUserStats(userClient, bankrunContextWrapper)
			),
			'userClient should have the BuilderReferral status'
		);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();

		const marketIndex = 0;
		const userOrderId = 71;
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;

		await userClient.placePerpOrder(orderParams);
		await userClient.fetchAccounts();

		const placedOrder = userClient
			.getUser()
			.getOpenOrders()
			.find((o) => o.userOrderId === userOrderId);
		assert(placedOrder !== undefined);
		assert(hasBuilder(placedOrder) === false);
		const orderId = placedOrder.orderId;

		// Build the fill ix with the taker's escrow (appended for a referred
		// taker) and then strip the escrow remaining account, simulating a
		// keeper omitting the optional account and skipping the referral reward.
		await escrowMap.slowSync();
		const takerEscrow = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const ix = await makerClient.getFillPerpOrderIx(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			takerEscrow
		);
		const escrowPk = getRevenueShareEscrowAccountPublicKey(
			makerClient.program.programId,
			userClient.wallet.publicKey
		);
		const keysBefore = ix.keys.length;
		ix.keys = ix.keys.filter((k) => !k.pubkey.equals(escrowPk));
		assert(
			ix.keys.length === keysBefore - 1,
			'escrow account should have been appended then stripped'
		);

		const tx = new Transaction().add(ix);
		tx.recentBlockhash = (
			await bankrunContextWrapper.connection.getLatestBlockhash()
		).blockhash;
		tx.feePayer = makerClient.wallet.publicKey;
		tx.sign(makerClient.wallet.payer);

		try {
			await bankrunContextWrapper.connection.sendTransaction(tx);
			assert(false, 'fill of a referred user without escrow should fail');
		} catch (e) {
			assert(
				e.message.includes('0x18b4'), // UnableToLoadRevenueShareAccount
				`expected UnableToLoadRevenueShareAccount (0x18b4), got ${e.message}`
			);
		}

		// the order remains open and fills once the escrow is included, accruing
		// the referral reward
		await userClient.fetchAccounts();
		const stillOpen = userClient
			.getUser()
			.getOpenOrders()
			.find((o) => o.orderId === orderId);
		assert(
			stillOpen !== undefined,
			'order should remain open after the rejected fill'
		);

		const fillTx = await makerClient.fillPerpOrder(
			await userClient.getUserAccountPublicKey(),
			userClient.getUserAccount(),
			{ marketIndex, orderId },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			takerEscrow
		);
		const logs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			fillTx
		);
		const events = parseLogs(builderClient.program, logs);
		const orderActionRecords = events.filter(
			(e) => e.name === 'orderActionRecord'
		);
		assert(orderActionRecords.length > 0);
		const fillEvent = orderActionRecords[orderActionRecords.length - 1];
		assert(fillEvent.data['builderFee'] === null);
		const referrerReward = new BN(
			(fillEvent.data['referrerReward'] as number | null) ?? 0
		);
		assert(
			referrerReward.gt(ZERO),
			'referral reward should accrue when the escrow is included'
		);

		await userClient.cancelOrders();
		await userClient.fetchAccounts();
	});

	it('referred user with no escrow can be filled without the escrow account', async () => {
		// user2 is referred (UserStats.referrer is set) but never created an
		// escrow, so the BuilderReferral flag is unset and fills succeed without
		// the escrow account (and no referral reward accrues).
		await user2Client.fetchAccounts();
		assert(
			isBuilderReferral(
				await fetchUserStats(user2Client, bankrunContextWrapper)
			) === false,
			'user2 should not have the BuilderReferral status'
		);

		const marketIndex = 0;
		const userOrderId = 72;
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;

		await user2Client.placePerpOrder(orderParams);
		await user2Client.fetchAccounts();

		const placedOrder = user2Client
			.getUser()
			.getOpenOrders()
			.find((o) => o.userOrderId === userOrderId);
		assert(placedOrder !== undefined);
		assert(hasBuilder(placedOrder) === false);

		// no hasBuilderFee flag and no escrow map: nothing appends the escrow
		const fillTx = await makerClient.fillPerpOrder(
			await user2Client.getUserAccountPublicKey(),
			user2Client.getUserAccount(),
			{ marketIndex, orderId: placedOrder.orderId }
		);
		const logs = await printTxLogs(
			bankrunContextWrapper.connection.toConnection(),
			fillTx
		);
		const events = parseLogs(builderClient.program, logs);
		const orderActionRecords = events.filter(
			(e) => e.name === 'orderActionRecord'
		);
		assert(orderActionRecords.length > 0);
		const fillEvent = orderActionRecords[orderActionRecords.length - 1];
		const referrerReward = new BN(
			(fillEvent.data['referrerReward'] as number | null) ?? 0
		);
		assert(referrerReward.eq(ZERO));

		await user2Client.cancelOrders();
		await user2Client.fetchAccounts();
	});

	it('escrow holder with no referrer accrues no referral rewards on fill', async () => {
		// makerClient was created without a referrer; give it an escrow purely
		// for builder codes. Fills must not grant a referee discount, accrue a
		// referrer reward, or claim a permanent referral slot in the escrow.
		await makerClient.initializeRevenueShareEscrow(
			makerClient.wallet.publicKey,
			4
		);
		await makerClient.fetchAccounts();
		assert(
			isBuilderReferral(
				await fetchUserStats(makerClient, bankrunContextWrapper)
			) === false,
			'non-referred escrow holder should not have the BuilderReferral status'
		);

		const marketIndex = 0;
		const userOrderId = 73;
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(230).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(226).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(230).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;

		await makerClient.placePerpOrder(orderParams);
		await makerClient.fetchAccounts();

		const placedOrder = makerClient
			.getUser()
			.getOpenOrders()
			.find((o) => o.userOrderId === userOrderId);
		assert(placedOrder !== undefined);

		// force-attach the (referrer-less) escrow with hasBuilderFee=true
		const fillTx = await builderClient.fillPerpOrder(
			await makerClient.getUserAccountPublicKey(),
			makerClient.getUserAccount(),
			{ marketIndex, orderId: placedOrder.orderId },
			undefined,
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
		const orderActionRecords = events.filter(
			(e) => e.name === 'orderActionRecord'
		);
		assert(orderActionRecords.length > 0);
		const fillEvent = orderActionRecords[orderActionRecords.length - 1];
		const referrerReward = new BN(
			(fillEvent.data['referrerReward'] as number | null) ?? 0
		);
		assert(
			referrerReward.eq(ZERO),
			'no referral reward should accrue without a referrer'
		);

		// no permanent referral slot was claimed in the escrow
		await escrowMap.slowSync();
		const escrow = (await escrowMap.mustGet(
			makerClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		assert(
			escrow.orders.every((o) => !isBuilderOrderReferral(o)),
			'escrow without referrer should have no referral slots'
		);

		await makerClient.cancelOrders();
		await makerClient.fetchAccounts();
	});
});
