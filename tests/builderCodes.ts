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

describe('builder codes', () => {
	const chProgram = anchor.workspace.Drift as Program;

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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 224.3);
		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		marketIndexes = [0, 1];
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
			new BN(224 * PEG_PRECISION.toNumber())
		);
		await builderClient.initializePerpMarket(
			1,
			solUsd,
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
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
				'RevenueShare',
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
				'RevenueShareEscrow',
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
				'RevenueShareEscrow',
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
				'RevenueShareEscrow',
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
			'RevenueShareEscrow',
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
			'RevenueShareEscrow',
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
		const builderFee = events[0].data['builderFee'] as BN | null;
		const takerFee = events[0].data['takerFee'] as BN;
		const totalFeePaid = takerFee;
		const referrerReward = new BN(events[0].data['referrerReward'] as number);
		assert(builderFee === null);
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
		// const referrerReward = events[0].data['referrerReward'] as number;
		assert(
			builderFee.eq(fillQuoteAssetAmount.muln(builderFeeBps).divn(100000))
		);

		await userClient.fetchAccounts();
		userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 2);

		const pos = userClient.getUser().getPerpPosition(0);
		const takerOrderCumulativeQuoteAssetAmountFilled = events[0].data[
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
			.filter((e) => e.name === 'RevenueShareSettleRecord')
			.map((e) => e.data) as RevenueShareSettleRecord[];

		assert(builderSettleEvents.length === 1);
		assert(builderSettleEvents[0].builder.equals(builder.publicKey));
		assert(builderSettleEvents[0].referrer == null);
		assert(builderSettleEvents[0].feeSettled.eq(builderFee));
		assert(builderSettleEvents[0].marketIndex === marketIndex);
		assert(isVariant(builderSettleEvents[0].marketType, 'perp'));
		assert(builderSettleEvents[0].builderTotalReferrerRewards.eq(ZERO));
		assert(builderSettleEvents[0].builderTotalBuilderRewards.eq(builderFee));

		// assert(builderSettleEvents[1].builder === null);
		// assert(builderSettleEvents[1].referrer.equals(builder.publicKey));
		// assert(builderSettleEvents[1].feeSettled.eq(new BN(referrerReward)));
		// assert(builderSettleEvents[1].marketIndex === marketIndex);
		// assert(isVariant(builderSettleEvents[1].marketType, 'spot'));
		// assert(
		// 	builderSettleEvents[1].builderTotalReferrerRewards.eq(
		// 		new BN(referrerReward)
		// 	)
		// );
		// assert(builderSettleEvents[1].builderTotalBuilderRewards.eq(builderFee));

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

		const finalBuilderFee = builderUsdcAfterSettle.sub(builderUsdcBeforeSettle);
		// .sub(new BN(referrerReward))
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
		// const referrerRewardA = new BN(fillEventA.data['referrerReward'] as number);

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
		// const referrerRewardB = new BN(fillEventB.data['referrerReward'] as number);

		await bankrunContextWrapper.moveTimeForward(100);

		await escrowMap.slowSync();
		const escrowAfterFills = (await escrowMap.mustGet(
			userClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const totalFeesAccrued = escrowAfterFills.orders.reduce(
			(sum, o) => sum.add(o.feesAccrued ?? ZERO),
			ZERO
		);
		const expectedTotal = builderFeeA.add(builderFeeB);
		// .add(referrerRewardA)
		// .add(referrerRewardB);
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
				'RevenueShare',
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
		// const referrerRewardA = fillEventA.reduce(
		// 	(sum, e) => sum.add(new BN(e.data['referrerReward'] as number)),
		// 	ZERO
		// );

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
		assert(
			builderUsdcAfter.sub(builderUsdcBefore).eq(builderFeeA),
			// .add(referrerRewardA)
			`builderUsdcAfter: ${builderUsdcAfter.toString()} !== builderUsdcBefore ${builderUsdcBefore.toString()} + builderFeeA ${builderFeeA.toString()}`
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
				'RevenueShare',
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

		// const referrerRewardChange = builderAccAfter.totalReferrerRewards.sub(
		// 	builderAccBefore.totalReferrerRewards
		// );
		// assert(referrerRewardChange.eq(referrerRewardA));
	});

	// it('can track referral rewards for 2 markets', async () => {
	// 	const builderAccountInfoBefore =
	// 		await bankrunContextWrapper.connection.getAccountInfo(
	// 			getRevenueShareAccountPublicKey(
	// 				builderClient.program.programId,
	// 				builderClient.wallet.publicKey
	// 			)
	// 		);
	// 	const builderAccBefore: RevenueShareAccount =
	// 		builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
	// 			'RevenueShare',
	// 			builderAccountInfoBefore.data
	// 		);
	// 	// await escrowMap.slowSync();
	// 	// const escrowBeforeFills = (await escrowMap.mustGet(
	// 	// 	userClient.wallet.publicKey.toBase58()
	// 	// )) as RevenueShareEscrowAccount;

	// 	const slot = new BN(
	// 		await bankrunContextWrapper.connection.toConnection().getSlot()
	// 	);

	// 	// place 2 orders in different markets

	// 	const signedA = userClient.signSignedMsgOrderParamsMessage(
	// 		buildMsg(0, BASE_PRECISION, 1, 5, slot),
	// 		false
	// 	);
	// 	await builderClient.placeSignedMsgTakerOrder(
	// 		signedA,
	// 		0,
	// 		{
	// 			taker: await userClient.getUserAccountPublicKey(),
	// 			takerUserAccount: userClient.getUserAccount(),
	// 			takerStats: userClient.getUserStatsAccountPublicKey(),
	// 			signingAuthority: userClient.wallet.publicKey,
	// 		},
	// 		undefined,
	// 		2
	// 	);

	// 	const signedB = userClient.signSignedMsgOrderParamsMessage(
	// 		buildMsg(1, BASE_PRECISION, 2, 5, slot),
	// 		false
	// 	);
	// 	await builderClient.placeSignedMsgTakerOrder(
	// 		signedB,
	// 		1,
	// 		{
	// 			taker: await userClient.getUserAccountPublicKey(),
	// 			takerUserAccount: userClient.getUserAccount(),
	// 			takerStats: userClient.getUserStatsAccountPublicKey(),
	// 			signingAuthority: userClient.wallet.publicKey,
	// 		},
	// 		undefined,
	// 		2
	// 	);

	// 	await userClient.fetchAccounts();
	// 	const openOrders = userClient.getUser().getOpenOrders();

	// 	const fillTxA = await makerClient.fillPerpOrder(
	// 		await userClient.getUserAccountPublicKey(),
	// 		userClient.getUserAccount(),
	// 		{
	// 			marketIndex: 0,
	// 			orderId: openOrders.find(
	// 				(o) => isVariant(o.status, 'open') && o.marketIndex === 0
	// 			)!.orderId,
	// 		},
	// 		undefined,
	// 		{
	// 			referrer: await builderClient.getUserAccountPublicKey(),
	// 			referrerStats: builderClient.getUserStatsAccountPublicKey(),
	// 		},
	// 		undefined,
	// 		undefined,
	// 		undefined,
	// 		true
	// 	);
	// 	const logsA = await printTxLogs(
	// 		bankrunContextWrapper.connection.toConnection(),
	// 		fillTxA
	// 	);
	// 	const eventsA = parseLogs(builderClient.program, logsA);
	// 	const fillsA = eventsA.filter((e) => e.name === 'OrderActionRecord');
	// 	const fillAReferrerReward = fillsA[0]['data']['referrerReward'] as number;
	// 	assert(fillsA.length > 0);
	// 	// debug: fillsA[0]['data']

	// 	const fillTxB = await makerClient.fillPerpOrder(
	// 		await userClient.getUserAccountPublicKey(),
	// 		userClient.getUserAccount(),
	// 		{
	// 			marketIndex: 1,
	// 			orderId: openOrders.find(
	// 				(o) => isVariant(o.status, 'open') && o.marketIndex === 1
	// 			)!.orderId,
	// 		},
	// 		undefined,
	// 		{
	// 			referrer: await builderClient.getUserAccountPublicKey(),
	// 			referrerStats: builderClient.getUserStatsAccountPublicKey(),
	// 		},
	// 		undefined,
	// 		undefined,
	// 		undefined,
	// 		true
	// 	);
	// 	const logsB = await printTxLogs(
	// 		bankrunContextWrapper.connection.toConnection(),
	// 		fillTxB
	// 	);
	// 	const eventsB = parseLogs(builderClient.program, logsB);
	// 	const fillsB = eventsB.filter((e) => e.name === 'OrderActionRecord');
	// 	assert(fillsB.length > 0);
	// 	const fillBReferrerReward = fillsB[0]['data']['referrerReward'] as number;
	// 	// debug: fillsB[0]['data']

	// 	await escrowMap.slowSync();
	// 	const escrowAfterFills = (await escrowMap.mustGet(
	// 		userClient.wallet.publicKey.toBase58()
	// 	)) as RevenueShareEscrowAccount;

	// 	const referrerOrdersMarket0 = escrowAfterFills.orders.filter(
	// 		(o) => o.marketIndex === 0 && isBuilderOrderReferral(o)
	// 	);
	// 	const referrerOrdersMarket1 = escrowAfterFills.orders.filter(
	// 		(o) => o.marketIndex === 1 && isBuilderOrderReferral(o)
	// 	);
	// 	assert(referrerOrdersMarket0[0].marketIndex === 0);
	// 	assert(
	// 		referrerOrdersMarket0[0].feesAccrued.eq(new BN(fillAReferrerReward))
	// 	);
	// 	assert(referrerOrdersMarket1[0].marketIndex === 1);
	// 	assert(
	// 		referrerOrdersMarket1[0].feesAccrued.eq(new BN(fillBReferrerReward))
	// 	);

	// 	// settle pnl
	// 	const settleTxA = await builderClient.settleMultiplePNLs(
	// 		await userClient.getUserAccountPublicKey(),
	// 		userClient.getUserAccount(),
	// 		[0, 1],
	// 		SettlePnlMode.MUST_SETTLE,
	// 		escrowMap
	// 	);
	// 	await printTxLogs(
	// 		bankrunContextWrapper.connection.toConnection(),
	// 		settleTxA
	// 	);

	// 	await escrowMap.slowSync();
	// 	const escrowAfterSettle = (await escrowMap.mustGet(
	// 		userClient.wallet.publicKey.toBase58()
	// 	)) as RevenueShareEscrowAccount;
	// 	const referrerOrdersMarket0AfterSettle = escrowAfterSettle.orders.filter(
	// 		(o) => o.marketIndex === 0 && isBuilderOrderReferral(o)
	// 	);
	// 	const referrerOrdersMarket1AfterSettle = escrowAfterSettle.orders.filter(
	// 		(o) => o.marketIndex === 1 && isBuilderOrderReferral(o)
	// 	);
	// 	assert(referrerOrdersMarket0AfterSettle.length === 1);
	// 	assert(referrerOrdersMarket1AfterSettle.length === 1);
	// 	assert(referrerOrdersMarket0AfterSettle[0].feesAccrued.eq(ZERO));
	// 	assert(referrerOrdersMarket1AfterSettle[0].feesAccrued.eq(ZERO));

	// 	const builderAccountInfoAfter =
	// 		await bankrunContextWrapper.connection.getAccountInfo(
	// 			getRevenueShareAccountPublicKey(
	// 				builderClient.program.programId,
	// 				builderClient.wallet.publicKey
	// 			)
	// 		);
	// 	const builderAccAfter: RevenueShareAccount =
	// 		builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
	// 			'RevenueShare',
	// 			builderAccountInfoAfter.data
	// 		);
	// 	const referrerRewards = builderAccAfter.totalReferrerRewards.sub(
	// 		builderAccBefore.totalReferrerRewards
	// 	);
	// 	assert(
	// 		referrerRewards.eq(new BN(fillAReferrerReward + fillBReferrerReward))
	// 	);
	// });
});
