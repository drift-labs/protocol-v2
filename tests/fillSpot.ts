import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
	Wallet,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import {
	MARGIN_PRECISION,
	PostOnlyParams,
	ReferrerInfo,
	ZERO,
} from '../sdk';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('place and fill spot order', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let fillerDriftClient: TestClient;
	let fillerDriftClientUser: User;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(100 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	const createTestClient = async (
		referrerInfo?: ReferrerInfo
	): Promise<TestClient> => {
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
		const driftClient = new TestClient({
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
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey,
			0,
			0,
			undefined,
			undefined,
			referrerInfo
		);
		await driftClient.updateUserMarginTradingEnabled([
			{ subAccountId: 0, marginTradingEnabled: true },
		]);
		return driftClient;
	};

	before(async () => {
		const context = await startAnchor("", [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, bankrunContextWrapper);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 32.821);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new TestClient({
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
		await fillerDriftClient.initialize(usdcMint.publicKey, true);
		await fillerDriftClient.subscribe();
		await initializeQuoteSpotMarket(fillerDriftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(fillerDriftClient, solUsd);
		await fillerDriftClient.updatePerpAuctionDuration(new BN(0));
		await fillerDriftClient.updateSpotMarketMarginWeights(
			1,
			MARGIN_PRECISION.toNumber() * 0.75,
			MARGIN_PRECISION.toNumber() * 0.8,
			MARGIN_PRECISION.toNumber() * 1.25,
			MARGIN_PRECISION.toNumber() * 1.2
		);

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const oneSol = new BN(LAMPORTS_PER_SOL);
		await fillerDriftClient.deposit(oneSol, 1, bankrunContextWrapper.provider.wallet.publicKey);

		fillerDriftClientUser = new User({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
				},
		});
		await fillerDriftClientUser.subscribe();
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await fillerDriftClientUser.unsubscribe();
	});

	it('fill via match', async () => {
		const takerDriftClient = await createTestClient({
			referrer: fillerDriftClientUser.getUserAccount().authority,
			referrerStats: fillerDriftClient.getUserStatsAccountPublicKey(),
		});
		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
				},
		});
		await takerDriftClientUser.subscribe();

		const makerDriftClient = await createTestClient();
		const makerDriftClientUser = new User({
			driftClient: makerDriftClient,
			userAccountPublicKey: await makerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
				},
		});
		await makerDriftClientUser.subscribe();

		const marketIndex = 1;
		const baseAssetAmount = BASE_PRECISION;

		await makerDriftClient.placeSpotOrder(
			getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				price: new BN(40).mul(PRICE_PRECISION),
				userOrderId: 2,
				postOnly: PostOnlyParams.NONE,
			})
		);
		await makerDriftClientUser.fetchAccounts();
		assert(!makerDriftClientUser.getOrderByUserOrderId(2).postOnly);

		await takerDriftClient.placeSpotOrder(
			getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				price: new BN(41).mul(PRICE_PRECISION),
				// auctionStartPrice: null,
				// auctionEndPrice: null,
				// auctionDuration: 0,
				userOrderId: 1,
				postOnly: PostOnlyParams.NONE,
			})
		);
		await takerDriftClientUser.fetchAccounts();
		const takerOrder = takerDriftClientUser.getOrderByUserOrderId(1);
		assert(!takerOrder.postOnly);

		const fillTx = await fillerDriftClient.fillSpotOrder(
			takerDriftClientUser.getUserAccountPublicKey(),
			takerDriftClientUser.getUserAccount(),
			takerOrder,
			null,
			{
				maker: makerDriftClientUser.getUserAccountPublicKey(),
				makerStats: makerDriftClient.getUserStatsAccountPublicKey(),
				makerUserAccount: makerDriftClientUser.getUserAccount(),
				// order: makerDriftClientUser.getOrderByUserOrderId(2),
			},
			{
				referrer: fillerDriftClientUser.getUserAccount().authority,
				referrerStats: fillerDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		bankrunContextWrapper.connection.printTxLogs(fillTx);

		// const makerUSDCAmount = makerDriftClient.getQuoteAssetTokenAmount();
		// const makerSolAmount = makerDriftClient.getTokenAmount(1);
		// assert(makerUSDCAmount.eq(new BN(140008000)));
		// assert(makerSolAmount.eq(new BN(0)));

		// const takerUSDCAmount = takerDriftClient.getQuoteAssetTokenAmount();
		// const takerSolAmount = takerDriftClient.getTokenAmount(1);
		// assert(takerUSDCAmount.eq(new BN(59960000)));
		// assert(takerSolAmount.eq(new BN(1000000000)));

		console.log(fillerDriftClient.getQuoteAssetTokenAmount().toNumber());

		// successful fill
		assert(fillerDriftClient.getQuoteAssetTokenAmount().gt(ZERO));

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await makerDriftClientUser.unsubscribe();
	});
});
