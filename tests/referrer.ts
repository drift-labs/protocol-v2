import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	OracleSource,
	EventSubscriber,
	ClearingHouse,
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
} from './testHelpers';
import {
	BASE_PRECISION,
	getMarketOrderParams,
	PEG_PRECISION,
	PositionDirection,
} from '../sdk';

describe('referrer', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let referrerClearingHouse: Admin;

	let refereeKeyPair: Keypair;
	let refereeClearingHouse: ClearingHouse;
	let refereeUSDCAccount: Keypair;

	let fillerClearingHouse: ClearingHouse;

	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

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
		referrerClearingHouse = new Admin({
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
		});

		await referrerClearingHouse.initialize(usdcMint.publicKey, true);
		await referrerClearingHouse.subscribe();
		await referrerClearingHouse.updatePerpAuctionDuration(0);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await referrerClearingHouse.initializePerpMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(100).mul(PEG_PRECISION)
		);

		await initializeQuoteSpotMarket(referrerClearingHouse, usdcMint.publicKey);

		await referrerClearingHouse.initializeUserAccountAndDepositCollateral(
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

		refereeClearingHouse = new ClearingHouse({
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
		});
		await refereeClearingHouse.subscribe();

		[fillerClearingHouse] = await createUserWithUSDCAccount(
			provider,
			usdcMint,
			chProgram,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos
		);
	});

	after(async () => {
		await referrerClearingHouse.unsubscribe();
		await refereeClearingHouse.unsubscribe();
		await fillerClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize with referrer', async () => {
		const [txSig] =
			await refereeClearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				refereeUSDCAccount.publicKey,
				0,
				0,
				'crisp',
				undefined,
				{
					referrer: await referrerClearingHouse.getUserAccountPublicKey(),
					referrerStats: referrerClearingHouse.getUserStatsAccountPublicKey(),
				}
			);

		await eventSubscriber.awaitTx(txSig);

		const newUserRecord = eventSubscriber.getEventsArray('NewUserRecord')[0];
		assert(newUserRecord.referrer.equals(provider.wallet.publicKey));

		await refereeClearingHouse.fetchAccounts();
		const refereeStats = refereeClearingHouse.getUserStats().getAccount();
		assert(refereeStats.referrer.equals(provider.wallet.publicKey));

		const referrerStats = referrerClearingHouse.getUserStats().getAccount();
		assert(referrerStats.isReferrer == true);
	});

	it('fill order', async () => {
		const txSig = await refereeClearingHouse.placeAndTake(
			getMarketOrderParams({
				baseAssetAmount: BASE_PRECISION,
				direction: PositionDirection.LONG,
				marketIndex: 0,
			}),
			undefined,
			refereeClearingHouse.getUserStats().getReferrerInfo()
		);

		await eventSubscriber.awaitTx(txSig);

		const eventRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(eventRecord.takerFee.eq(new BN(95001)));
		assert(eventRecord.referrerReward === 15000);

		await referrerClearingHouse.fetchAccounts();
		const referrerStats = referrerClearingHouse.getUserStats().getAccount();
		assert(referrerStats.fees.totalReferrerReward.eq(new BN(15000)));

		const referrerPosition = referrerClearingHouse.getUser().getUserAccount()
			.perpPositions[0];
		assert(referrerPosition.quoteAssetAmount.eq(new BN(15000)));

		const refereeStats = refereeClearingHouse.getUserStats().getAccount();
		assert(refereeStats.fees.totalRefereeDiscount.eq(new BN(5000)));

		await refereeClearingHouse.placeAndTake(
			getMarketOrderParams({
				baseAssetAmount: BASE_PRECISION,
				direction: PositionDirection.SHORT,
				marketIndex: 0,
			}),
			undefined,
			refereeClearingHouse.getUserStats().getReferrerInfo()
		);
	});

	it('withdraw', async () => {
		const txSig = await refereeClearingHouse.withdraw(
			usdcAmount.div(new BN(2)),
			0,
			refereeUSDCAccount.publicKey
		);

		await eventSubscriber.awaitTx(txSig);
	});
});
