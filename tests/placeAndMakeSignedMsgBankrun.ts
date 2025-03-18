import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	AccountInfo,
	AddressLookupTableAccount,
	AddressLookupTableProgram,
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	Wallet,
	EventSubscriber,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource,
	OrderTriggerCondition,
	SignedMsgOrderParamsMessage,
	MarketType,
	getMarketOrderParams,
	SignedMsgOrderRecord,
	getSignedMsgUserAccountPublicKey,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	PTYH_LAZER_PROGRAM_ID,
	OrderType,
	ZERO,
	Order,
	getPythLazerOraclePublicKey,
	getUserStatsAccountPublicKey,
	UserStatsAccount,
	convertToNumber,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import {
	getTriggerLimitOrderParams,
	PEG_PRECISION,
	PostOnlyParams,
} from '../sdk/src';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import {
	PYTH_LAZER_HEX_STRING_SOL,
	PYTH_LAZER_HEX_STRING_SOL_LATER,
	PYTH_STORAGE_DATA,
} from './pythLazerData';

dotenv.config();

const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

describe('place and make signedMsg order', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let slot: BN;

	let makerDriftClient: TestClient;
	let makerDriftClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(10000 * 10 ** 6);

	let solUsd: PublicKey;
	let solUsdLazer: PublicKey;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

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

		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			// @ts-ignore
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 224.3);
		solUsdLazer = getPythLazerOraclePublicKey(chProgram.programId, 6);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: solUsdLazer, source: OracleSource.PYTH_LAZER },
		];

		makerDriftClient = new TestClient({
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
		await makerDriftClient.initialize(usdcMint.publicKey, true);
		await makerDriftClient.subscribe();
		await initializeQuoteSpotMarket(makerDriftClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await makerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);

		await makerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		makerDriftClientUser = new User({
			driftClient: makerDriftClient,
			userAccountPublicKey: await makerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerDriftClientUser.subscribe();
	});

	after(async () => {
		await makerDriftClient.unsubscribe();
		await makerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('makeSignedMsgOrder and reject bad orders', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(224).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(224).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(223).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const txSig = await makerDriftClient.placeAndMakeSignedMsgPerpOrder(
			signedOrderParams,
			uuid,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerDriftClient.wallet.publicKey,
			},
			makerOrderParams,
			undefined,
			undefined,
			undefined,
			undefined,
			2
		);

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(makerPosition.baseAssetAmount.eq(BASE_PRECISION.neg()));

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition.baseAssetAmount.eq(BASE_PRECISION));

		// Make sure that the event is in the logs
		const events = eventSubscriber.getEventsByTx(txSig);
		const event = events.find(
			(event) => event.eventType == 'SignedMsgOrderRecord'
		);
		assert(event !== undefined);
		assert(
			(event as SignedMsgOrderRecord).hash ==
				createHash('sha256')
					.update(Uint8Array.from(signedOrderParams.signature))
					.digest('base64')
		);

		await makerDriftClient.placeAndMakeSignedMsgPerpOrder(
			signedOrderParams,
			uuid,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerDriftClient.wallet.publicKey,
			},
			makerOrderParams,
			undefined,
			undefined,
			undefined,
			undefined,
			2
		);

		const takerPositionAfter = takerDriftClient.getUser().getPerpPosition(0);
		const makerPositionAfter = makerDriftClient.getUser().getPerpPosition(0);

		assert(takerPositionAfter.baseAssetAmount.eq(baseAssetAmount.muln(2)));
		assert(
			makerPositionAfter.baseAssetAmount.eq(baseAssetAmount.muln(2).neg())
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should work with delegates', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const delegate = Keypair.generate();
		await takerDriftClient.updateUserDelegate(delegate.publicKey);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(224).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(224).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const txSig = await makerDriftClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			marketIndex,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				signingAuthority: delegate.publicKey,
			},
			undefined,
			2
		);

		const takerOrders = takerDriftClient.getUser().getOpenOrders();
		assert(takerOrders.length > 0);

		// Make sure that the event is in the logs
		const events = eventSubscriber.getEventsByTx(txSig);
		const event = events.find(
			(event) => event.eventType == 'SignedMsgOrderRecord'
		);
		assert(event !== undefined);
		assert(
			(event as SignedMsgOrderRecord).hash ==
				createHash('sha256')
					.update(Uint8Array.from(signedOrderParams.signature))
					.digest('base64')
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should work with pyth lazer crank and filling against vamm in one tx', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// Switch the oracle over to using pyth lazer
		await makerDriftClient.initializePythLazerOracle(6);
		await makerDriftClient.postPythLazerOracleUpdate(
			[6],
			PYTH_LAZER_HEX_STRING_SOL
		);

		await makerDriftClient.postPythLazerOracleUpdate(
			[6],
			PYTH_LAZER_HEX_STRING_SOL
		);
		await makerDriftClient.updatePerpMarketOracle(
			0,
			solUsdLazer,
			OracleSource.PYTH_LAZER
		);

		const [lookupTableInst, lookupTableAddress] =
			AddressLookupTableProgram.createLookupTable({
				authority: makerDriftClient.wallet.publicKey,
				payer: makerDriftClient.wallet.publicKey,
				recentSlot: slot.toNumber() - 10,
			});

		const extendInstruction = AddressLookupTableProgram.extendLookupTable({
			payer: makerDriftClient.wallet.publicKey,
			authority: makerDriftClient.wallet.publicKey,
			lookupTable: lookupTableAddress,
			addresses: [
				SystemProgram.programId,
				solUsd,
				solUsdLazer,
				...makerDriftClient
					.getPerpMarketAccounts()
					.map((account) => account.pubkey),
				...makerDriftClient
					.getPerpMarketAccounts()
					.map((account) => account.amm.oracle),
				...makerDriftClient
					.getSpotMarketAccounts()
					.map((account) => account.pubkey),
				...makerDriftClient
					.getSpotMarketAccounts()
					.map((account) => account.oracle),
				PYTH_LAZER_STORAGE_ACCOUNT_KEY,
			],
		});

		const tx = new Transaction().add(lookupTableInst).add(extendInstruction);
		await makerDriftClient.sendTransaction(tx);
		console.log(`Lookup table: ${lookupTableAddress.toBase58()}`);

		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(226).mul(PRICE_PRECISION),
			auctionDuration: 30,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		const uuid = nanoid(8);
		const signedMsgSlot = slot.subn(15);
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			uuid: Uint8Array.from(Buffer.from(uuid)),
			slot: signedMsgSlot,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};
		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		// Get pyth lazer instruction
		const pythLazerCrankIxs =
			await makerDriftClient.getPostPythLazerOracleUpdateIxs(
				[6],
				PYTH_LAZER_HEX_STRING_SOL,
				undefined,
				1
			);

		const placeSignedMsgTakerOrderIxs =
			await makerDriftClient.getPlaceSignedMsgTakerPerpOrderIxs(
				signedOrderParams,
				takerOrderParams.marketIndex,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.wallet.publicKey,
				},
				pythLazerCrankIxs
			);

		const signedMsgOrder: Order = {
			status: 'open',
			orderType: OrderType.MARKET,
			orderId: null,
			slot: signedMsgSlot,
			marketIndex: 0,
			marketType: MarketType.PERP,
			baseAssetAmount: takerOrderParams.baseAssetAmount,
			auctionDuration: takerOrderParams.auctionDuration!,
			auctionStartPrice: takerOrderParams.auctionStartPrice!,
			auctionEndPrice: takerOrderParams.auctionEndPrice!,
			immediateOrCancel: true,
			direction: takerOrderParams.direction,
			postOnly: false,
			oraclePriceOffset: takerOrderParams.oraclePriceOffset ?? 0,
			// Rest are not required for DLOB
			price: ZERO,
			maxTs: ZERO,
			triggerPrice: ZERO,
			triggerCondition: OrderTriggerCondition.ABOVE,
			existingPositionDirection: PositionDirection.LONG,
			reduceOnly: false,
			baseAssetAmountFilled: ZERO,
			quoteAssetAmountFilled: ZERO,
			quoteAssetAmount: ZERO,
			userOrderId: 0,
			bitFlags: 0,
			postedSlotTail: 0,
		};

		const fillIx = await makerDriftClient.getFillPerpOrderIx(
			takerDriftClientUser.getUserAccountPublicKey(),
			takerDriftClientUser.getUserAccount(),
			signedMsgOrder,
			undefined,
			undefined,
			undefined,
			true
		);

		const txMessage = new TransactionMessage({
			payerKey: makerDriftClient.wallet.publicKey,
			recentBlockhash: (await makerDriftClient.connection.getLatestBlockhash())
				.blockhash,
			instructions: [
				...pythLazerCrankIxs,
				...placeSignedMsgTakerOrderIxs,
				fillIx,
			],
		});

		const lookupTableAccount = (
			await bankrunContextWrapper.connection.getAddressLookupTable(
				lookupTableAddress
			)
		).value;
		const message = txMessage.compileToV0Message([lookupTableAccount]);

		const txSig = await makerDriftClient.connection.sendTransaction(
			new VersionedTransaction(message)
		);
		console.log(txSig);

		await takerDriftClient.fetchAccounts();
		assert(
			takerDriftClient
				.getUser()
				.getPerpPosition(0)
				.baseAssetAmount.eq(BASE_PRECISION)
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should not fill against the vamm if the user is toxic', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const [lookupTableInst, lookupTableAddress] =
			AddressLookupTableProgram.createLookupTable({
				authority: makerDriftClient.wallet.publicKey,
				payer: makerDriftClient.wallet.publicKey,
				recentSlot: slot.toNumber() - 10,
			});

		const extendInstruction = AddressLookupTableProgram.extendLookupTable({
			payer: makerDriftClient.wallet.publicKey,
			authority: makerDriftClient.wallet.publicKey,
			lookupTable: lookupTableAddress,
			addresses: [
				SystemProgram.programId,
				solUsd,
				solUsdLazer,
				...makerDriftClient
					.getPerpMarketAccounts()
					.map((account) => account.pubkey),
				...makerDriftClient
					.getPerpMarketAccounts()
					.map((account) => account.amm.oracle),
				...makerDriftClient
					.getSpotMarketAccounts()
					.map((account) => account.pubkey),
				...makerDriftClient
					.getSpotMarketAccounts()
					.map((account) => account.oracle),
				PYTH_LAZER_STORAGE_ACCOUNT_KEY,
			],
		});

		const tx = new Transaction().add(lookupTableInst).add(extendInstruction);
		await makerDriftClient.sendTransaction(tx);
		console.log(`Lookup table: ${lookupTableAddress.toBase58()}`);

		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		// Create 11 subaccounts so our user is considered toxic
		for (let i = 1; i < 11; i++) {
			await takerDriftClient.initializeUserAccount(i);
		}

		const userStatsPubkey = getUserStatsAccountPublicKey(
			chProgram.programId,
			takerDriftClient.wallet.publicKey
		);
		const userStatsData = await bankrunContextWrapper.connection.getAccountInfo(
			userStatsPubkey
		);
		const userStats: UserStatsAccount =
			chProgram.account.userStats.coder.accounts.decodeUnchecked(
				'UserStats',
				userStatsData.data
			);

		assert(userStats.numberOfSubAccounts == 11);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(226).mul(PRICE_PRECISION),
			auctionDuration: 30,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		const uuid = nanoid(8);
		const signedMsgSlot = slot.subn(50);
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			uuid: Uint8Array.from(Buffer.from(uuid)),
			slot: signedMsgSlot,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};
		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		// Get pyth lazer instruction
		const pythLazerCrankIxs =
			await makerDriftClient.getPostPythLazerOracleUpdateIxs(
				[6],
				PYTH_LAZER_HEX_STRING_SOL_LATER,
				undefined,
				1
			);

		const placeSignedMsgTakerOrderIxs =
			await makerDriftClient.getPlaceSignedMsgTakerPerpOrderIxs(
				signedOrderParams,
				takerOrderParams.marketIndex,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.wallet.publicKey,
				},
				pythLazerCrankIxs
			);

		const signedMsgOrder: Order = {
			status: 'open',
			orderType: OrderType.MARKET,
			orderId: null,
			slot: signedMsgSlot,
			marketIndex: 0,
			marketType: MarketType.PERP,
			baseAssetAmount: takerOrderParams.baseAssetAmount,
			auctionDuration: takerOrderParams.auctionDuration!,
			auctionStartPrice: takerOrderParams.auctionStartPrice!,
			auctionEndPrice: takerOrderParams.auctionEndPrice!,
			immediateOrCancel: true,
			direction: takerOrderParams.direction,
			postOnly: false,
			oraclePriceOffset: takerOrderParams.oraclePriceOffset ?? 0,
			// Rest are not required for DLOB
			price: ZERO,
			maxTs: ZERO,
			triggerPrice: ZERO,
			triggerCondition: OrderTriggerCondition.ABOVE,
			existingPositionDirection: PositionDirection.LONG,
			reduceOnly: false,
			baseAssetAmountFilled: ZERO,
			quoteAssetAmountFilled: ZERO,
			quoteAssetAmount: ZERO,
			userOrderId: 0,
			bitFlags: 0,
			postedSlotTail: 0,
		};

		const fillIx = await makerDriftClient.getFillPerpOrderIx(
			takerDriftClientUser.getUserAccountPublicKey(),
			takerDriftClientUser.getUserAccount(),
			signedMsgOrder,
			undefined,
			undefined,
			undefined,
			true
		);

		const txMessage = new TransactionMessage({
			payerKey: makerDriftClient.wallet.publicKey,
			recentBlockhash: (await makerDriftClient.connection.getLatestBlockhash())
				.blockhash,
			instructions: [
				...pythLazerCrankIxs,
				...placeSignedMsgTakerOrderIxs,
				fillIx,
			],
		});

		const lookupTableAccount = (
			await bankrunContextWrapper.connection.getAddressLookupTable(
				lookupTableAddress
			)
		).value;
		const message = txMessage.compileToV0Message([lookupTableAccount]);

		const txSig = await makerDriftClient.connection.sendTransaction(
			new VersionedTransaction(message)
		);
		console.log(txSig);

		await takerDriftClient.fetchAccounts();
		assert(
			takerDriftClient.getUser().getPerpPosition(0).baseAssetAmount.eq(ZERO)
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('fills signedMsg with trigger orders ', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(224).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(224).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const stopLossTakerParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(220).mul(PRICE_PRECISION),
			triggerPrice: new BN(220).mul(PRICE_PRECISION),
			userOrderId: 2,
			triggerCondition: OrderTriggerCondition.BELOW,
			marketType: MarketType.PERP,
		});

		const takeProfitTakerParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(240).mul(PRICE_PRECISION),
			triggerPrice: new BN(240).mul(PRICE_PRECISION),
			userOrderId: 3,
			triggerCondition: OrderTriggerCondition.ABOVE,
			marketType: MarketType.PERP,
		});

		await takerDriftClientUser.fetchAccounts();
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(223).mul(PRICE_PRECISION),
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
			marketType: MarketType.PERP,
		});

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			stopLossOrderParams: {
				triggerPrice: stopLossTakerParams.triggerPrice,
				baseAssetAmount: stopLossTakerParams.baseAssetAmount,
			},
			takeProfitOrderParams: {
				triggerPrice: takeProfitTakerParams.triggerPrice,
				baseAssetAmount: takeProfitTakerParams.baseAssetAmount,
			},
		};

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const ixs = await makerDriftClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
			signedOrderParams,
			uuid,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerDriftClient.wallet.publicKey,
			},
			makerOrderParams,
			undefined,
			undefined,
			undefined,
			2
		);

		/*
		 Transaction size should be largest for filling with trigger orders w/ place and take
		 Max size: 1232
		 We currently trade on sol market w/ sol oracle so would be better with LUT, so -64 bytes + 2 bytes
		 We dont have referrers for maker so need to add 64 bytes
		 We want to allow for positions to be full with maximally different markets for maker/taker and spot/perp, 
				so add 30 bytes for market/oracle for taker and 30 bytes for maker
		 Add 32 bytes for LUT
			size of transaction + 32 + 2 + 30 + 30 < 1232
		*/
		assert(getSizeOfTransaction(ixs, false) < 1138);

		const tx = await makerDriftClient.buildTransaction(ixs);
		await makerDriftClient.sendTransaction(tx as Transaction);

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(makerPosition.baseAssetAmount.eq(BASE_PRECISION.neg().muln(3)));

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);

		// All orders are placed and one is
		assert(takerPosition.baseAssetAmount.eq(BASE_PRECISION));
		assert(
			takerDriftClient
				.getUser()
				.getOpenOrders()
				.some((order) => order.orderId == 1)
		);
		assert(
			takerDriftClient
				.getUser()
				.getOpenOrders()
				.some((order) => order.orderId == 2)
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should fail if taker order is a limit order without an auction', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(224).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});

		await takerDriftClientUser.fetchAccounts();
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(223).mul(PRICE_PRECISION),
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		try {
			await makerDriftClient.placeAndMakeSignedMsgPerpOrder(
				signedOrderParams,
				uuid,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.wallet.publicKey,
				},
				makerOrderParams,
				undefined,
				undefined,
				undefined,
				undefined,
				2
			);
		} catch (e) {
			assert(e);
		}

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition == undefined);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should succeed if taker order is a limit order with an auction', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(225).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(224).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});

		await takerDriftClientUser.fetchAccounts();

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		try {
			await makerDriftClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				marketIndex,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.wallet.publicKey,
				},
				undefined,
				2
			);
		} catch (e) {
			assert(e);
		}
		await bankrunContextWrapper.moveTimeForward(10);

		await takerDriftClientUser.fetchAccounts();
		assert(
			convertToNumber(takerDriftClient.getUser().getOpenOrders()[0].price) ==
				225
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should work with off-chain auctions', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(227).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		const signedMsgSlot = slot.subn(5);
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot: signedMsgSlot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};
		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		await makerDriftClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			takerOrderParams.marketIndex,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerDriftClient.wallet.publicKey,
			},
			undefined,
			2
		);

		assert(takerDriftClient.getOrderByUserId(1) !== undefined);
		assert(takerDriftClient.getOrderByUserId(1).slot.eq(slot.subn(5)));

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(225).mul(PRICE_PRECISION),
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});
		await makerDriftClient.placeAndMakeSignedMsgPerpOrder(
			signedOrderParams,
			uuid,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerDriftClient.wallet.publicKey,
			},
			makerOrderParams,
			undefined,
			undefined,
			undefined,
			undefined,
			2
		);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition.baseAssetAmount.eq(baseAssetAmount));

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should fail if auction params are not set', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(224).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		try {
			await makerDriftClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				0,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.wallet.publicKey,
				},
				undefined,
				2
			);
			assert.fail('Should have failed');
		} catch (error) {
			assert(error.message.includes('custom program error: 0x1890'));
		}

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should verify that auction params are not sanitized', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(10000).mul(PRICE_PRECISION),
			auctionDuration: 50,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		await makerDriftClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			0,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerDriftClient.wallet.publicKey,
			},
			undefined,
			2
		);

		assert(
			takerDriftClientUser
				.getOrderByUserOrderId(1)
				.auctionEndPrice.eq(new BN(10000).mul(PRICE_PRECISION))
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should fail on malicious subaccount id supplied to custom ix', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();

		// Create new user account w/ diff subaccount id but same authority
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			new BN(1000),
			userUSDCAccount.publicKey,
			0,
			1,
			undefined,
			0
		);

		const takerDriftClientUser2 = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(1),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser2.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(10000).mul(PRICE_PRECISION),
			auctionDuration: 50,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		try {
			await makerDriftClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				0,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(1),
					takerUserAccount: takerDriftClientUser2.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.wallet.publicKey,
				},
				undefined,
				2
			);
			assert.fail('Should have failed');
		} catch (error) {
			assert(error);
		}

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition == undefined);

		await takerDriftClientUser2.unsubscribe();
		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('can let user delete their account', async () => {
		const [takerDriftClient, takerDriftClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerDriftClientUser.fetchAccounts();
		await takerDriftClient.deleteSignedMsgUserOrders();

		assert(
			(await checkIfAccountExists(
				takerDriftClient.connection,
				getSignedMsgUserAccountPublicKey(
					takerDriftClient.program.programId,
					takerDriftClient.authority
				)
			)) == false
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});
});

