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
} from '../../packages/sdk/src';
import { assert } from 'chai';

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import { PERCENTAGE_PRECISION } from '../../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('liquidate perp (no open orders)', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	const liquidatorKeyPair = new Keypair();
	let liquidatorUSDCAccount: Keypair;
	let liquidatorVelocityClient: TestClient;

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

		const oracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
			undefined,
			10000
		);

		velocityClient = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await velocityClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

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

		await velocityClient.updateOracleGuardRails(oracleGuardRails);

		const periodicity = new BN(0);

		await velocityClient.initializePerpMarket(
			0,

			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await velocityClient.transferIsolatedPerpPositionDeposit(
			usdcAmount,
			0,
			undefined,
			undefined,
			undefined,
			true
		);

		await velocityClient.openPosition(
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
		liquidatorVelocityClient = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await liquidatorVelocityClient.subscribe();

		await liquidatorVelocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			liquidatorUSDCAccount.publicKey
		);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await liquidatorVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const marketIndex = 0;

		const velocityClientUser = new User({
			velocityClient: velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

		const oracle = velocityClient.getPerpMarketAccount(0).oracle;
		await setFeedPriceNoProgram(bankrunContextWrapper, 0.9, oracle, 10000);

		await velocityClient.settlePNL(
			velocityClientUser.userAccountPublicKey,
			velocityClientUser.getUserAccount(),
			0
		);

		await setFeedPriceNoProgram(bankrunContextWrapper, 1.1, oracle, 10000);

		await velocityClient.settlePNL(
			velocityClientUser.userAccountPublicKey,
			velocityClientUser.getUserAccount(),
			0
		);

		await velocityClientUser.unsubscribe();

		await setFeedPriceNoProgram(bankrunContextWrapper, 0.1, oracle, 10000);

		const txSig1 =
			await liquidatorVelocityClient.setUserStatusToBeingLiquidated(
				await velocityClient.getUserAccountPublicKey(),
				velocityClient.getUserAccount()
			);
		console.log('setUserStatusToBeingLiquidated txSig:', txSig1);
		assert(velocityClient.getUserAccount().perpPositions[0].positionFlag === 3);

		const txSig = await liquidatorVelocityClient.liquidatePerp(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0,
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

		bankrunContextWrapper.connection.printTxLogs(txSig);

		for (let i = 0; i < 32; i++) {
			assert(
				!isVariant(velocityClient.getUserAccount().orders[i].status, 'open')
			);
		}

		assert(
			liquidatorVelocityClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(17500000000))
		);

		assert(velocityClient.getUserAccount().perpPositions[0].positionFlag === 3);

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

		const _sig2 = await liquidatorVelocityClient.liquidatePerpPnlForDeposit(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0,
			0,
			velocityClient.getUserAccount().perpPositions[0].quoteAssetAmount
		);

		await velocityClient.fetchAccounts();
		assert(velocityClient.getUserAccount().perpPositions[0].positionFlag === 5);
		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-5767726))
		);

		await velocityClient.updatePerpMarketContractTier(0, ContractTier.A);
		const tx1 = await velocityClient.updatePerpMarketMaxImbalances(
			marketIndex,
			new BN(40000).mul(QUOTE_PRECISION),
			QUOTE_PRECISION,
			QUOTE_PRECISION
		);
		bankrunContextWrapper.connection.printTxLogs(tx1);

		await velocityClient.fetchAccounts();
		const marketBeforeBankruptcy =
			velocityClient.getPerpMarketAccount(marketIndex);
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
		assert(marketBeforeBankruptcy.totalSocialLoss.eq(ZERO));
		const _sig = await liquidatorVelocityClient.resolvePerpBankruptcy(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0
		);

		await velocityClient.fetchAccounts();
		// all social loss
		const marketAfterBankruptcy =
			velocityClient.getPerpMarketAccount(marketIndex);
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
			'marketAfterBankruptcy.totalSocialLoss:',
			marketAfterBankruptcy.totalSocialLoss.toString()
		);
		assert(marketAfterBankruptcy.totalSocialLoss.eq(new BN(5767726))); // more goes to socialised loss after removal of fee pool topping up during settlement

		// assert(!velocityClient.getUserAccount().isBankrupt);
		// assert(!velocityClient.getUserAccount().isBeingLiquidated);
		assert(velocityClient.getUserAccount().perpPositions[0].positionFlag === 1);

		console.log(velocityClient.getUserAccount());

		const perpBankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(isVariant(perpBankruptcyRecord.liquidationType, 'perpBankruptcy'));
		assert(perpBankruptcyRecord.perpBankruptcy.marketIndex === 0);
		console.log(perpBankruptcyRecord.perpBankruptcy.pnl.toString());
		console.log(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.toString()
		);
		assert(perpBankruptcyRecord.perpBankruptcy.pnl.eq(new BN(-5767726)));
		console.log(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.toString()
		);
		assert(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.eq(
				new BN(329585000)
			)
		);

		const market = velocityClient.getPerpMarketAccount(0);
		console.log(
			market.cumulativeFundingRateLong.toString(),
			market.cumulativeFundingRateShort.toString()
		);
		assert(market.cumulativeFundingRateLong.eq(new BN(329597500)));
		assert(market.cumulativeFundingRateShort.eq(new BN(-329572500)));
	});
});
