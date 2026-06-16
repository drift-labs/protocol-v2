import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
	Wallet,
	getInsuranceFundStakeAccountPublicKey,
	InsuranceFundStake,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	TestClient,
	convertToNumber,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
	User,
	calculateNetUserPnlImbalance,
	getMarketOrderParams,
	calculateUpdatedAMM,
	oraclePriceBands,
	InsuranceFundRecord,
	OracleGuardRails,
	AMM_RESERVE_PRECISION,
	BID_ASK_SPREAD_PRECISION,
	calculateBidAskPrice,
	ContractTier,
	isVariant,
	MARGIN_PRECISION,
	PerpMarketAccount,
	OraclePriceData,
	SPOT_MARKET_BALANCE_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	sleep,
} from './testHelpers';
import { PERCENTAGE_PRECISION } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

async function depositToFeePoolFromIF(
	amount: number,
	velocityClient: TestClient,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	const txSig00 = await velocityClient.depositIntoPerpMarketFeePool(
		0,
		ifAmount,
		userUSDCAccount.publicKey
	);
	console.log(txSig00);
}

function examineSpread(
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData
) {
	const [bid, ask] = calculateBidAskPrice(market.amm, oraclePriceData, false);
	console.log(
		'bid/ask:',
		bid.toString(),
		'/',
		ask.toString(),
		'oracle:',
		oraclePriceData.price.toString()
	);

	const spread = ask.sub(bid);
	console.log(
		'market spread:',
		'$',
		convertToNumber(spread),
		spread.mul(BID_ASK_SPREAD_PRECISION).div(oraclePriceData.price).toNumber() /
			BID_ASK_SPREAD_PRECISION.toNumber(),
		'%',
		'and max (',
		'$',
		convertToNumber(
			new BN(market.amm.maxSpread)
				.mul(oraclePriceData.price)
				.div(BID_ASK_SPREAD_PRECISION)
		),
		market.amm.maxSpread / BID_ASK_SPREAD_PRECISION.toNumber(),
		'%',

		' margin max=',
		(market.marginRatioInitial - market.marginRatioMaintenance) /
			BID_ASK_SPREAD_PRECISION.toNumber(),
		')'
	);

	const [minPrice, maxPrice] = oraclePriceBands(market, oraclePriceData);
	console.log(
		'min/max:',
		minPrice.toString(),
		'/',
		maxPrice.toString(),
		'(oracle bands)'
	);

	assert(bid.lte(oraclePriceData.price));
	assert(ask.gte(oraclePriceData.price));
	return [bid, ask];
}

