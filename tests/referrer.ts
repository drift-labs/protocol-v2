import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	OracleSource,
	EventSubscriber,
	Wallet,
	PRICE_PRECISION,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	createFundedKeyPair,
	createUserWithUSDCAccount,
} from './testHelpers';
import {
	BASE_PRECISION,
	getMarketOrderParams,
	PEG_PRECISION,
	PositionDirection,
} from '../sdk';
import { decodeName } from '../sdk/lib/userName';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('referrer', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let referrerDriftClient: TestClient;

	let refereeKeyPair: Keypair;
	let refereeDriftClient: TestClient;
	let refereeUSDCAccount: Keypair;

	let fillerDriftClient: TestClient;

	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let referrerUSDCAccount;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const ammReservePrecision = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		ammReservePrecision
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		ammReservePrecision
	);

	const usdcAmount = new BN(100 * 10 ** 6);

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
		referrerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		const marketIndexes = [0];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{
				publicKey: solOracle,
				source: OracleSource.PYTH,
			},
		];
		referrerDriftClient = new TestClient({
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
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await referrerDriftClient.initialize(usdcMint.publicKey, true);
		await referrerDriftClient.subscribe();
		await referrerDriftClient.updatePerpAuctionDuration(0);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await referrerDriftClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(100).mul(PEG_PRECISION)
		);

		await initializeQuoteSpotMarket(referrerDriftClient, usdcMint.publicKey);

		await referrerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			referrerUSDCAccount.publicKey
		);

		refereeKeyPair = await createFundedKeyPair(bankrunContextWrapper);
		refereeUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			refereeKeyPair.publicKey
		);

		refereeDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(refereeKeyPair),
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
		await refereeDriftClient.subscribe();

		[fillerDriftClient] = await createUserWithUSDCAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader
		);
	});

	after(async () => {
		await referrerDriftClient.unsubscribe();
		await refereeDriftClient.unsubscribe();
		await fillerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize referrer name account', async () => {
		await referrerDriftClient.initializeReferrerName('crisp');
		const referrerNameAccount =
			await referrerDriftClient.fetchReferrerNameAccount('crisp');
		assert(decodeName(referrerNameAccount.name) === 'crisp');
		assert(referrerNameAccount.authority.equals(referrerDriftClient.authority));
		assert(
			referrerNameAccount.user.equals(
				await referrerDriftClient.getUserAccountPublicKey()
			)
		);
	});

	it('initialize with referrer', async () => {
		const [txSig] =
			await refereeDriftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				refereeUSDCAccount.publicKey,
				0,
				0,
				'crisp',
				undefined,
				{
					referrer: await referrerDriftClient.getUserAccountPublicKey(),
					referrerStats: referrerDriftClient.getUserStatsAccountPublicKey(),
				}
			);

		await eventSubscriber.awaitTx(txSig);

		const newUserRecord = eventSubscriber.getEventsArray('NewUserRecord')[0];
		assert(
			newUserRecord.referrer.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);

		await refereeDriftClient.fetchAccounts();
		const refereeStats = refereeDriftClient.getUserStats().getAccount();
		assert(
			refereeStats.referrer.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);

		const referrerStats = referrerDriftClient.getUserStats().getAccount();
		assert(referrerStats.isReferrer == true);
	});

	it('fill order', async () => {
		const txSig = await refereeDriftClient.placeAndTakePerpOrder(
			getMarketOrderParams({
				baseAssetAmount: BASE_PRECISION,
				direction: PositionDirection.LONG,
				marketIndex: 0,
			}),
			undefined,
			refereeDriftClient.getUserStats().getReferrerInfo()
		);

		await eventSubscriber.awaitTx(txSig);

		const eventRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(eventRecord.takerFee.eq(new BN(95001)));
		assert(eventRecord.referrerReward === 15000);

		await referrerDriftClient.fetchAccounts();
		const referrerStats = referrerDriftClient.getUserStats().getAccount();
		assert(referrerStats.fees.totalReferrerReward.eq(new BN(15000)));

		const referrerPosition = referrerDriftClient.getUser().getUserAccount()
			.perpPositions[0];
		assert(referrerPosition.quoteAssetAmount.eq(new BN(15000)));

		const refereeStats = refereeDriftClient.getUserStats().getAccount();
		assert(refereeStats.fees.totalRefereeDiscount.eq(new BN(5000)));

		const txSig2 = await refereeDriftClient.placeAndTakePerpOrder(
			getMarketOrderParams({
				baseAssetAmount: BASE_PRECISION,
				direction: PositionDirection.SHORT,
				marketIndex: 0,
			}),
			undefined,
			refereeDriftClient.getUserStats().getReferrerInfo()
		);

		bankrunContextWrapper.printTxLogs(txSig2);
	});

	it('withdraw', async () => {
		const txSig = await refereeDriftClient.withdraw(
			usdcAmount.div(new BN(2)),
			0,
			refereeUSDCAccount.publicKey
		);

		await eventSubscriber.awaitTx(txSig);
	});
});
