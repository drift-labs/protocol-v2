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
	OrderParams,
	SignedMsgOrderParamsDelegateMessage,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
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
	const chProgram = anchor.workspace.Velocity as Program;

	let slot: BN;

	let makerVelocityClient: TestClient;
	let makerVelocityClientUser: User;
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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 84);
		solUsdLazer = getPythLazerOraclePublicKey(chProgram.programId, 6);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH_LAZER },
			{ publicKey: solUsdLazer, source: OracleSource.PYTH_LAZER },
		];

		makerVelocityClient = new TestClient({
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
		await makerVelocityClient.initialize(usdcMint.publicKey, true);
		await makerVelocityClient.subscribe();
		await initializeQuoteSpotMarket(makerVelocityClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await makerVelocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(84 * PEG_PRECISION.toNumber())
		);
		await makerVelocityClient.initializeAmmCache();

		await makerVelocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		makerVelocityClientUser = new User({
			velocityClient: makerVelocityClient,
			userAccountPublicKey: await makerVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerVelocityClientUser.subscribe();
	});

	after(async () => {
		await makerVelocityClient.unsubscribe();
		await makerVelocityClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('makeSignedMsgOrder and reject bad orders', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(84).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(84).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
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
			price: new BN(83).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 1,
		});

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		const txSig = await makerVelocityClient.placeAndMakeSignedMsgPerpOrder(
			signedOrderParams,
			uuid,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			makerOrderParams,
			undefined,
			undefined,
			undefined,
			2
		);

		const makerPosition = makerVelocityClient.getUser().getPerpPosition(0);
		assert(makerPosition.baseAssetAmount.eq(BASE_PRECISION.neg()));

		const takerPosition = takerVelocityClient.getUser().getPerpPosition(0);
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

		await makerVelocityClient.placeAndMakeSignedMsgPerpOrder(
			signedOrderParams,
			uuid,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			makerOrderParams,
			undefined,
			undefined,
			undefined,
			2
		);

		const takerPositionAfter = takerVelocityClient.getUser().getPerpPosition(0);
		const makerPositionAfter = makerVelocityClient.getUser().getPerpPosition(0);

		assert(takerPositionAfter.baseAssetAmount.eq(baseAssetAmount.muln(2)));
		assert(
			makerPositionAfter.baseAssetAmount.eq(baseAssetAmount.muln(2).neg())
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should work with delegates', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		await takerVelocityClient.updateUserDelegate(
			makerVelocityClient.wallet.publicKey
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(84).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(84).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));

		// Should fail if we try first without encoding properly
		const takerOrderParamsMessage: SignedMsgOrderParamsDelegateMessage = {
			signedMsgOrderParams: takerOrderParams,
			takerPubkey: await takerVelocityClient.getUserAccountPublicKey(),
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		// Should work if we encode properly
		const signedOrderParams =
			makerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage,
				true
			);
		const txSig = await makerVelocityClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			marketIndex,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: makerVelocityClient.wallet.publicKey,
			},
			undefined,
			2
		);

		const takerOrders = takerVelocityClient.getUser().getOpenOrders();
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

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should work with pyth lazer crank and filling against vamm in one tx', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// Switch the oracle over to using pyth lazer
		await makerVelocityClient.initializePythLazerOracle(6);
		await makerVelocityClient.postPythLazerOracleUpdate(
			[6],
			PYTH_LAZER_HEX_STRING_SOL
		);

		await makerVelocityClient.postPythLazerOracleUpdate(
			[6],
			PYTH_LAZER_HEX_STRING_SOL
		);
		await makerVelocityClient.updatePerpMarketOracle(
			0,
			solUsdLazer,
			OracleSource.PYTH_LAZER
		);

		const [lookupTableInst, lookupTableAddress] =
			AddressLookupTableProgram.createLookupTable({
				authority: makerVelocityClient.wallet.publicKey,
				payer: makerVelocityClient.wallet.publicKey,
				recentSlot: slot.toNumber() - 10,
			});

		const extendInstruction = AddressLookupTableProgram.extendLookupTable({
			payer: makerVelocityClient.wallet.publicKey,
			authority: makerVelocityClient.wallet.publicKey,
			lookupTable: lookupTableAddress,
			addresses: [
				SystemProgram.programId,
				solUsd,
				solUsdLazer,
				...makerVelocityClient
					.getPerpMarketAccounts()
					.map((account) => account.pubkey),
				...makerVelocityClient
					.getPerpMarketAccounts()
					.map((account) => account.oracle),
				...makerVelocityClient
					.getSpotMarketAccounts()
					.map((account) => account.pubkey),
				...makerVelocityClient
					.getSpotMarketAccounts()
					.map((account) => account.oracle),
				PYTH_LAZER_STORAGE_ACCOUNT_KEY,
			],
		});

		const tx = new Transaction().add(lookupTableInst).add(extendInstruction);
		await makerVelocityClient.sendTransaction(tx);
		console.log(`Lookup table: ${lookupTableAddress.toBase58()}`);

		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(226).mul(PRICE_PRECISION),
			auctionDuration: 30,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		}) as OrderParams;
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
		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		// Get pyth lazer instruction
		const pythLazerCrankIxs =
			await makerVelocityClient.getPostPythLazerOracleUpdateIxs(
				[6],
				PYTH_LAZER_HEX_STRING_SOL,
				undefined,
				1
			);

		const placeSignedMsgTakerOrderIxs =
			await makerVelocityClient.getPlaceSignedMsgTakerPerpOrderIxs(
				signedOrderParams,
				takerOrderParams.marketIndex,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(),
					takerUserAccount: takerVelocityClient.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerVelocityClient.wallet.publicKey,
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
			oraclePriceOffset: takerOrderParams.oraclePriceOffset ?? ZERO,
			// Rest are not required for DLOB
			price: ZERO,
			maxTs: ZERO,
			triggerPrice: ZERO,
			triggerCondition: OrderTriggerCondition.ABOVE,
			existingPositionDirection: PositionDirection.LONG,
			reduceOnly: false,
			baseAssetAmountFilled: ZERO,
			quoteAssetAmountFilled: ZERO,
			userOrderId: 0,
			bitFlags: 0,
			postedSlotTail: 0,
		};

		const fillIx = await makerVelocityClient.getFillPerpOrderIx(
			takerVelocityClientUser.getUserAccountPublicKey(),
			takerVelocityClientUser.getUserAccount(),
			signedMsgOrder,
			undefined,
			undefined,
			true
		);

		const txMessage = new TransactionMessage({
			payerKey: makerVelocityClient.wallet.publicKey,
			recentBlockhash: (
				await makerVelocityClient.connection.getLatestBlockhash()
			).blockhash,
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

		const txSig = await makerVelocityClient.connection.sendTransaction(
			new VersionedTransaction(message)
		);
		console.log(txSig);

		await takerVelocityClient.fetchAccounts();
		assert(
			takerVelocityClient.getUser().getPerpPosition(0).baseAssetAmount.gt(ZERO)
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it.skip('should not fill against the vamm if the user is toxic', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const [lookupTableInst, lookupTableAddress] =
			AddressLookupTableProgram.createLookupTable({
				authority: makerVelocityClient.wallet.publicKey,
				payer: makerVelocityClient.wallet.publicKey,
				recentSlot: slot.toNumber() - 10,
			});

		const extendInstruction = AddressLookupTableProgram.extendLookupTable({
			payer: makerVelocityClient.wallet.publicKey,
			authority: makerVelocityClient.wallet.publicKey,
			lookupTable: lookupTableAddress,
			addresses: [
				SystemProgram.programId,
				solUsd,
				solUsdLazer,
				...makerVelocityClient
					.getPerpMarketAccounts()
					.map((account) => account.pubkey),
				...makerVelocityClient
					.getPerpMarketAccounts()
					.map((account) => account.oracle),
				...makerVelocityClient
					.getSpotMarketAccounts()
					.map((account) => account.pubkey),
				...makerVelocityClient
					.getSpotMarketAccounts()
					.map((account) => account.oracle),
				PYTH_LAZER_STORAGE_ACCOUNT_KEY,
			],
		});

		const tx = new Transaction().add(lookupTableInst).add(extendInstruction);
		await makerVelocityClient.sendTransaction(tx);
		console.log(`Lookup table: ${lookupTableAddress.toBase58()}`);

		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		// Create 11 subaccounts so our user is considered toxic
		for (let i = 1; i < 11; i++) {
			await takerVelocityClient.initializeUserAccount(i);
		}

		const userStatsPubkey = getUserStatsAccountPublicKey(
			chProgram.programId,
			takerVelocityClient.wallet.publicKey
		);
		const userStatsData = await bankrunContextWrapper.connection.getAccountInfo(
			userStatsPubkey
		);
		const userStats: UserStatsAccount =
			chProgram.account.userStats.coder.accounts.decodeUnchecked(
				'userStats',
				userStatsData.data
			);

		assert(userStats.numberOfSubAccounts == 11);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(226).mul(PRICE_PRECISION),
			auctionDuration: 30,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		}) as OrderParams;
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
		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		// Get pyth lazer instruction
		const pythLazerCrankIxs =
			await makerVelocityClient.getPostPythLazerOracleUpdateIxs(
				[6],
				PYTH_LAZER_HEX_STRING_SOL_LATER,
				undefined,
				1
			);

		const placeSignedMsgTakerOrderIxs =
			await makerVelocityClient.getPlaceSignedMsgTakerPerpOrderIxs(
				signedOrderParams,
				takerOrderParams.marketIndex,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(),
					takerUserAccount: takerVelocityClient.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerVelocityClient.wallet.publicKey,
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
			oraclePriceOffset: takerOrderParams.oraclePriceOffset ?? ZERO,
			// Rest are not required for DLOB
			price: ZERO,
			maxTs: ZERO,
			triggerPrice: ZERO,
			triggerCondition: OrderTriggerCondition.ABOVE,
			existingPositionDirection: PositionDirection.LONG,
			reduceOnly: false,
			baseAssetAmountFilled: ZERO,
			quoteAssetAmountFilled: ZERO,
			userOrderId: 0,
			bitFlags: 0,
			postedSlotTail: 0,
		};

		const fillIx = await makerVelocityClient.getFillPerpOrderIx(
			takerVelocityClientUser.getUserAccountPublicKey(),
			takerVelocityClientUser.getUserAccount(),
			signedMsgOrder,
			undefined,
			undefined,
			true
		);

		const txMessage = new TransactionMessage({
			payerKey: makerVelocityClient.wallet.publicKey,
			recentBlockhash: (
				await makerVelocityClient.connection.getLatestBlockhash()
			).blockhash,
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

		const txSig = await makerVelocityClient.connection.sendTransaction(
			new VersionedTransaction(message)
		);
		console.log(txSig);

		await takerVelocityClient.fetchAccounts();
		assert(
			takerVelocityClient.getUser().getPerpPosition(0).baseAssetAmount.eq(ZERO)
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('fills signedMsg with trigger orders ', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(84).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(84).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const stopLossTakerParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(80).mul(PRICE_PRECISION),
			triggerPrice: new BN(80).mul(PRICE_PRECISION),
			userOrderId: 2,
			triggerCondition: OrderTriggerCondition.BELOW,
			marketType: MarketType.PERP,
		});

		const takeProfitTakerParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(100).mul(PRICE_PRECISION),
			triggerPrice: new BN(100).mul(PRICE_PRECISION),
			userOrderId: 3,
			triggerCondition: OrderTriggerCondition.ABOVE,
			marketType: MarketType.PERP,
		});

		await takerVelocityClientUser.fetchAccounts();
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(83).mul(PRICE_PRECISION),
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 1,
			marketType: MarketType.PERP,
		}) as OrderParams;

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

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		const ixs = await makerVelocityClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
			signedOrderParams,
			uuid,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			makerOrderParams,
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

		const tx = await makerVelocityClient.buildTransaction(ixs);
		await makerVelocityClient.sendTransaction(tx as Transaction);

		const makerPosition = makerVelocityClient.getUser().getPerpPosition(0);
		assert(makerPosition.baseAssetAmount.eq(BASE_PRECISION.neg().muln(3)));

		const takerPosition = takerVelocityClient.getUser().getPerpPosition(0);

		// All orders are placed and one is
		assert(takerPosition.baseAssetAmount.eq(BASE_PRECISION));
		assert(
			takerVelocityClient
				.getUser()
				.getOpenOrders()
				.some((order) => order.orderId == 1)
		);
		assert(
			takerVelocityClient
				.getUser()
				.getOpenOrders()
				.some((order) => order.orderId == 2)
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should fail if taker order is a limit order without an auction', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(84).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		}) as OrderParams;

		await takerVelocityClientUser.fetchAccounts();
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(83).mul(PRICE_PRECISION),
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 1,
		}) as OrderParams;

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		try {
			await makerVelocityClient.placeAndMakeSignedMsgPerpOrder(
				signedOrderParams,
				uuid,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(),
					takerUserAccount: takerVelocityClient.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerVelocityClient.wallet.publicKey,
				},
				makerOrderParams,
				undefined,
				undefined,
				undefined,
				2
			);
		} catch (e) {
			assert(e);
		}

		const takerPosition = takerVelocityClient.getUser().getPerpPosition(0);
		assert(takerPosition == undefined);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should succeed if taker order is a limit order with an auction', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(85).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(84).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		}) as OrderParams;

		await takerVelocityClientUser.fetchAccounts();

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		try {
			await makerVelocityClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				marketIndex,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(),
					takerUserAccount: takerVelocityClient.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerVelocityClient.wallet.publicKey,
				},
				undefined,
				2
			);
		} catch (e) {
			assert(e);
		}
		await bankrunContextWrapper.moveTimeForward(10);

		await takerVelocityClientUser.fetchAccounts();
		assert(
			convertToNumber(takerVelocityClient.getUser().getOpenOrders()[0].price) ==
				85
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should work with off-chain auctions', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(87).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		}) as OrderParams;
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
		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		await makerVelocityClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			takerOrderParams.marketIndex,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			undefined,
			2
		);

		assert(takerVelocityClient.getOrderByUserId(1) !== undefined);
		assert(takerVelocityClient.getOrderByUserId(1).slot.eq(slot.subn(5)));

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(85).mul(PRICE_PRECISION),
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 1,
		});
		await makerVelocityClient.placeAndMakeSignedMsgPerpOrder(
			signedOrderParams,
			uuid,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			makerOrderParams,
			undefined,
			undefined,
			undefined,
			2
		);

		const takerPosition = takerVelocityClient.getUser().getPerpPosition(0);
		assert(takerPosition.baseAssetAmount.eq(baseAssetAmount));

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should place with high-leverage mode update', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(87).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		}) as OrderParams;
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
		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		await makerVelocityClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			marketIndex,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			undefined,
			2
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should fail if auction params are not set', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(84).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		try {
			await makerVelocityClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				0,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(),
					takerUserAccount: takerVelocityClient.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerVelocityClient.wallet.publicKey,
				},
				undefined,
				2
			);
			assert.fail('Should have failed');
		} catch (error) {
			assert(error.message.includes('custom program error: 0x1890'));
		}

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should verify that auction params are not sanitized', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(10000).mul(PRICE_PRECISION),
			auctionDuration: 50,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		await makerVelocityClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			0,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			undefined,
			2
		);

		assert(
			takerVelocityClientUser
				.getOrderByUserOrderId(1)
				.auctionEndPrice.eq(new BN(10000).mul(PRICE_PRECISION))
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('should fail on malicious subaccount id supplied to custom ix', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		// Create new user account w/ diff subaccount id but same authority
		await takerVelocityClient.initializeUserAccountAndDepositCollateral(
			new BN(1000),
			userUSDCAccount.publicKey,
			0,
			1,
			undefined,
			0
		);

		const takerVelocityClientUser2 = new User({
			velocityClient: takerVelocityClient,
			userAccountPublicKey: await takerVelocityClient.getUserAccountPublicKey(
				1
			),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerVelocityClientUser2.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(10000).mul(PRICE_PRECISION),
			auctionDuration: 50,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		try {
			await makerVelocityClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				0,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(1),
					takerUserAccount: takerVelocityClientUser2.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerVelocityClient.wallet.publicKey,
				},
				undefined,
				2
			);
			assert.fail('Should have failed');
		} catch (error) {
			assert(error);
		}

		const takerPosition = takerVelocityClient.getUser().getPerpPosition(0);
		assert(takerPosition == undefined);

		await takerVelocityClientUser2.unsubscribe();
		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('shouldnt work with improper delegate encoding', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		await takerVelocityClient.updateUserDelegate(
			makerVelocityClient.wallet.publicKey
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(84).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(84).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));

		// Should fail if we try first without encoding properly
		const takerOrderParamsMessage: SignedMsgOrderParamsDelegateMessage = {
			signedMsgOrderParams: takerOrderParams,
			takerPubkey: await takerVelocityClient.getUserAccountPublicKey(),
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};
		let signedOrderParams = makerVelocityClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage,
			false
		);
		try {
			await makerVelocityClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				marketIndex,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(),
					takerUserAccount: takerVelocityClient.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: makerVelocityClient.wallet.publicKey,
				},
				undefined,
				2
			);
			assert.fail('should fail');
		} catch (e) {
			assert(e.toString().includes('0x18a5')); // SignedMsgUserContextUserMismatch
			const takerOrders = takerVelocityClient.getUser().getOpenOrders();
			assert(takerOrders.length == 0);
		}

		signedOrderParams = makerVelocityClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage,
			true
		);
		// Should fail if we dont set delegate as signing authority
		try {
			await makerVelocityClient.placeSignedMsgTakerOrder(
				signedOrderParams,
				marketIndex,
				{
					taker: await takerVelocityClient.getUserAccountPublicKey(),
					takerUserAccount: takerVelocityClient.getUserAccount(),
					takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerVelocityClient.wallet.publicKey,
				},
				undefined,
				2
			);
			assert.fail('should fail');
		} catch (e) {
			assert(e.toString().includes('Error: Invalid option'));
			const takerOrders = takerVelocityClient.getUser().getOpenOrders();
			assert(takerOrders.length == 0);
		}

		const takerOrders = takerVelocityClient.getUser().getOpenOrders();
		assert(takerOrders.length == 0);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('can let user delete their account', async () => {
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();
		await takerVelocityClient.deleteSignedMsgUserOrders();

		assert(
			(await checkIfAccountExists(
				takerVelocityClient.connection,
				getSignedMsgUserAccountPublicKey(
					takerVelocityClient.program.programId,
					takerVelocityClient.authority
				)
			)) == false
		);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('fills signedMsg with max margin ratio and isolated position deposit', async () => {
		slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);
		const [takerVelocityClient, takerVelocityClientUser] =
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
		await takerVelocityClientUser.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(84).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(83).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(84).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;

		await takerVelocityClientUser.fetchAccounts();
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(83).mul(PRICE_PRECISION),
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 1,
			marketType: MarketType.PERP,
		}) as OrderParams;

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			stopLossOrderParams: null,
			takeProfitOrderParams: null,
			maxMarginRatio: 100,
			isolatedPositionDeposit: usdcAmount,
		};

		const signedOrderParams =
			takerVelocityClient.signSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);

		const ixs = await makerVelocityClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
			signedOrderParams,
			uuid,
			{
				taker: await takerVelocityClient.getUserAccountPublicKey(),
				takerUserAccount: takerVelocityClient.getUserAccount(),
				takerStats: takerVelocityClient.getUserStatsAccountPublicKey(),
				signingAuthority: takerVelocityClient.wallet.publicKey,
			},
			makerOrderParams,
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

		const tx = await makerVelocityClient.buildTransaction(ixs);
		await makerVelocityClient.sendTransaction(tx as Transaction);

		const takerPosition = takerVelocityClient.getUser().getPerpPosition(0);

		// All orders are placed and one is
		// @ts-ignore
		assert(takerPosition.maxMarginRatio === 100);
		assert(takerPosition.isolatedPositionScaledBalance.gt(new BN(0)));

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
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
	await bulkAccountLoader.load();
	const wallet = new Wallet(keypair);
	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		bankrunContextWrapper,
		keypair.publicKey
	);
	const takerVelocityClient = new TestClient({
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
	await takerVelocityClient.subscribe();
	await takerVelocityClient.initializeUserAccountAndDepositCollateral(
		usdcAmount,
		userUSDCAccount.publicKey
	);
	const takerVelocityClientUser = new User({
		velocityClient: takerVelocityClient,
		userAccountPublicKey: await takerVelocityClient.getUserAccountPublicKey(),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await takerVelocityClientUser.subscribe();
	return [takerVelocityClient, takerVelocityClientUser];
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
