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
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	createFundedKeyPair,
	createUserWithUSDCAccount,
	printTxLogs,
} from './testHelpers';
import {
	BASE_PRECISION,
	BulkAccountLoader,
	getMarketOrderParams,
	PEG_PRECISION,
	PositionDirection,
} from '../sdk';
import { decodeName } from '../sdk/lib/userName';

describe('referrer', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let referrerDriftClient: TestClient;

	let refereeKeyPair: Keypair;
	let refereeDriftClient: TestClient;
	let refereeUSDCAccount: Keypair;

	let fillerDriftClient: TestClient;

	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

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
		usdcMint = await mockUSDCMint(provider);
		referrerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider
		);

		solOracle = await mockOracle(100);

		const marketIndexes = [0];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{
				publicKey: solOracle,
				source: OracleSource.PYTH,
			},
		];
		referrerDriftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await referrerDriftClient.initialize();
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

		refereeKeyPair = await createFundedKeyPair(connection);
		refereeUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			refereeKeyPair.publicKey
		);

		refereeDriftClient = new TestClient({
			connection,
			wallet: new Wallet(refereeKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await refereeDriftClient.subscribe();

		[fillerDriftClient] = await createUserWithUSDCAccount(
			provider,
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
		assert(newUserRecord.referrer.equals(provider.wallet.publicKey));

		await refereeDriftClient.fetchAccounts();
		const refereeStats = refereeDriftClient.getUserStats().getAccount();
		assert(refereeStats.referrer.equals(provider.wallet.publicKey));

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

		await printTxLogs(connection, txSig2);
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
