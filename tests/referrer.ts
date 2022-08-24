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
	MARK_PRICE_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteAssetBank,
	createFundedKeyPair,
	createUserWithUSDCAccount,
} from './testHelpers';
import {
	BASE_PRECISION,
	getMarketOrderParams,
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
	const ammReservePrecision = new BN(
		Math.sqrt(MARK_PRICE_PRECISION.toNumber())
	);
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

		const marketIndexes = [new BN(0)];
		const bankIndexes = [new BN(0)];
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
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
			userStats: true,
		});

		await referrerClearingHouse.initialize(usdcMint.publicKey, true);
		await referrerClearingHouse.subscribe();
		await referrerClearingHouse.updateAuctionDuration(0, 10);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await referrerClearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await initializeQuoteAssetBank(referrerClearingHouse, usdcMint.publicKey);

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
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
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
			bankIndexes,
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
				new BN(0),
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

		const depositRecord = eventSubscriber.getEventsArray('DepositRecord')[0];
		assert(depositRecord.referrer.equals(provider.wallet.publicKey));

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
				marketIndex: new BN(0),
			}),
			undefined,
			refereeClearingHouse.getUserStats().getReferrerInfo()
		);

		await eventSubscriber.awaitTx(txSig);

		const eventRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert(eventRecord.referrer.equals(provider.wallet.publicKey));
		assert(eventRecord.takerFee.eq(new BN(950)));
		assert(eventRecord.referrerReward.eq(new BN(50)));
		assert(eventRecord.refereeDiscount.eq(new BN(50)));

		const referrerStats = referrerClearingHouse.getUserStats().getAccount();
		assert(referrerStats.totalReferrerReward.eq(new BN(50)));

		const referrerPosition = referrerClearingHouse.getUser().getUserAccount()
			.positions[0];
		assert(referrerPosition.quoteAssetAmount.eq(new BN(50)));

		const refereeStats = refereeClearingHouse.getUserStats().getAccount();
		assert(refereeStats.fees.totalRefereeDiscount.eq(new BN(50)));

		await refereeClearingHouse.placeAndTake(
			getMarketOrderParams({
				baseAssetAmount: BASE_PRECISION,
				direction: PositionDirection.SHORT,
				marketIndex: new BN(0),
			}),
			undefined,
			refereeClearingHouse.getUserStats().getReferrerInfo()
		);
	});

	it('withdraw', async () => {
		const txSig = await refereeClearingHouse.withdraw(
			usdcAmount.div(new BN(2)),
			new BN(0),
			refereeUSDCAccount.publicKey
		);

		await eventSubscriber.awaitTx(txSig);

		const withdrawRecord = eventSubscriber.getEventsArray('DepositRecord')[0];
		assert(withdrawRecord.referrer.equals(provider.wallet.publicKey));
	});
});
