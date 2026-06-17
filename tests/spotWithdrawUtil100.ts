import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';
import {
	setFeedPriceNoProgram,
	getMaxWithdrawGuardThreshold,
} from './testHelpers';
import { PublicKey } from '@solana/web3.js';
import {
	PositionDirection,
	User,
	BASE_PRECISION,
	getLimitOrderParams,
	PostOnlyParams,
} from '../packages/sdk/src';

import {
	TestClient,
	BN,
	EventSubscriber,
	SPOT_MARKET_RATE_PRECISION,
	SpotBalanceType,
	isVariant,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	OracleInfo,
	ZERO,
	ONE,
	SPOT_MARKET_BALANCE_PRECISION,
	PRICE_PRECISION,
} from '../packages/sdk/src';

import {
	createUserWithUSDCAccount,
	createUserWithUSDCAndWSOLAccount,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import {
	getBalance,
	calculateInterestAccumulated,
	calculateUtilization,
} from '../packages/sdk/src/math/spotBalance';
import { NATIVE_MINT } from '@solana/spl-token';
import { ContractTier } from '../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';

describe('test function when spot market at >= 100% util', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserVelocityClient: TestClient;
	let firstUserVelocityClientUSDCAccount: PublicKey;

	let secondUserVelocityClient: TestClient;
	let secondUserVelocityClientWSOLAccount: PublicKey;
	let secondUserVelocityClientUSDCAccount: PublicKey;

	const usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	const solAmount = new BN(1 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

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
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, bankrunContextWrapper);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 30);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH_LAZER }];

		admin = new TestClient({
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

		await admin.initialize(usdcMint.publicKey, true);
		await admin.subscribe();
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
		await firstUserVelocityClient.unsubscribe();
		await secondUserVelocityClient.unsubscribe();
		// await thirdUserVelocityClient.unsubscribe();
	});

	it('Initialize USDC Market', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(500)).toNumber(); // 50000% APR
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		await admin.initializeSpotMarket(
			usdcMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			PublicKey.default,
			OracleSource.QUOTE_ASSET,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);
		const txSig = await admin.updateWithdrawGuardThreshold(
			0,
			await getMaxWithdrawGuardThreshold(admin, 0)
		);
		bankrunContextWrapper.printTxLogs(txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(0);
		assert(spotMarket.marketIndex === 0);
		assert(spotMarket.optimalUtilization === optimalUtilization);
		assert(spotMarket.optimalBorrowRate === optimalRate);
		assert(spotMarket.maxBorrowRate === maxRate);
		assert(spotMarket.decimals === 6);
		assert(
			spotMarket.cumulativeBorrowInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(
			spotMarket.cumulativeDepositInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(spotMarket.initialAssetWeight === initialAssetWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);
		assert(spotMarket.initialLiabilityWeight === initialLiabilityWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);

		assert(admin.getStateAccount().numberOfSpotMarkets === 1);
	});

	it('Initialize SOL spot/perp Market', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(500)).toNumber(); // 50000% APR
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(8))
			.div(new BN(10))
			.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(9))
			.div(new BN(10))
			.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(12))
			.div(new BN(10))
			.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(
			new BN(11)
		)
			.div(new BN(10))
			.toNumber();

		await admin.initializeSpotMarket(
			NATIVE_MINT,
			optimalUtilization,
			optimalRate,
			maxRate,
			solOracle,
			OracleSource.PYTH_LAZER,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);

		const mantissaSqrtScale = new BN(100000);
		const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		await admin.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(1),
			new BN(30_000_000),
			undefined,
			ContractTier.A,
			1000,
			900, // easy to liq
			undefined,
			undefined,
			undefined,
			true,
			2000,
			5000
		);
		await admin.updatePerpMarketCurveUpdateIntensity(0, 100);

		const txSig = await admin.updateWithdrawGuardThreshold(
			1,
			await getMaxWithdrawGuardThreshold(admin, 1)
		);
		bankrunContextWrapper.printTxLogs(txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(1);
		assert(spotMarket.marketIndex === 1);
		assert(spotMarket.optimalUtilization === optimalUtilization);
		assert(spotMarket.optimalBorrowRate === optimalRate);
		assert(spotMarket.maxBorrowRate === maxRate);
		assert(spotMarket.decimals === 9);
		assert(
			spotMarket.cumulativeBorrowInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(
			spotMarket.cumulativeDepositInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(spotMarket.initialAssetWeight === initialAssetWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);
		assert(spotMarket.initialLiabilityWeight === initialLiabilityWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);

		console.log(spotMarket.historicalOracleData);
		assert(spotMarket.historicalOracleData.lastOraclePriceTwapTs.eq(ZERO));

		assert(
			spotMarket.historicalOracleData.lastOraclePrice.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap5Min.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);

		assert(admin.getStateAccount().numberOfSpotMarkets === 2);
	});

	it('First User Deposit USDC', async () => {
		[firstUserVelocityClient, firstUserVelocityClientUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				largeUsdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		const marketIndex = 0;
		await sleep(100);
		await firstUserVelocityClient.fetchAccounts();
		const txSig = await firstUserVelocityClient.deposit(
			usdcAmount,
			marketIndex,
			firstUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(
			spotMarket.depositBalance.eq(
				new BN(10 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);

		const vaultAmount = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)
			).amount.toString()
		);
		assert(vaultAmount.eq(usdcAmount));

		const expectedBalance = getBalance(
			usdcAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const spotPosition =
			firstUserVelocityClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			firstUserVelocityClient.getUserAccount().totalDeposits.eq(usdcAmount)
		);
	});

	it('Second User Deposit SOL', async () => {
		[
			secondUserVelocityClient,
			secondUserVelocityClientWSOLAccount,
			secondUserVelocityClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			solAmount.mul(new BN(1000)),
			largeUsdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader
		);

		const marketIndex = 1;
		const txSig = await secondUserVelocityClient.deposit(
			solAmount,
			marketIndex,
			secondUserVelocityClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(spotMarket.depositBalance.eq(SPOT_MARKET_BALANCE_PRECISION));
		console.log(spotMarket.historicalOracleData);
		assert(spotMarket.historicalOracleData.lastOraclePriceTwapTs.gt(ZERO));
		assert(
			spotMarket.historicalOracleData.lastOraclePrice.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap5Min.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);

		const vaultAmount = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)
			).amount.toString()
		);

		assert(vaultAmount.eq(solAmount));

		const expectedBalance = getBalance(
			solAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const spotPosition =
			secondUserVelocityClient.getUserAccount().spotPositions[1];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			secondUserVelocityClient
				.getUserAccount()
				.totalDeposits.eq(new BN(30).mul(PRICE_PRECISION))
		);
	});

	it('Second User Withdraw all USDC', async () => {
		const marketIndex = 0;
		const withdrawAmount = usdcAmount.sub(ONE); // cause borrow rounding
		const txSig = await secondUserVelocityClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(9999999001);
		console.log('borrowBalance:', spotMarket.borrowBalance.toString());
		assert(spotMarket.borrowBalance.eq(expectedBorrowBalance));

		const vaultAmount = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)
			).amount.toString()
		);

		const expectedVaultAmount = usdcAmount.sub(withdrawAmount);
		assert(vaultAmount.eq(expectedVaultAmount));

		const expectedBalance = getBalance(
			withdrawAmount,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const spotPosition =
			secondUserVelocityClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'borrow'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			secondUserVelocityClient
				.getUserAccount()
				.totalWithdraws.eq(withdrawAmount)
		);
	});

	it('Update Cumulative Interest with 100% utilization', async () => {
		const usdcmarketIndex = 0;
		const oldSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		await sleep(200);

		const txSig =
			await firstUserVelocityClient.updateSpotMarketCumulativeInterest(
				usdcmarketIndex
			);
		bankrunContextWrapper.printTxLogs(txSig);

		await firstUserVelocityClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		const expectedInterestAccumulated = calculateInterestAccumulated(
			oldSpotMarketAccount,
			newSpotMarketAccount.lastInterestTs
		);
		const expectedCumulativeDepositInterest =
			oldSpotMarketAccount.cumulativeDepositInterest.add(
				expectedInterestAccumulated.depositInterest
			);
		const expectedCumulativeBorrowInterest =
			oldSpotMarketAccount.cumulativeBorrowInterest.add(
				expectedInterestAccumulated.borrowInterest
			);

		assert(
			newSpotMarketAccount.cumulativeDepositInterest.eq(
				expectedCumulativeDepositInterest
			)
		);
		console.log(
			newSpotMarketAccount.cumulativeBorrowInterest.sub(ONE).toString(),
			expectedCumulativeBorrowInterest.toString()
		);

		// inconcistent time leads to slight differences over runs?
		assert(
			newSpotMarketAccount.cumulativeBorrowInterest
				.sub(ONE)
				.eq(expectedCumulativeBorrowInterest) ||
				newSpotMarketAccount.cumulativeBorrowInterest.eq(
					expectedCumulativeBorrowInterest
				)
		);
	});

	it('Update Cumulative Interest with 100% utilization (again)', async () => {
		const usdcmarketIndex = 0;
		const oldSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		await sleep(10000);

		const txSig =
			await firstUserVelocityClient.updateSpotMarketCumulativeInterest(
				usdcmarketIndex
			);
		bankrunContextWrapper.printTxLogs(txSig);

		await firstUserVelocityClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		const expectedInterestAccumulated = calculateInterestAccumulated(
			oldSpotMarketAccount,
			newSpotMarketAccount.lastInterestTs
		);
		const expectedCumulativeDepositInterest =
			oldSpotMarketAccount.cumulativeDepositInterest.add(
				expectedInterestAccumulated.depositInterest
			);
		const expectedCumulativeBorrowInterest =
			oldSpotMarketAccount.cumulativeBorrowInterest.add(
				expectedInterestAccumulated.borrowInterest
			);

		assert(
			newSpotMarketAccount.cumulativeDepositInterest.eq(
				expectedCumulativeDepositInterest
			)
		);
		console.log(
			newSpotMarketAccount.cumulativeBorrowInterest.sub(ONE).toString(),
			expectedCumulativeBorrowInterest.toString()
		);

		// inconcistent time leads to slight differences over runs?
		assert(
			newSpotMarketAccount.cumulativeBorrowInterest
				.sub(ONE)
				.eq(expectedCumulativeBorrowInterest) ||
				newSpotMarketAccount.cumulativeBorrowInterest.eq(
					expectedCumulativeBorrowInterest
				)
		);
	});

	it('trade spot at 100% util', async () => {
		const spotMarketAccountAfter =
			secondUserVelocityClient.getSpotMarketAccount(0);
		const util12 = calculateUtilization(spotMarketAccountAfter, ZERO);
		console.log('USDC utilization:', util12.toNumber() / 1e4, '%');

		const marketIndex = 1;

		const updates = [{ marginTradingEnabled: true, subAccountId: 0 }];

		await firstUserVelocityClient.updateUserMarginTradingEnabled(updates);

		const takerVelocityClientUser = new User({
			velocityClient: firstUserVelocityClient,
			userAccountPublicKey:
				await firstUserVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerVelocityClientUser.subscribe();

		const takerUSDCBefore = takerVelocityClientUser.getTokenAmount(0);
		const takerSOLBefore = takerVelocityClientUser.getTokenAmount(1);

		const makerUSDCBefore = secondUserVelocityClient
			.getUser()
			.getTokenAmount(0);
		const makerSOLBefore = secondUserVelocityClient.getUser().getTokenAmount(1);

		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(31).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(30).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(31).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await firstUserVelocityClient.placeSpotOrder(takerOrderParams);
		await takerVelocityClientUser.fetchAccounts();
		const order = takerVelocityClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(30).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 1,
		});

		const txSig2 = await secondUserVelocityClient.placeAndMakeSpotOrder(
			makerOrderParams,
			{
				taker: await firstUserVelocityClient.getUserAccountPublicKey(),
				order: firstUserVelocityClient.getOrderByUserId(1),
				takerUserAccount: firstUserVelocityClient.getUserAccount(),
				takerStats: firstUserVelocityClient.getUserStatsAccountPublicKey(),
			}
		);
		bankrunContextWrapper.printTxLogs(txSig2);
		await firstUserVelocityClient.fetchAccounts();
		await takerVelocityClientUser.fetchAccounts();
		await secondUserVelocityClient.fetchAccounts();

		const takerUSDCAfter = takerVelocityClientUser.getTokenAmount(0);
		const takerSOLAfter = takerVelocityClientUser.getTokenAmount(1);

		const makerUSDCAfter = secondUserVelocityClient.getUser().getTokenAmount(0);
		const makerSOLAfter = secondUserVelocityClient.getUser().getTokenAmount(1);

		console.log(
			'taker usdc:',
			takerUSDCBefore.toString(),
			'->',
			takerUSDCAfter.toString()
		);
		console.log(
			'taker sol:',
			takerSOLBefore.toString(),
			'->',
			takerSOLAfter.toString()
		);

		console.log(
			'maker usdc:',
			makerUSDCBefore.toString(),
			'->',
			makerUSDCAfter.toString()
		);
		console.log(
			'maker sol:',
			makerSOLBefore.toString(),
			'->',
			makerSOLAfter.toString()
		);

		assert(makerUSDCBefore.lt(ZERO));
		assert(makerUSDCAfter.gt(ZERO));
		assert(takerSOLBefore.eq(ZERO));
		assert(takerSOLAfter.gt(ZERO));

		await takerVelocityClientUser.unsubscribe();
	});

	it('trade/settle perp pnl at 100% util', async () => {
		const spotMarketAccountAfter =
			secondUserVelocityClient.getSpotMarketAccount(0);
		const util12 = calculateUtilization(spotMarketAccountAfter, ZERO);
		console.log('USDC utilization:', util12.toNumber() / 1e4, '%');

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(34).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(30.01 * PRICE_PRECISION.toNumber()),
			auctionEndPrice: new BN(32).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});

		const takerVelocityClientUser = new User({
			velocityClient: firstUserVelocityClient,
			userAccountPublicKey:
				await firstUserVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerVelocityClientUser.subscribe();

		const firstUserSpot = await takerVelocityClientUser.getSpotPosition(0);
		console.log('takerVelocityClientUser spot 0:', firstUserSpot);
		console.log(
			'taker token amount:',
			takerVelocityClientUser.getTokenAmount(0).toString()
		);
		assert(isVariant(firstUserSpot.balanceType, 'borrow'));

		await firstUserVelocityClient.placePerpOrder(takerOrderParams);
		await takerVelocityClientUser.fetchAccounts();
		const order = takerVelocityClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(30.001 * PRICE_PRECISION.toNumber()),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 1,
		});
		await takerVelocityClientUser.fetchAccounts();

		const takerPos = takerVelocityClientUser.getPerpPosition(0);
		console.log(
			'takerPos.baseAssetAmount:',
			takerPos.baseAssetAmount.toString()
		);
		assert(takerPos.baseAssetAmount.eq(ZERO));

		const secondUserSpot = (await secondUserVelocityClient.getUserAccount())
			.spotPositions[0];
		console.log('secondUserVelocityClient spot 0:', secondUserSpot);
		assert(isVariant(secondUserSpot.balanceType, 'deposit'));
		console.log(
			'maker token amount:',
			secondUserVelocityClient.getUser().getTokenAmount(0).toString()
		);

		const txSig = await secondUserVelocityClient.placeAndMakePerpOrder(
			makerOrderParams,
			{
				taker: await firstUserVelocityClient.getUserAccountPublicKey(),
				order: firstUserVelocityClient.getOrderByUserId(1),
				takerUserAccount: firstUserVelocityClient.getUserAccount(),
				takerStats: firstUserVelocityClient.getUserStatsAccountPublicKey(),
			}
		);

		bankrunContextWrapper.printTxLogs(txSig);

		await takerVelocityClientUser.fetchAccounts();

		const takerPos2 = takerVelocityClientUser.getPerpPosition(0);
		console.log(
			'takerPos.baseAssetAmount after:',
			takerPos2.baseAssetAmount.toString()
		);
		assert(takerPos2.baseAssetAmount.gt(ZERO));

		const takerUSDCBefore = takerVelocityClientUser.getTokenAmount(0);
		// const takerSOLBefore = takerVelocityClientUser.getTokenAmount(1);

		const makerUSDCBefore = secondUserVelocityClient
			.getUser()
			.getTokenAmount(0);
		// const makerSOLBefore = secondUserVelocityClient.getUser().getTokenAmount(1);

		//ensure that borrow cant borrow more to settle pnl
		console.log('set pyth price to 32.99');
		await setFeedPriceNoProgram(bankrunContextWrapper, 32.99, solOracle);
		await firstUserVelocityClient.fetchAccounts();
		await secondUserVelocityClient.fetchAccounts();

		// settle losing short maker (who has usdc deposit) first
		const settleTx2 = await firstUserVelocityClient.settlePNL(
			await secondUserVelocityClient.getUserAccountPublicKey(),
			secondUserVelocityClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx2);

		const settleTx1 = await firstUserVelocityClient.settlePNL(
			await firstUserVelocityClient.getUserAccountPublicKey(),
			firstUserVelocityClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx1);
		await secondUserVelocityClient.fetchAccounts();

		const takerUSDCAfter = takerVelocityClientUser.getTokenAmount(0);
		// const takerSOLAfter = takerVelocityClientUser.getTokenAmount(1);

		const makerUSDCAfter = secondUserVelocityClient.getUser().getTokenAmount(0);
		const solPerpMarketAfter = secondUserVelocityClient.getPerpMarketAccount(0);
		console.log(
			'solPerpMarketAfter.pnlPool.scaledBalance:',
			solPerpMarketAfter.pnlPool.scaledBalance
		);
		assert(solPerpMarketAfter.pnlPool.scaledBalance.eq(ZERO));
		// const makerSOLAfter = secondUserVelocityClient.getUser().getTokenAmount(1);

		assert(makerUSDCBefore.gt(makerUSDCAfter));
		assert(makerUSDCAfter.eq(ZERO));
		assert(takerUSDCBefore.lte(takerUSDCAfter)); //todo

		//allow that deposit to settle negative pnl for borrow
		console.log('set pyth price to 27.4');
		await setFeedPriceNoProgram(bankrunContextWrapper, 27.4, solOracle);
		await firstUserVelocityClient.fetchAccounts();
		await secondUserVelocityClient.fetchAccounts();

		const settleTx1Good = await firstUserVelocityClient.settlePNL(
			await firstUserVelocityClient.getUserAccountPublicKey(),
			firstUserVelocityClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx1Good);

		const settleTx2Good = await firstUserVelocityClient.settlePNL(
			await secondUserVelocityClient.getUserAccountPublicKey(),
			secondUserVelocityClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx2Good);

		await takerVelocityClientUser.unsubscribe();
	});
});