describe('imbalanced large perp pnl w/ borrow hitting limits', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let velocityClientLoser: TestClient;
	let velocityClientLoserUser: User;

	let liquidatorVelocityClient: TestClient;
	let liquidatorVelocityClientWSOLAccount: PublicKey;
	let liquidatorVelocityClientWUSDCAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetReserve = new anchor.BN(
		9 * AMM_RESERVE_PRECISION.toNumber()
	).mul(new BN(1000000000));
	const ammInitialBaseAssetReserve = new anchor.BN(
		9 * AMM_RESERVE_PRECISION.toNumber()
	).mul(new BN(1000000000));

	const ammInitialQuoteAssetReserve2 = new anchor.BN(9)
		.mul(AMM_RESERVE_PRECISION)
		.mul(AMM_RESERVE_PRECISION);
	const ammInitialBaseAssetReserve2 = new anchor.BN(9)
		.mul(AMM_RESERVE_PRECISION)
		.mul(AMM_RESERVE_PRECISION);

	assert(ammInitialBaseAssetReserve.eq(ammInitialBaseAssetReserve2));
	assert(ammInitialQuoteAssetReserve.eq(ammInitialQuoteAssetReserve2));

	const usdcAmount = new BN(1000 * 10 ** 6);
	const userKeypair = new Keypair();

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
			usdcAmount.mul(new BN(10000)),
			bankrunContextWrapper
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 43.1337);

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
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

		const oracleGuardrails = velocityClient.getStateAccount().oracleGuardRails;
		oracleGuardrails.priceDivergence.oracleTwap5MinPercentDivergence = new BN(
			12
		).mul(PERCENTAGE_PRECISION);
		await velocityClient.updateOracleGuardRails(oracleGuardrails);

		try {
			await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
			await initializeSolSpotMarket(velocityClient, solOracle);
		} catch (e) {
			console.error(e);
		}
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await velocityClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(42_500_000),
			undefined,
			ContractTier.A,
			1000,
			500,
			undefined,
			undefined,
			undefined,
			true,
			250,
			500
		);
		await velocityClient.updatePerpMarketCurveUpdateIntensity(0, 100);
		await sleep(100);
		await velocityClient.fetchAccounts();
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await bankrunContextWrapper.fundKeypair(userKeypair, 10 ** 9);
		userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			userKeypair.publicKey
		);
		velocityClientLoser = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientLoser.subscribe();
		await sleep(100);
		await velocityClientLoser.fetchAccounts();
		await velocityClientLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		velocityClientLoserUser = new User({
			velocityClient: velocityClientLoser,
			userAccountPublicKey: await velocityClientLoser.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientLoserUser.subscribe();
	});

	it('update amm', async () => {
		const marketAccount0 = velocityClient.getPerpMarketAccount(0);
		assert(marketAccount0.amm.totalFee.eq(ZERO));
		assert(marketAccount0.amm.pegMultiplier.eq(new BN(42500000)));
		assert(marketAccount0.amm.totalFeeMinusDistributions.eq(ZERO));

		await depositToFeePoolFromIF(1000, velocityClient, userUSDCAccount);

		const newPrice = 42.52;
		await setFeedPriceNoProgram(bankrunContextWrapper, newPrice, solOracle);
		console.log('price move to $', newPrice);

		const txSig1 = await velocityClient.updateAMMs([0]);

		bankrunContextWrapper.connection.printTxLogs(txSig1);

		const txSig = await velocityClient.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			0,
			new BN(0)
		);

		bankrunContextWrapper.connection.printTxLogs(txSig);

		await velocityClient.fetchAccounts();
		const userAccount = velocityClient.getUserAccount();
		assert(
			userAccount.perpPositions[0].baseAssetAmount.abs().eq(BASE_PRECISION)
		);

		const marketAccount = velocityClient.getPerpMarketAccount(0);
		assert(marketAccount.amm.totalFee.gt(ZERO));
		assert(marketAccount.amm.pegMultiplier.eq(new BN(42520000)));
		assert(marketAccount.amm.totalFeeMinusDistributions.gt(ZERO));

		const newPrice2 = 42.5;
		await setFeedPriceNoProgram(bankrunContextWrapper, newPrice2, solOracle);
		console.log('price move to $', newPrice2);

		const txSig2 = await velocityClient.updateAMMs([0]);
		bankrunContextWrapper.connection.printTxLogs(txSig2);
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		const uL = velocityClientLoserUser.getUserAccount();
		console.log(
			'uL.spotPositions[0].scaledBalance:',
			uL.spotPositions[0].scaledBalance.toString()
		);
		assert(
			uL.spotPositions[0].scaledBalance.eq(
				new BN(1000 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);

		const bank0Value = velocityClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * QUOTE_PRECISION.toNumber())));

		const velocityClientLoserUserValue = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('velocityClientLoserUserValue:', velocityClientLoserUserValue);
		assert(velocityClientLoserUserValue == 1000); // ??

		// todo
		try {
			const txSig = await velocityClientLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				0,
				new BN(0)
			);
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.log('failed velocityClientLoserc.openPosition');

			console.error(e);
		}

		await velocityClientLoser.fetchAccounts();
		await velocityClientLoserUser.fetchAccounts();

		const velocityClientLoserUserLeverage = convertToNumber(
			velocityClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const velocityClientLoserUserLiqPrice = convertToNumber(
			velocityClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		console.log(
			'velocityClientLoserUser.getLeverage:',
			velocityClientLoserUserLeverage,
			'velocityClientLoserUserLiqPrice:',
			velocityClientLoserUserLiqPrice
		);

		assert(velocityClientLoserUserLeverage < 8.95);
		assert(velocityClientLoserUserLeverage > 8.5);
		assert(velocityClientLoserUserLiqPrice < 42);
		assert(velocityClientLoserUserLiqPrice > 30.5);

		const bank00 = velocityClient.getSpotMarketAccount(0);
		const market00 = velocityClient.getPerpMarketAccount(0);
		assert(market00.amm.feePool.scaledBalance.eq(new BN(1000000000000)));

		console.log('market00 oracle string:', market00.oracle.toString());
		const oraclePriceData00Test = velocityClient.getOraclePriceDataAndSlot(
			market00.oracle
		);
		console.log(oraclePriceData00Test);
		const oraclePriceData00 = velocityClient.getOracleDataForPerpMarket(
			market00.marketIndex
		);

		const imbalance00 = calculateNetUserPnlImbalance(
			market00,
			bank00,
			oraclePriceData00,
			false
		);

		console.log('pnlimbalance00:', imbalance00.toString());
		assert(imbalance00.eq(new BN(-1009821952)));

		const bank0Value1p5 = velocityClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value1p5:', bank0Value1p5.toString());

		const velocityClientLoserUserValue1p5 = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log(
			'velocityClientLoserUserValue1p5:',
			velocityClientLoserUserValue1p5
		);

		const [bid0, ask0] = examineSpread(market00, oraclePriceData00);
		console.log(bid0.toString(), ask0.toString());
		assert(bid0.eq(new BN(42494732)));
		assert(ask0.eq(new BN(42505272)));

		// sol rallys big
		// await velocityClient.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(260.5 * PRICE_PRECISION.toNumber())
		// );
		await setFeedPriceNoProgram(bankrunContextWrapper, 260.5, solOracle);
		console.log('price move to $260.5');
		await sleep(1000);
		await velocityClient.fetchAccounts();

		const oraclePriceData00Again = velocityClient.getOracleDataForPerpMarket(
			market00.marketIndex
		);
		const newAmm00 = calculateUpdatedAMM(market00.amm, oraclePriceData00Again);
		const [bid0After, ask0After] = calculateBidAskPrice(
			newAmm00,
			oraclePriceData00Again
		);
		console.log('bid0After:', bid0After.toString(), ask0After.toString());
		assert(bid0After.eq(new BN(254679585)));
		assert(
			oraclePriceData00Again.price.eq(
				new BN(260.5 * PRICE_PRECISION.toNumber())
			)
		);
		assert(ask0After.eq(new BN(585978468)));
		try {
			const txSig = await velocityClient.updateAMMs([0]);
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		await velocityClientLoser.fetchAccounts();
		await velocityClientLoserUser.fetchAccounts();

		const velocityClientLoserUserLeverage2 = convertToNumber(
			velocityClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const velocityClientLoserUserLiqPrice2 = convertToNumber(
			velocityClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		const bank0Value2 = velocityClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value2:', bank0Value2.toString());

		const velocityClientLoserUserValue2 = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log(
			'velocityClientLoserUserValue2:',
			velocityClientLoserUserValue2
		);

		console.log(
			'velocityClientLoserUser.getLeverage2:',
			velocityClientLoserUserLeverage2,
			'velocityClientLoserUserLiqPrice2:',
			velocityClientLoserUserLiqPrice2,
			'bank0Value2:',
			bank0Value2.toString(),
			'velocityClientLoserUserValue2:',
			velocityClientLoserUserValue2.toString()
		);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorVelocityClient,
			liquidatorVelocityClientWSOLAccount,
			liquidatorVelocityClientWUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			solAmount,
			usdcAmount.mul(new BN(10)),
			[0],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH_LAZER,
				},
			],
			bulkAccountLoader
		);
		await liquidatorVelocityClient.subscribe();

		const bankIndex = 1;
		await liquidatorVelocityClient.deposit(
			solAmount,
			bankIndex,
			liquidatorVelocityClientWSOLAccount
		);
		await liquidatorVelocityClient.deposit(
			usdcAmount.mul(new BN(10)),
			0,
			liquidatorVelocityClientWUSDCAccount
		);

		const bank0 = velocityClient.getSpotMarketAccount(0);
		let market0 = velocityClient.getPerpMarketAccount(0);
		const winnerUser = velocityClient.getUserAccount();
		const loserUser = velocityClientLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		assert(
			market0.quoteAssetAmount.eq(
				winnerUser.perpPositions[0].quoteAssetAmount.add(
					loserUser.perpPositions[0].quoteAssetAmount
				)
			)
		);
		const oraclePriceData0 = velocityClient.getOracleDataForPerpMarket(
			market0.marketIndex
		);
		const [bid1, ask1] = examineSpread(market0, oraclePriceData0);

		console.log('DOUBLE CHECK bids:', bid1.toString(), bid0After.toString());
		console.log('DOUBLE CHECK asks:', ask1.toString(), ask0After.toString());

		// assert(bid1.sub(bid0After).abs().lte(TWO));
		// assert(ask1.sub(ask0After).abs().lte(TWO));

		while (!market0.marketStats.lastOracleValid) {
			const imbalance = calculateNetUserPnlImbalance(
				market0,
				bank0,
				oraclePriceData0,
				false
			);

			console.log('pnlimbalance:', imbalance.toString());
			assert(imbalance.eq(new BN(43462178048))); //44k! :o

			console.log(
				'lastOraclePrice:',
				market0.marketStats.historicalOracleData.lastOraclePrice.toString()
			);
			console.log(
				'lastOracleValid:',
				market0.marketStats.lastOracleValid.toString()
			);
			console.log('lastUpdateSlot:', market0.amm.lastUpdateSlot.toString());

			console.log(
				'lastAskPriceTwap:',
				market0.marketStats.lastAskPriceTwap.toString()
			);
			console.log(
				'lastBidPriceTwap:',
				market0.marketStats.lastBidPriceTwap.toString()
			);
			console.log(
				'lastOraclePriceTwap:',
				market0.marketStats.historicalOracleData.lastOraclePriceTwap.toString()
			);

			try {
				const txSig = await velocityClient.updateAMMs([0]);
				bankrunContextWrapper.connection.printTxLogs(txSig);
			} catch (e) {
				console.error(e);
			}
			velocityClient.fetchAccounts();

			market0 = velocityClient.getPerpMarketAccount(0);
		}
		const oraclePriceData = velocityClient.getOracleDataForPerpMarket(
			market0.marketIndex
		);

		const imbalance = calculateNetUserPnlImbalance(
			market0,
			bank0,
			oraclePriceData,
			false
		);

		console.log('pnlimbalance:', imbalance.toString());
		assert(imbalance.eq(new BN(43462178048))); //44k! :o

		console.log(
			'lastOraclePrice:',
			market0.marketStats.historicalOracleData.lastOraclePrice.toString()
		);
		console.log(
			'lastOracleValid:',
			market0.marketStats.lastOracleValid.toString()
		);
		console.log('lastUpdateSlot:', market0.amm.lastUpdateSlot.toString());

		console.log(
			'lastAskPriceTwap:',
			market0.marketStats.lastAskPriceTwap.toString()
		);
		console.log(
			'lastBidPriceTwap:',
			market0.marketStats.lastBidPriceTwap.toString()
		);
		console.log(
			'lastOraclePriceTwap:',
			market0.marketStats.historicalOracleData.lastOraclePriceTwap.toString()
		);
		assert(market0.marketStats.lastOracleValid == true);
	});
	it('update market imbalance limits', async () => {
		const marketIndex = 0;

		try {
			const txSig = await velocityClient.updateAMMs([0]);
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		const market0 = velocityClient.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		const oraclePriceData0 = velocityClient.getOracleDataForPerpMarket(
			market0.marketIndex
		);
		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData0);
		console.log(prepegAMM.pegMultiplier.toString());
		// assert(prepegAMM.pegMultiplier.eq(new BN(248126)));

		assert(market0.unrealizedPnlMaxImbalance.eq(ZERO));

		await velocityClient.updatePerpMarketContractTier(0, ContractTier.A);
		await velocityClient.fetchAccounts();
		// try {
		const tx1 = await velocityClient.updatePerpMarketMaxImbalances(
			marketIndex,
			new BN(40000).mul(QUOTE_PRECISION),
			QUOTE_PRECISION,
			QUOTE_PRECISION
		);
		bankrunContextWrapper.connection.printTxLogs(tx1);
		// } catch (e) {
		// 	console.error(e);
		// }

		await sleep(1000);
		velocityClient.fetchAccounts();

		const perpMarket = velocityClient.getPerpMarketAccount(marketIndex);
		const quoteSpotMarket = velocityClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const oraclePriceData = velocityClient.getOracleDataForPerpMarket(
			market0.marketIndex
		);

		const imbalance = calculateNetUserPnlImbalance(
			perpMarket,
			quoteSpotMarket,
			oraclePriceData,
			false
		);

		console.log('pnlimbalance:', imbalance.toString());
		assert(imbalance.eq(new BN(43462178048))); //44k still :o

		assert(perpMarket.insuranceClaim.revenueWithdrawSinceLastSettle.eq(ZERO));
		console.log('pnlimbalance:', imbalance.toString());

		assert(
			perpMarket.insuranceClaim.maxRevenueWithdrawPerPeriod.eq(QUOTE_PRECISION)
		);
		// assert(perpMarket.insuranceClaim.lastRevenueWithdrawTs.lt(new BN(now)));
		assert(
			perpMarket.unrealizedPnlMaxImbalance.eq(
				new BN(40000).mul(QUOTE_PRECISION)
			)
		);
		assert(perpMarket.insuranceClaim.quoteSettledInsurance.eq(ZERO));
		assert(perpMarket.insuranceClaim.quoteMaxInsurance.eq(QUOTE_PRECISION));

		console.log(perpMarket.status);
		assert(isVariant(perpMarket.status, 'active'));
		console.log(
			'totalExchangeFee:',
			perpMarket.feeLedger.totalExchangeFee.toString()
		);
		console.log('totalFee:', perpMarket.amm.totalFee.toString());
		console.log('totalMMFee:', perpMarket.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			perpMarket.amm.totalFeeMinusDistributions.toString()
		);

		await velocityClientLoserUser.fetchAccounts();

		const velocityClientLoserUserLeverage = convertToNumber(
			velocityClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const velocityClientLoserUserLiqPrice = convertToNumber(
			velocityClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		console.log(
			'velocityClientLoserUser.getLeverage:',
			velocityClientLoserUserLeverage,
			'velocityClientLoserUserLiqPrice:',
			velocityClientLoserUserLiqPrice
		);
		assert(velocityClientLoserUserLeverage > 1);
	});

	it('whale takes tiny profit', async () => {
		const market0 = velocityClient.getPerpMarketAccount(0);
		assert(market0.marginRatioInitial == 1000);
		assert(market0.marginRatioMaintenance == 500);

		const oraclePriceData0 = velocityClient.getOracleDataForPerpMarket(
			market0.marketIndex
		);
		oraclePriceData0.confidence = new BN(0); //oraclePriceData0.price.div(new BN(1000));
		console.log(
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toString()
		);
		assert(market0.amm.totalFeeMinusDistributions.lt(new BN('0')));

		// assert(market0.amm.totalFeeMinusDistributions.eq(new BN('254313115')));
		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData0);
		const [bid, ask] = examineSpread(market0, oraclePriceData0);
		console.log(
			'prepegAMM.totalFeeMinusDistributions:',
			prepegAMM.totalFeeMinusDistributions.toString()
		);
		assert(
			prepegAMM.totalFeeMinusDistributions.eq(
				market0.amm.totalFeeMinusDistributions
			)
		);

		console.log(prepegAMM.pegMultiplier.toString());
		console.log(bid.toString());
		console.log(ask.toString());
		assert(bid.eq(new BN('255252220')));
		assert(prepegAMM.pegMultiplier.eq(new BN('260434864'))); // lowered by 1 for funding offset change
		assert(oraclePriceData0.price.eq(new BN('260500000')));
		assert(ask.eq(new BN('585978467')));

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = bid.mul(new BN(1000)).div(new BN(1049)); // dont breach oracle price bands

		assert(
			velocityClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.gt(ZERO)
		);
		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction,
			baseAssetAmount,
			price,
		});

		const txSig = await velocityClientLoser.placeAndTakePerpOrder(orderParams);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const market1 = velocityClient.getPerpMarketAccount(0);

		const oraclePriceData1 = velocityClient.getOracleDataForPerpMarket(
			market1.marketIndex
		);
		const prepegAMM1 = calculateUpdatedAMM(market0.amm, oraclePriceData1);
		console.log(prepegAMM1.pegMultiplier.toString());
		assert(prepegAMM1.pegMultiplier.eq(new BN(260434864)));
	});

	it('resolvePerpPnlDeficit', async () => {
		const bankIndex = 0;
		const marketIndex = 0;

		const usdcbalance = (
			await bankrunContextWrapper.connection.getTokenAccount(
				userUSDCAccount.publicKey
			)
		).amount.toString();
		console.log('usdc balance:', usdcbalance);
		assert(usdcbalance == '9998000000000');

		await velocityClient.initializeInsuranceFundStake(bankIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			velocityClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			bankIndex
		);
		const ifStakeAccount =
			(await velocityClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.marketIndex === bankIndex);
		assert(
			ifStakeAccount.authority.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);

		const txSig = await velocityClient.addInsuranceFundStake({
			marketIndex: bankIndex,
			amount: QUOTE_PRECISION.add(QUOTE_PRECISION.div(new BN(100))), // $1.01
			collateralAccountPublicKey: userUSDCAccount.publicKey,
		});
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const market0 = velocityClient.getPerpMarketAccount(marketIndex);

		//will fail
		try {
			const txSig2 = await velocityClient.resolvePerpPnlDeficit(
				bankIndex,
				marketIndex
			);
			bankrunContextWrapper.connection.printTxLogs(txSig2);
		} catch (e) {
			console.error(e);
		}

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(12).mul(PERCENTAGE_PRECISION),
				oracleTwap5MinPercentDivergence: new BN(100).mul(PERCENTAGE_PRECISION),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(1000),
			},
		};

		await velocityClient.updateOracleGuardRails(oracleGuardRails);
		const txSig2 = await velocityClient.resolvePerpPnlDeficit(
			bankIndex,
			marketIndex
		);
		bankrunContextWrapper.connection.printTxLogs(txSig2);

		const ifRecord: InsuranceFundRecord = eventSubscriber.getEventsArray(
			'InsuranceFundRecord'
		)[0];
		console.log(ifRecord);
		assert(ifRecord.vaultAmountBefore.eq(new BN('13000000000')));
		assert(ifRecord.insuranceVaultAmountBefore.eq(new BN('1010000')));
		assert(ifRecord.amount.eq(new BN('-1000000')));

		assert(ifRecord.amount.eq(new BN('-1000000')));

		await velocityClient.fetchAccounts();

		const perpMarket = velocityClient.getPerpMarketAccount(marketIndex);
		const quoteSpotMarket = velocityClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const oraclePriceData = velocityClient.getOracleDataForPerpMarket(
			perpMarket.marketIndex
		);

		const imbalance = calculateNetUserPnlImbalance(
			perpMarket,
			quoteSpotMarket,
			oraclePriceData,
			false
		);

		console.log('pnlimbalance:', imbalance.toString());

		// more volatile now based on runtime
		const expectedOffset = (43461178048 + 43461050931 + 43461032413) / 3; // 43454489193; // used to be 43454561797
		assert(imbalance.lt(new BN(expectedOffset + 300000))); //44k still :o
		assert(imbalance.gt(new BN(expectedOffset - 300000))); //44k still :o

		console.log(
			'revenueWithdrawSinceLastSettle:',
			perpMarket.insuranceClaim.revenueWithdrawSinceLastSettle.toString()
		);
		assert(
			perpMarket.insuranceClaim.revenueWithdrawSinceLastSettle.eq(
				QUOTE_PRECISION
			)
		);
		console.log(
			'market.insuranceClaim.maxRevenueWithdrawPerPeriod:',
			perpMarket.insuranceClaim.maxRevenueWithdrawPerPeriod.toString()
		);

		assert(
			perpMarket.insuranceClaim.maxRevenueWithdrawPerPeriod.eq(QUOTE_PRECISION)
		);
		assert(
			perpMarket.insuranceClaim.lastRevenueWithdrawTs.gt(
				market0.insuranceClaim.lastRevenueWithdrawTs
			)
		);
		assert(
			perpMarket.unrealizedPnlMaxImbalance.eq(
				new BN(40000).mul(QUOTE_PRECISION)
			)
		);

		assert(perpMarket.insuranceClaim.quoteSettledInsurance.eq(QUOTE_PRECISION));
		assert(perpMarket.insuranceClaim.quoteMaxInsurance.eq(QUOTE_PRECISION));
		console.log(
			'market0.pnlPool.scaledBalance:',

			market0.pnlPool.scaledBalance.toString(),
			'->',
			perpMarket.pnlPool.scaledBalance.toString()
		);
		assert(perpMarket.pnlPool.scaledBalance.gt(market0.pnlPool.scaledBalance));

		console.log(perpMarket.status);
		assert(isVariant(perpMarket.status, 'active'));
		console.log(
			'totalExchangeFee:',
			perpMarket.feeLedger.totalExchangeFee.toString()
		);
		console.log('totalFee:', perpMarket.amm.totalFee.toString());
		console.log('totalMMFee:', perpMarket.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			perpMarket.amm.totalFeeMinusDistributions.toString()
		);
	});

	// it('liq and settle expired market position', async () => {
	// 	const marketIndex = 0;
	// 	const loserUser0 = velocityClientLoser.getUserAccount();
	// 	assert(loserUser0.perpPositions[0].baseAssetAmount.gt(0));
	// 	assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(0));
	// 	// console.log(loserUser0.perpPositions[0]);

	// 	const liquidatorVelocityClientUser = new User({
	// 		velocityClient: liquidatorVelocityClient,
	// 		userAccountPublicKey:
	// 			await liquidatorVelocityClient.getUserAccountPublicKey(),
	// 	});
	// 	await liquidatorVelocityClientUser.subscribe();

	// 	const liquidatorVelocityClientValue = convertToNumber(
	// 		liquidatorVelocityClientUser.getTotalCollateral(),
	// 		QUOTE_PRECISION
	// 	);
	// 	console.log(
	// 		'liquidatorVelocityClientValue:',
	// 		liquidatorVelocityClientValue.toString()
	// 	);

	// 	const txSigLiq = await liquidatorVelocityClient.liquidatePerp(
	// 		await velocityClientLoser.getUserAccountPublicKey(),
	// 		velocityClientLoser.getUserAccount(),
	// 		marketIndex,
	// 		BASE_PRECISION.mul(new BN(290))
	// 	);

	// 	console.log(txSigLiq);

	// 	const liquidatorVelocityClientValueAfter = convertToNumber(
	// 		liquidatorVelocityClientUser.getTotalCollateral(),
	// 		QUOTE_PRECISION
	// 	);
	// 	console.log(
	// 		'liquidatorVelocityClientValueAfter:',
	// 		liquidatorVelocityClientValueAfter.toString()
	// 	);

	// 	console.log('settle position velocityClientLoser');
	// 	const txSig = await velocityClientLoser.settleExpiredPosition(
	// 		await velocityClientLoser.getUserAccountPublicKey(),
	// 		velocityClientLoser.getUserAccount(),
	// 		marketIndex
	// 	);
	// 	await printTxLogs(connection, txSig);

	// 	console.log('settle pnl velocityClientLoser');

	// 	try {
	// 		await velocityClient.settlePNL(
	// 			await velocityClient.getUserAccountPublicKey(),
	// 			velocityClient.getUserAccount(),
	// 			marketIndex
	// 		);
	// 	} catch (e) {
	// 		// if (!e.toString().search('AnchorError occurred')) {
	// 		// 	assert(false);
	// 		// }
	// 		console.log('Cannot settle pnl under current market status');
	// 	}

	// 	// const settleRecord = eventSubscriber.getEventsArray('SettlePnlRecord')[0];
	// 	// console.log(settleRecord);

	// 	await velocityClientLoser.fetchAccounts();
	// 	const loserUser = velocityClientLoser.getUserAccount();
	// 	// console.log(loserUser.perpPositions[0]);
	// 	assert(loserUser.perpPositions[0].baseAssetAmount.eq(0));
	// 	assert(loserUser.perpPositions[0].quoteAssetAmount.eq(0));
	// 	const marketAfter0 = velocityClient.getPerpMarketAccount(marketIndex);

	// 	const finalPnlResultMin0 = new BN(1415296436 - 11090);
	// 	const finalPnlResultMax0 = new BN(1415296436 + 111090);

	// 	console.log(marketAfter0.pnlPool.scaledBalance.toString());
	// 	assert(marketAfter0.pnlPool.scaledBalance.gt(finalPnlResultMin0));
	// 	assert(marketAfter0.pnlPool.scaledBalance.lt(finalPnlResultMax0));

	// 	// const ammPnlResult = 0;
	// 	console.log('feePool:', marketAfter0.amm.feePool.scaledBalance.toString());
	// 	console.log(
	// 		'totalExchangeFee:',
	// 		marketAfter0.feeLedger.totalExchangeFee.toString()
	// 	);
	// 	assert(marketAfter0.amm.feePool.scaledBalance.eq(new BN(4356250)));
	// 	await liquidatorVelocityClientUser.unsubscribe();
	// });
});
