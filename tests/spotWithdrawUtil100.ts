import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';
import { setFeedPriceNoProgram } from './testHelpers';
import { PublicKey } from '@solana/web3.js';
import {
	PositionDirection,
	User,
	BASE_PRECISION,
	getLimitOrderParams,
	PostOnlyParams,
} from '../sdk/src';

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
	QUOTE_PRECISION,
	ZERO,
	ONE,
	SPOT_MARKET_BALANCE_PRECISION,
	PRICE_PRECISION,
} from '../sdk/src';

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
} from '../sdk/src/math/spotBalance';
import { NATIVE_MINT } from '@solana/spl-token';
import { ContractTier } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('test function when spot market at >= 100% util', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserDriftClient: TestClient;
	let firstUserDriftClientUSDCAccount: PublicKey;

	let secondUserDriftClient: TestClient;
	let secondUserDriftClientWSOLAccount: PublicKey;
	let secondUserDriftClientUSDCAccount: PublicKey;

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
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

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
		await firstUserDriftClient.unsubscribe();
		await secondUserDriftClient.unsubscribe();
		// await thirdUserDriftClient.unsubscribe();
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
			new BN(10 ** 10).mul(QUOTE_PRECISION)
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
			OracleSource.PYTH,
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
			new BN(10 ** 10).mul(QUOTE_PRECISION)
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
		[firstUserDriftClient, firstUserDriftClientUSDCAccount] =
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
		await firstUserDriftClient.fetchAccounts();
		const txSig = await firstUserDriftClient.deposit(
			usdcAmount,
			marketIndex,
			firstUserDriftClientUSDCAccount
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
		const spotPosition = firstUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(firstUserDriftClient.getUserAccount().totalDeposits.eq(usdcAmount));
	});

	it('Second User Deposit SOL', async () => {
		[
			secondUserDriftClient,
			secondUserDriftClientWSOLAccount,
			secondUserDriftClientUSDCAccount,
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
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
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
			secondUserDriftClient.getUserAccount().spotPositions[1];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			secondUserDriftClient
				.getUserAccount()
				.totalDeposits.eq(new BN(30).mul(PRICE_PRECISION))
		);
	});

	it('Second User Withdraw all USDC', async () => {
		const marketIndex = 0;
		const withdrawAmount = usdcAmount.sub(ONE); // cause borrow rounding
		const txSig = await secondUserDriftClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount
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
			secondUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'borrow'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			secondUserDriftClient.getUserAccount().totalWithdraws.eq(withdrawAmount)
		);
	});

	it('Update Cumulative Interest with 100% utilization', async () => {
		const usdcmarketIndex = 0;
		const oldSpotMarketAccount =
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

		await sleep(200);

		const txSig = await firstUserDriftClient.updateSpotMarketCumulativeInterest(
			usdcmarketIndex
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await firstUserDriftClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

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
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

		await sleep(10000);

		const txSig = await firstUserDriftClient.updateSpotMarketCumulativeInterest(
			usdcmarketIndex
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await firstUserDriftClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

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
			secondUserDriftClient.getSpotMarketAccount(0);
		const util12 = calculateUtilization(spotMarketAccountAfter, ZERO);
		console.log('USDC utilization:', util12.toNumber() / 1e4, '%');

		const marketIndex = 1;

		const updates = [{ marginTradingEnabled: true, subAccountId: 0 }];

		await firstUserDriftClient.updateUserMarginTradingEnabled(updates);

		const takerDriftClientUser = new User({
			driftClient: firstUserDriftClient,
			userAccountPublicKey:
				await firstUserDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const takerUSDCBefore = takerDriftClientUser.getTokenAmount(0);
		const takerSOLBefore = takerDriftClientUser.getTokenAmount(1);

		const makerUSDCBefore = secondUserDriftClient.getUser().getTokenAmount(0);
		const makerSOLBefore = secondUserDriftClient.getUser().getTokenAmount(1);

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
		await firstUserDriftClient.placeSpotOrder(takerOrderParams);
		await takerDriftClientUser.fetchAccounts();
		const order = takerDriftClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(30).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const txSig2 = await secondUserDriftClient.placeAndMakeSpotOrder(
			makerOrderParams,
			{
				taker: await firstUserDriftClient.getUserAccountPublicKey(),
				order: firstUserDriftClient.getOrderByUserId(1),
				takerUserAccount: firstUserDriftClient.getUserAccount(),
				takerStats: firstUserDriftClient.getUserStatsAccountPublicKey(),
			}
		);
		bankrunContextWrapper.printTxLogs(txSig2);
		await firstUserDriftClient.fetchAccounts();
		await takerDriftClientUser.fetchAccounts();
		await secondUserDriftClient.fetchAccounts();

		const takerUSDCAfter = takerDriftClientUser.getTokenAmount(0);
		const takerSOLAfter = takerDriftClientUser.getTokenAmount(1);

		const makerUSDCAfter = secondUserDriftClient.getUser().getTokenAmount(0);
		const makerSOLAfter = secondUserDriftClient.getUser().getTokenAmount(1);

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

		await takerDriftClientUser.unsubscribe();
	});

	it('trade/settle perp pnl at 100% util', async () => {
		const spotMarketAccountAfter =
			secondUserDriftClient.getSpotMarketAccount(0);
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

		const takerDriftClientUser = new User({
			driftClient: firstUserDriftClient,
			userAccountPublicKey:
				await firstUserDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const firstUserSpot = await takerDriftClientUser.getSpotPosition(0);
		console.log('takerDriftClientUser spot 0:', firstUserSpot);
		console.log(
			'taker token amount:',
			takerDriftClientUser.getTokenAmount(0).toString()
		);
		assert(isVariant(firstUserSpot.balanceType, 'borrow'));

		await firstUserDriftClient.placePerpOrder(takerOrderParams);
		await takerDriftClientUser.fetchAccounts();
		const order = takerDriftClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(30.001 * PRICE_PRECISION.toNumber()),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});
		await takerDriftClientUser.fetchAccounts();

		const takerPos = takerDriftClientUser.getPerpPosition(0);
		console.log(
			'takerPos.baseAssetAmount:',
			takerPos.baseAssetAmount.toString()
		);
		assert(takerPos.baseAssetAmount.eq(ZERO));

		const secondUserSpot = (await secondUserDriftClient.getUserAccount())
			.spotPositions[0];
		console.log('secondUserDriftClient spot 0:', secondUserSpot);
		assert(isVariant(secondUserSpot.balanceType, 'deposit'));
		console.log(
			'maker token amount:',
			secondUserDriftClient.getUser().getTokenAmount(0).toString()
		);

		const txSig = await secondUserDriftClient.placeAndMakePerpOrder(
			makerOrderParams,
			{
				taker: await firstUserDriftClient.getUserAccountPublicKey(),
				order: firstUserDriftClient.getOrderByUserId(1),
				takerUserAccount: firstUserDriftClient.getUserAccount(),
				takerStats: firstUserDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		bankrunContextWrapper.printTxLogs(txSig);

		await takerDriftClientUser.fetchAccounts();

		const takerPos2 = takerDriftClientUser.getPerpPosition(0);
		console.log(
			'takerPos.baseAssetAmount after:',
			takerPos2.baseAssetAmount.toString()
		);
		assert(takerPos2.baseAssetAmount.gt(ZERO));

		const takerUSDCBefore = takerDriftClientUser.getTokenAmount(0);
		// const takerSOLBefore = takerDriftClientUser.getTokenAmount(1);

		const makerUSDCBefore = secondUserDriftClient.getUser().getTokenAmount(0);
		// const makerSOLBefore = secondUserDriftClient.getUser().getTokenAmount(1);

		//ensure that borrow cant borrow more to settle pnl
		console.log('set pyth price to 32.99');
		await setFeedPriceNoProgram(bankrunContextWrapper, 32.99, solOracle);
		await firstUserDriftClient.fetchAccounts();
		await secondUserDriftClient.fetchAccounts();

		// settle losing short maker (who has usdc deposit) first
		const settleTx2 = await firstUserDriftClient.settlePNL(
			await secondUserDriftClient.getUserAccountPublicKey(),
			secondUserDriftClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx2);

		const settleTx1 = await firstUserDriftClient.settlePNL(
			await firstUserDriftClient.getUserAccountPublicKey(),
			firstUserDriftClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx1);
		await secondUserDriftClient.fetchAccounts();

		const takerUSDCAfter = takerDriftClientUser.getTokenAmount(0);
		// const takerSOLAfter = takerDriftClientUser.getTokenAmount(1);

		const makerUSDCAfter = secondUserDriftClient.getUser().getTokenAmount(0);
		const solPerpMarketAfter = secondUserDriftClient.getPerpMarketAccount(0);
		console.log(
			'solPerpMarketAfter.pnlPool.scaledBalance:',
			solPerpMarketAfter.pnlPool.scaledBalance
		);
		assert(solPerpMarketAfter.pnlPool.scaledBalance.eq(ZERO));
		// const makerSOLAfter = secondUserDriftClient.getUser().getTokenAmount(1);

		assert(makerUSDCBefore.gt(makerUSDCAfter));
		assert(makerUSDCAfter.eq(ZERO));
		assert(takerUSDCBefore.lte(takerUSDCAfter)); //todo

		//allow that deposit to settle negative pnl for borrow
		console.log('set pyth price to 27.4');
		await setFeedPriceNoProgram(bankrunContextWrapper, 27.4, solOracle);
		await firstUserDriftClient.fetchAccounts();
		await secondUserDriftClient.fetchAccounts();

		const settleTx1Good = await firstUserDriftClient.settlePNL(
			await firstUserDriftClient.getUserAccountPublicKey(),
			firstUserDriftClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx1Good);

		const settleTx2Good = await firstUserDriftClient.settlePNL(
			await secondUserDriftClient.getUserAccountPublicKey(),
			secondUserDriftClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(settleTx2Good);

		await takerDriftClientUser.unsubscribe();
	});
});