async function initializeNewTakerClientAndUser(
	bankrunContextWrapper: BankrunContextWrapper,
	chProgram: Program,
	usdcMint: Keypair,
	usdcAmount: BN,
	marketIndexes: number[],
	spotMarketIndexes: number[],
	oracleInfos: { publicKey: PublicKey; source: OracleSource }[],
	bulkAccountLoader: TestBulkAccountLoader
): Promise<[TestClient, User]> {
	const keypair = new Keypair();
	await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
	await sleep(1000);
	const wallet = new Wallet(keypair);
	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		bankrunContextWrapper,
		keypair.publicKey
	);
	const takerDriftClient = new TestClient({
		connection: bankrunContextWrapper.connection.toConnection(),
		wallet,
		programID: chProgram.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: marketIndexes,
		spotMarketIndexes: spotMarketIndexes,
		subAccountIds: [],
		oracleInfos,
		userStats: true,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await takerDriftClient.subscribe();
	await takerDriftClient.initializeUserAccountAndDepositCollateral(
		usdcAmount,
		userUSDCAccount.publicKey
	);
	const takerDriftClientUser = new User({
		driftClient: takerDriftClient,
		userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await takerDriftClientUser.subscribe();
	return [takerDriftClient, takerDriftClientUser];
}

export function getSizeOfTransaction(
	instructions: TransactionInstruction[],
	versionedTransaction = true,
	addressLookupTables: AddressLookupTableAccount[] = []
): number {
	const programs = new Set<string>();
	const signers = new Set<string>();
	let accounts = new Set<string>();

	instructions.map((ix) => {
		programs.add(ix.programId.toBase58());
		accounts.add(ix.programId.toBase58());
		ix.keys.map((key) => {
			if (key.isSigner) {
				signers.add(key.pubkey.toBase58());
			}
			accounts.add(key.pubkey.toBase58());
		});
	});

	const instruction_sizes: number = instructions
		.map(
			(ix) =>
				1 +
				getSizeOfCompressedU16(ix.keys.length) +
				ix.keys.length +
				getSizeOfCompressedU16(ix.data.length) +
				ix.data.length
		)
		.reduce((a, b) => a + b, 0);

	let numberOfAddressLookups = 0;
	if (addressLookupTables.length > 0) {
		const lookupTableAddresses = addressLookupTables
			.map((addressLookupTable) =>
				addressLookupTable.state.addresses.map((address) => address.toBase58())
			)
			.flat();
		const totalNumberOfAccounts = accounts.size;
		accounts = new Set(
			[...accounts].filter((account) => !lookupTableAddresses.includes(account))
		);
		accounts = new Set([...accounts, ...programs, ...signers]);
		numberOfAddressLookups = totalNumberOfAccounts - accounts.size;
	}

	return (
		getSizeOfCompressedU16(signers.size) +
		signers.size * 64 + // array of signatures
		3 +
		getSizeOfCompressedU16(accounts.size) +
		32 * accounts.size + // array of account addresses
		32 + // recent blockhash
		getSizeOfCompressedU16(instructions.length) +
		instruction_sizes + // array of instructions
		(versionedTransaction ? 1 + getSizeOfCompressedU16(0) : 0) +
		(versionedTransaction ? 32 * addressLookupTables.length : 0) +
		(versionedTransaction && addressLookupTables.length > 0 ? 2 : 0) +
		numberOfAddressLookups
	);
}

function getSizeOfCompressedU16(n: number) {
	return 1 + Number(n >= 128) + Number(n >= 16384);
}

async function checkIfAccountExists(
	connection: Connection,
	account: PublicKey
): Promise<boolean> {
	try {
		const accountInfo = await connection.getAccountInfo(account);
		return accountInfo != null;
	} catch (e) {
		// Doesn't already exist
		return false;
	}
}
