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
} from '../packages/sdk/src';

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
} from '../packages/sdk/src';
import { decodeName } from '../packages/sdk/src/userName';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';

describe('referrer', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let referrerVelocityClient: TestClient;

	let refereeKeyPair: Keypair;
	let refereeVelocityClient: TestClient;
	let refereeUSDCAccount: Keypair;

	let fillerVelocityClient: TestClient;

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
		referrerVelocityClient = new TestClient({
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

		await referrerVelocityClient.initialize(usdcMint.publicKey, true);
		await referrerVelocityClient.subscribe();
		await referrerVelocityClient.updatePerpAuctionDuration(0);
		// Enable builder-codes so the RevenueShareEscrow referral path is active.
		await referrerVelocityClient.updateFeatureBitFlagsBuilderCodes(true);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await referrerVelocityClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(100).mul(PEG_PRECISION)
		);

		await initializeQuoteSpotMarket(referrerVelocityClient, usdcMint.publicKey);

		await referrerVelocityClient.initializeUserAccountAndDepositCollateral(
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

		refereeVelocityClient = new TestClient({
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
		await refereeVelocityClient.subscribe();

		[fillerVelocityClient] = await createUserWithUSDCAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader
		);

		escrowMap = new RevenueShareEscrowMap(refereeVelocityClient, false);
	});

	after(async () => {
		await referrerVelocityClient.unsubscribe();
		await refereeVelocityClient.unsubscribe();
		await fillerVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize referrer name account', async () => {
		await referrerVelocityClient.initializeReferrerName('crisp');
		const referrerNameAccount =
			await referrerVelocityClient.fetchReferrerNameAccount('crisp');
		assert(decodeName(referrerNameAccount.name) === 'crisp');
		assert(
			referrerNameAccount.authority.equals(referrerVelocityClient.authority)
		);
		assert(
			referrerNameAccount.user.equals(
				await referrerVelocityClient.getUserAccountPublicKey()
			)
		);
	});

	it('initialize with referrer', async () => {
		const [txSig] =
			await refereeVelocityClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				refereeUSDCAccount.publicKey,
				0,
				0,
				'crisp',
				undefined,
				{
					referrer: await referrerVelocityClient.getUserAccountPublicKey(),
					referrerStats: referrerVelocityClient.getUserStatsAccountPublicKey(),
				}
			);

		await eventSubscriber.awaitTx(txSig);

		const newUserRecord = eventSubscriber.getEventsArray('NewUserRecord')[0];
		assert(
			newUserRecord.referrer.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);

		await refereeVelocityClient.fetchAccounts();
		const refereeStats = refereeVelocityClient.getUserStats().getAccount();
		assert(
			refereeStats.referrer.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);
		assert((refereeStats.referrerStatus & ReferrerStatus.IsReferred) > 0);

		const referrerStats = referrerVelocityClient.getUserStats().getAccount();
		assert((referrerStats.referrerStatus & ReferrerStatus.IsReferrer) > 0);
	});

	it('referrer can initialize a RevenueShare account', async () => {
		await referrerVelocityClient.initializeRevenueShare(
			referrerVelocityClient.wallet.publicKey
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareAccountPublicKey(
				referrerVelocityClient.program.programId,
				referrerVelocityClient.wallet.publicKey
			)
		);
		assert(accountInfo !== null, 'RevenueShare account should exist');

		const revShare: RevenueShareAccount =
			referrerVelocityClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				accountInfo.data
			);
		assert(
			revShare.authority.toBase58() ===
				referrerVelocityClient.wallet.publicKey.toBase58()
		);
		assert(revShare.totalReferrerRewards.toNumber() === 0);
	});

	it('referee can initialize a RevenueShareEscrow', async () => {
		// The referee already has its referrer set on UserStats (from the
		// 'initialize with referrer' test), so initializing the escrow stamps
		// escrow.referrer with the referrer's authority.
		await refereeVelocityClient.initializeRevenueShareEscrow(
			refereeVelocityClient.wallet.publicKey,
			3
		);

		await escrowMap.slowSync();
		const escrow = (await escrowMap.mustGet(
			refereeVelocityClient.wallet.publicKey.toBase58()
		)) as RevenueShareEscrowAccount;
		assert(
			escrow.authority.toBase58() ===
				refereeVelocityClient.wallet.publicKey.toBase58()
		);
		assert(
			escrow.referrer.toBase58() ===
				referrerVelocityClient.wallet.publicKey.toBase58(),
			`escrow.referrer ${escrow.referrer.toBase58()} !== referrer ${referrerVelocityClient.wallet.publicKey.toBase58()}`
		);
	});

	it('fill order accrues a referral reward to the escrow and settles it', async () => {
		const marketIndex = 0;

		// Referee places a crossing limit long order, filled against the vAMM by
		// the filler. Passing hasBuilderFee=true forces the SDK to attach the
		// referee's RevenueShareEscrow as a remaining account so the on-chain
		// referral reward can be routed into the escrow's Referral order slot.
		const price = new BN(101).mul(PRICE_PRECISION);
		await refereeVelocityClient.placePerpOrder(
			getLimitOrderParams({
				baseAssetAmount: BASE_PRECISION,
				direction: PositionDirection.LONG,
				marketIndex,
				price,
			})
		);

		await refereeVelocityClient.fetchAccounts();
		const order = refereeVelocityClient.getUser().getOpenOrders()[0];

		const txSig = await fillerVelocityClient.fillPerpOrder(
			await refereeVelocityClient.getUserAccountPublicKey(),
			refereeVelocityClient.getUserAccount(),
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

		const refereeStats = refereeVelocityClient.getUserStats().getAccount();
		assert(refereeStats.fees.totalRefereeDiscount.gt(ZERO));

		// The referral reward should now be sitting in a Referral-flagged order
		// in the referee's escrow, waiting to be settled.
		await escrowMap.slowSync();
		let escrow = (await escrowMap.mustGet(
			refereeVelocityClient.wallet.publicKey.toBase58()
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
					referrerVelocityClient.program.programId,
					referrerVelocityClient.wallet.publicKey
				)
			);
		const revShareBefore: RevenueShareAccount =
			referrerVelocityClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'revenueShare',
				revShareBeforeInfo.data
			);

		await bankrunContextWrapper.moveTimeForward(100);

		// Settle the referee's pnl; the escrow map drives the SDK to include the
		// referrer's User + RevenueShare accounts so the sweep can credit them.
		await refereeVelocityClient.fetchAccounts();
		await referrerVelocityClient.settlePNL(
			await refereeVelocityClient.getUserAccountPublicKey(),
			refereeVelocityClient.getUserAccount(),
			marketIndex,
			undefined,
			undefined,
			escrowMap
		);

		// Referral slot in the escrow is reset after sweep.
		await escrowMap.slowSync();
		escrow = (await escrowMap.mustGet(
			refereeVelocityClient.wallet.publicKey.toBase58()
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
					referrerVelocityClient.program.programId,
					referrerVelocityClient.wallet.publicKey
				)
			);
		const revShareAfter: RevenueShareAccount =
			referrerVelocityClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
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
		const txSig = await refereeVelocityClient.withdraw(
			usdcAmount.div(new BN(2)),
			0,
			refereeUSDCAccount.publicKey
		);

		await eventSubscriber.awaitTx(txSig);
	});
});
