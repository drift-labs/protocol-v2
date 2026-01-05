import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	ContractTier,
	EventSubscriber,
	isVariant,
	LIQUIDATION_PCT_PRECISION,
	OracleGuardRails,
	OracleSource,
	PositionDirection,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	TestClient,
	User,
	Wallet,
	ZERO,
} from '../sdk/src';
import { assert } from 'chai';

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import { PERCENTAGE_PRECISION } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('liquidate perp (no open orders)', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	const liquidatorKeyPair = new Keypair();
	let liquidatorUSDCAccount: Keypair;
	let liquidatorDriftClient: TestClient;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

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
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION,
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION.muln(100),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(11), // allow 11x change
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,

			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await driftClient.transferIsolatedPerpPositionDeposit(usdcAmount, 0);

		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(175).mul(BASE_PRECISION).div(new BN(10)), // 17.5 SOL
			0,
			new BN(0)
		);

		bankrunContextWrapper.fundKeypair(liquidatorKeyPair, LAMPORTS_PER_SOL);
		liquidatorUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			liquidatorKeyPair.publicKey
		);
		liquidatorDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(liquidatorKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await liquidatorDriftClient.subscribe();

		await liquidatorDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			liquidatorUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const marketIndex = 0;

		const driftClientUser = new User({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const oracle = driftClient.getPerpMarketAccount(0).amm.oracle;
		await setFeedPriceNoProgram(bankrunContextWrapper, 0.9, oracle);

		await driftClient.settlePNL(
			driftClientUser.userAccountPublicKey,
			driftClientUser.getUserAccount(),
			0
		);

		await setFeedPriceNoProgram(bankrunContextWrapper, 1.1, oracle);

		await driftClient.settlePNL(
			driftClientUser.userAccountPublicKey,
			driftClientUser.getUserAccount(),
			0
		);

		await driftClientUser.unsubscribe();

		await setFeedPriceNoProgram(bankrunContextWrapper, 0.1, oracle);

		const txSig1 = await liquidatorDriftClient.setUserStatusToBeingLiquidated(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount()
		);
		console.log('setUserStatusToBeingLiquidated txSig:', txSig1);
		assert(driftClient.getUserAccount().perpPositions[0].positionFlag === 3);

		const txSig = await liquidatorDriftClient.liquidatePerp(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

		bankrunContextWrapper.connection.printTxLogs(txSig);

		for (let i = 0; i < 32; i++) {
			assert(!isVariant(driftClient.getUserAccount().orders[i].status, 'open'));
		}

		assert(
			liquidatorDriftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(17500000000))
		);

		assert(driftClient.getUserAccount().perpPositions[0].positionFlag === 3);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidatePerp'));
		assert(liquidationRecord.liquidatePerp.marketIndex === 0);
		assert(liquidationRecord.canceledOrderIds.length === 0);
		assert(
			liquidationRecord.liquidatePerp.oraclePrice.eq(
				PRICE_PRECISION.div(new BN(10))
			)
		);
		assert(
			liquidationRecord.liquidatePerp.baseAssetAmount.eq(new BN(-17500000000))
		);

		assert(
			liquidationRecord.liquidatePerp.quoteAssetAmount.eq(new BN(1750000))
		);
		assert(liquidationRecord.liquidatePerp.ifFee.eq(new BN(0)));
		assert(liquidationRecord.liquidatePerp.liquidatorFee.eq(new BN(0)));

		const fillRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(fillRecord.action, 'fill'));
		assert(fillRecord.marketIndex === 0);
		assert(isVariant(fillRecord.marketType, 'perp'));
		assert(fillRecord.baseAssetAmountFilled.eq(new BN(17500000000)));
		assert(fillRecord.quoteAssetAmountFilled.eq(new BN(1750000)));
		assert(fillRecord.takerOrderBaseAssetAmount.eq(new BN(17500000000)));
		assert(
			fillRecord.takerOrderCumulativeBaseAssetAmountFilled.eq(
				new BN(17500000000)
			)
		);
		assert(fillRecord.takerFee.eq(new BN(0)));
		assert(isVariant(fillRecord.takerOrderDirection, 'short'));
		assert(fillRecord.makerOrderBaseAssetAmount.eq(new BN(17500000000)));
		assert(
			fillRecord.makerOrderCumulativeBaseAssetAmountFilled.eq(
				new BN(17500000000)
			)
		);
		console.log(fillRecord.makerFee.toString());
		assert(fillRecord.makerFee.eq(new BN(ZERO)));
		assert(isVariant(fillRecord.makerOrderDirection, 'long'));

		assert(fillRecord.takerExistingQuoteEntryAmount.eq(new BN(17500007)));
		assert(fillRecord.takerExistingBaseAssetAmount === null);
		assert(fillRecord.makerExistingQuoteEntryAmount === null);
		assert(fillRecord.makerExistingBaseAssetAmount === null);

		const _sig2 = await liquidatorDriftClient.liquidatePerpPnlForDeposit(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			0,
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount
		);

		await driftClient.fetchAccounts();
		assert(driftClient.getUserAccount().perpPositions[0].positionFlag === 5);
		console.log(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-5767653))
		);

		await driftClient.updatePerpMarketContractTier(0, ContractTier.A);
		const tx1 = await driftClient.updatePerpMarketMaxImbalances(
			marketIndex,
			new BN(40000).mul(QUOTE_PRECISION),
			QUOTE_PRECISION,
			QUOTE_PRECISION
		);
		bankrunContextWrapper.connection.printTxLogs(tx1);

		await driftClient.fetchAccounts();
		const marketBeforeBankruptcy =
			driftClient.getPerpMarketAccount(marketIndex);
		assert(
			marketBeforeBankruptcy.insuranceClaim.revenueWithdrawSinceLastSettle.eq(
				ZERO
			)
		);
		assert(
			marketBeforeBankruptcy.insuranceClaim.quoteSettledInsurance.eq(ZERO)
		);
		assert(
			marketBeforeBankruptcy.insuranceClaim.quoteMaxInsurance.eq(
				QUOTE_PRECISION
			)
		);
		assert(marketBeforeBankruptcy.amm.totalSocialLoss.eq(ZERO));
		const _sig = await liquidatorDriftClient.resolvePerpBankruptcy(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0
		);

		await driftClient.fetchAccounts();
		// all social loss
		const marketAfterBankruptcy = driftClient.getPerpMarketAccount(marketIndex);
		assert(
			marketAfterBankruptcy.insuranceClaim.revenueWithdrawSinceLastSettle.eq(
				ZERO
			)
		);
		assert(marketAfterBankruptcy.insuranceClaim.quoteSettledInsurance.eq(ZERO));
		assert(
			marketAfterBankruptcy.insuranceClaim.quoteMaxInsurance.eq(QUOTE_PRECISION)
		);
		assert(marketAfterBankruptcy.amm.feePool.scaledBalance.eq(ZERO));
		console.log(
			'marketAfterBankruptcy.amm.totalSocialLoss:',
			marketAfterBankruptcy.amm.totalSocialLoss.toString()
		);
		assert(marketAfterBankruptcy.amm.totalSocialLoss.eq(new BN(5750007)));

		// assert(!driftClient.getUserAccount().isBankrupt);
		// assert(!driftClient.getUserAccount().isBeingLiquidated);
		assert(driftClient.getUserAccount().perpPositions[0].positionFlag === 1);

		console.log(driftClient.getUserAccount());
		// assert(
		// 	driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.eq(ZERO)
		// );
		// assert(driftClient.getUserAccount().perpPositions[0].lpShares.eq(ZERO));

		const perpBankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(isVariant(perpBankruptcyRecord.liquidationType, 'perpBankruptcy'));
		assert(perpBankruptcyRecord.perpBankruptcy.marketIndex === 0);
		console.log(perpBankruptcyRecord.perpBankruptcy.pnl.toString());
		console.log(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.toString()
		);
		assert(perpBankruptcyRecord.perpBankruptcy.pnl.eq(new BN(-5767653)));
		console.log(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.toString()
		);
		assert(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.eq(
				new BN(328572000)
			)
		);

		const market = driftClient.getPerpMarketAccount(0);
		console.log(
			market.amm.cumulativeFundingRateLong.toString(),
			market.amm.cumulativeFundingRateShort.toString()
		);
		assert(market.amm.cumulativeFundingRateLong.eq(new BN(328580333)));
		assert(market.amm.cumulativeFundingRateShort.eq(new BN(-328563667)));
	});
});
