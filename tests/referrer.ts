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
	ReferrerStatus,
	RevenueShareAccount,
	RevenueShareEscrowAccount,
	RevenueShareEscrowMap,
	getRevenueShareAccountPublicKey,
	isBuilderOrderReferral,
	ZERO,
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
	getLimitOrderParams,
	PEG_PRECISION,
	PositionDirection,
} from '../sdk/src';
import { decodeName } from '../sdk/src/userName';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('referrer', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let referrerDriftClient: TestClient;

	let refereeKeyPair: Keypair;
	let refereeDriftClient: TestClient;
	let refereeUSDCAccount: Keypair;

	let fillerDriftClient: TestClient;

	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let escrowMap: RevenueShareEscrowMap;

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

		solOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			100,
			-7,
			undefined,
			10000
		);

		const marketIndexes = [0];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{
				publicKey: solOracle,
				source: OracleSource.PYTH_LAZER,
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
		// Enable builder-codes so the RevenueShareEscrow referral path is active.
		await referrerDriftClient.updateFeatureBitFlagsBuilderCodes(true);

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

		escrowMap = new RevenueShareEscrowMap(refereeDriftClient, false);
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
		assert((refereeStats.referrerStatus & ReferrerStatus.IsReferred) > 0);

		const referrerStats = referrerDriftClient.getUserStats().getAccount();
		assert((referrerStats.referrerStatus & ReferrerStatus.IsReferrer) > 0);
	});

	it('referrer can initialize a RevenueShare account', async () => {
		await referrerDriftClient.initializeRevenueShare(
			referrerDriftClient.wallet.publicKey
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareAccountPublicKey(
				referrerDriftClient.program.programId,
				referrerDriftClient.wallet.publicKey
			)
		);
		assert(accountInfo !== null, 'RevenueShare account should exist');

		const revShare: RevenueShareAccount =
			referrerDriftClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				accountInfo.data
			);
		assert(
			revShare.authority.toBase58() ===
				referrerDriftClient.wallet.publicKey.toBase58()
		);
		assert(revShare.totalReferrerRewards.toNumber() === 0);
	});

	it('referee can initialize a RevenueShareEscrow', async () => {
		// The referee already has its referrer set on UserStats (from the
		// 'initialize with referrer' test), so initializing the escrow stamps
		// escrow.referrer with the referrer's authority.
		await refereeDriftClient.initializeRevenueShareEscrow(
			refereeDriftClient.wallet.publicKey,
			3
		);

		await escrowMap.slowSync();
		const escrow = (await escrowMap.mustGet(
			refereeDriftClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		assert(
			escrow.authority.toBase58() ===
				refereeDriftClient.wallet.publicKey.toBase58()
		);
		assert(
			escrow.referrer.toBase58() ===
				referrerDriftClient.wallet.publicKey.toBase58(),
			`escrow.referrer ${escrow.referrer.toBase58()} !== referrer ${referrerDriftClient.wallet.publicKey.toBase58()}`
		);
	});

	it('fill order accrues a referral reward to the escrow and settles it', async () => {
		const marketIndex = 0;

		// Referee places a crossing limit long order, filled against the vAMM by
		// the filler. Passing hasBuilderFee=true forces the SDK to attach the
		// referee's RevenueShareEscrow as a remaining account so the on-chain
		// referral reward can be routed into the escrow's Referral order slot.
		const price = new BN(101).mul(PRICE_PRECISION);
		await refereeDriftClient.placePerpOrder(
			getLimitOrderParams({
				baseAssetAmount: BASE_PRECISION,
				direction: PositionDirection.LONG,
				marketIndex,
				price,
			})
		);

		await refereeDriftClient.fetchAccounts();
		const order = refereeDriftClient.getUser().getOpenOrders()[0];

		const txSig = await fillerDriftClient.fillPerpOrder(
			await refereeDriftClient.getUserAccountPublicKey(),
			refereeDriftClient.getUserAccount(),
			{ marketIndex, orderId: order.orderId },
			undefined,
			undefined,
			undefined,
			undefined,
			true // hasBuilderFee -> attach RevenueShareEscrow remaining account
		);

		await eventSubscriber.awaitTx(txSig);

		const eventRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(eventRecord.referrerReward > 0);
		const referrerReward = new BN(eventRecord.referrerReward);

		const refereeStats = refereeDriftClient.getUserStats().getAccount();
		assert(refereeStats.fees.totalRefereeDiscount.gt(ZERO));

		// The referral reward should now be sitting in a Referral-flagged order
		// in the referee's escrow, waiting to be settled.
		await escrowMap.slowSync();
		let escrow = (await escrowMap.mustGet(
			refereeDriftClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const referralOrder = escrow.orders.find(
			(o) => isBuilderOrderReferral(o) && o.marketIndex === marketIndex
		);
		assert(referralOrder !== undefined, 'expected a referral order in escrow');
		assert(
			referralOrder.feesAccrued.eq(referrerReward),
			`referralOrder.feesAccrued ${referralOrder.feesAccrued.toString()} !== referrerReward ${referrerReward.toString()}`
		);
		assert(referralOrder.feesAccrued.gt(ZERO));

		// Snapshot the referrer's RevenueShare before settle.
		const revShareBeforeInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					referrerDriftClient.program.programId,
					referrerDriftClient.wallet.publicKey
				)
			);
		const revShareBefore: RevenueShareAccount =
			referrerDriftClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				revShareBeforeInfo.data
			);

		await bankrunContextWrapper.moveTimeForward(100);

		// Settle the referee's pnl; the escrow map drives the SDK to include the
		// referrer's User + RevenueShare accounts so the sweep can credit them.
		await refereeDriftClient.fetchAccounts();
		await referrerDriftClient.settlePNL(
			await refereeDriftClient.getUserAccountPublicKey(),
			refereeDriftClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			escrowMap
		);

		// Referral slot in the escrow is reset after sweep.
		await escrowMap.slowSync();
		escrow = (await escrowMap.mustGet(
			refereeDriftClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		const referralOrderAfter = escrow.orders.find(
			(o) => isBuilderOrderReferral(o) && o.marketIndex === marketIndex
		);
		assert(referralOrderAfter !== undefined);
		assert(
			referralOrderAfter.feesAccrued.eq(ZERO),
			`referralOrderAfter.feesAccrued ${referralOrderAfter.feesAccrued.toString()} !== 0`
		);

		// Referrer's RevenueShare.totalReferrerRewards increased by the reward.
		const revShareAfterInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					referrerDriftClient.program.programId,
					referrerDriftClient.wallet.publicKey
				)
			);
		const revShareAfter: RevenueShareAccount =
			referrerDriftClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				revShareAfterInfo.data
			);
		const referrerRewardChange = revShareAfter.totalReferrerRewards.sub(
			revShareBefore.totalReferrerRewards
		);
		assert(
			referrerRewardChange.eq(referrerReward),
			`referrerRewardChange ${referrerRewardChange.toString()} !== referrerReward ${referrerReward.toString()}`
		);
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
