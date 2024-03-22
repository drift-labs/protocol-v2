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
	MarketStatus,
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
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	printTxLogs,
	sleep,
} from './testHelpers';
import { BulkAccountLoader, PERCENTAGE_PRECISION } from '../sdk';

async function depositToFeePoolFromIF(
	amount: number,
	driftClient: TestClient,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	const txSig00 = await driftClient.depositIntoPerpMarketFeePool(
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
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let driftClientLoser: TestClient;
	let driftClientLoserUser: User;

	let liquidatorDriftClient: TestClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;
	let liquidatorDriftClientWUSDCAccount: PublicKey;

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
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(10000)),
			provider
		);

		solOracle = await mockOracle(43.1337);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
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

		const oracleGuardrails = driftClient.getStateAccount().oracleGuardRails;
		oracleGuardrails.priceDivergence.oracleTwap5MinPercentDivergence = new BN(
			12
		).mul(PERCENTAGE_PRECISION);
		await driftClient.updateOracleGuardRails(oracleGuardrails);

		try {
			await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
			await initializeSolSpotMarket(driftClient, solOracle);
		} catch (e) {
			console.error(e);
		}
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(42_500_000),
			undefined,
			1000,
			500
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
		await driftClient.updatePerpMarketBaseSpread(0, 250);
		await driftClient.updatePerpMarketCurveUpdateIntensity(0, 100);
		await sleep(100);
		await driftClient.fetchAccounts();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		driftClientLoser = new TestClient({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientLoser.subscribe();
		await sleep(100);
		await driftClientLoser.fetchAccounts();
		await driftClientLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		driftClientLoserUser = new User({
			driftClient: driftClientLoser,
			userAccountPublicKey: await driftClientLoser.getUserAccountPublicKey(),
		});
		await driftClientLoserUser.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientLoser.unsubscribe();
		await driftClientLoserUser.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('update amm', async () => {
		const marketAccount0 = driftClient.getPerpMarketAccount(0);
		assert(marketAccount0.amm.totalFee.eq(ZERO));
		assert(marketAccount0.amm.pegMultiplier.eq(new BN(42500000)));
		assert(marketAccount0.amm.totalFeeMinusDistributions.eq(ZERO));

		await depositToFeePoolFromIF(1000, driftClient, userUSDCAccount);

		const newPrice = 42.52;
		await setFeedPrice(anchor.workspace.Pyth, newPrice, solOracle);
		console.log('price move to $', newPrice);

		const txSig1 = await driftClient.updateAMMs([0]);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig1, { commitment: 'confirmed' }))
				.meta.logMessages
		);

		const txSig = await driftClient.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		await printTxLogs(connection, txSig);
		await driftClient.fetchAccounts();
		const userAccount = driftClient.getUserAccount();
		assert(
			userAccount.perpPositions[0].baseAssetAmount.abs().eq(BASE_PRECISION)
		);

		const marketAccount = driftClient.getPerpMarketAccount(0);
		assert(marketAccount.amm.totalFee.gt(ZERO));
		assert(marketAccount.amm.pegMultiplier.eq(new BN(42520000)));
		assert(marketAccount.amm.totalFeeMinusDistributions.gt(ZERO));

		const newPrice2 = 42.5;
		await setFeedPrice(anchor.workspace.Pyth, newPrice2, solOracle);
		console.log('price move to $', newPrice2);

		const txSig2 = await driftClient.updateAMMs([0]);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig2, { commitment: 'confirmed' }))
				.meta.logMessages
		);
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		const uL = driftClientLoserUser.getUserAccount();
		console.log(
			'uL.spotPositions[0].scaledBalance:',
			uL.spotPositions[0].scaledBalance.toString()
		);
		assert(
			uL.spotPositions[0].scaledBalance.eq(
				new BN(1000 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);

		const bank0Value = driftClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * QUOTE_PRECISION.toNumber())));

		const driftClientLoserUserValue = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('driftClientLoserUserValue:', driftClientLoserUserValue);
		assert(driftClientLoserUserValue == 1000); // ??

		// todo
		try {
			const txSig = await driftClientLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				0,
				new BN(0)
			);
			await printTxLogs(connection, txSig);
		} catch (e) {
			console.log('failed driftClientLoserc.openPosition');

			console.error(e);
		}

		await driftClientLoser.fetchAccounts();
		await driftClientLoserUser.fetchAccounts();

		const driftClientLoserUserLeverage = convertToNumber(
			driftClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const driftClientLoserUserLiqPrice = convertToNumber(
			driftClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		console.log(
			'driftClientLoserUser.getLeverage:',
			driftClientLoserUserLeverage,
			'driftClientLoserUserLiqPrice:',
			driftClientLoserUserLiqPrice
		);

		assert(driftClientLoserUserLeverage < 8.95);
		assert(driftClientLoserUserLeverage > 8.5);
		assert(driftClientLoserUserLiqPrice < 42);
		assert(driftClientLoserUserLiqPrice > 30.5);

		const bank00 = driftClient.getSpotMarketAccount(0);
		const market00 = driftClient.getPerpMarketAccount(0);
		assert(market00.amm.feePool.scaledBalance.eq(new BN(1000000000000)));

		console.log('market00 oracle string:', market00.amm.oracle.toString());
		const oraclePriceData00Test = driftClient.getOraclePriceDataAndSlot(
			market00.amm.oracle
		);
		console.log(oraclePriceData00Test);
		const oraclePriceData00 = driftClient.getOracleDataForPerpMarket(
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

		const bank0Value1p5 = driftClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value1p5:', bank0Value1p5.toString());

		const driftClientLoserUserValue1p5 = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('driftClientLoserUserValue1p5:', driftClientLoserUserValue1p5);

		const [bid0, ask0] = examineSpread(market00, oraclePriceData00);
		console.log(bid0.toString(), ask0.toString());
		assert(bid0.eq(new BN(42494732)));
		assert(ask0.eq(new BN(42505272)));

		// sol rallys big
		// await driftClient.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(260.5 * PRICE_PRECISION.toNumber())
		// );
		await setFeedPrice(anchor.workspace.Pyth, 260.5, solOracle);
		console.log('price move to $260.5');
		await sleep(1000);
		await driftClient.fetchAccounts();

		const oraclePriceData00Again = driftClient.getOracleDataForPerpMarket(
			market00.marketIndex
		);
		const newAmm00 = calculateUpdatedAMM(market00.amm, oraclePriceData00Again);
		const [bid0After, ask0After] = calculateBidAskPrice(
			newAmm00,
			oraclePriceData00Again
		);
		console.log('bid0After:', bid0After.toString(), ask0After.toString());
		assert(bid0After.eq(new BN(249149540)));
		assert(
			oraclePriceData00Again.price.eq(
				new BN(260.5 * PRICE_PRECISION.toNumber())
			)
		);
		assert(ask0After.eq(new BN(572204530)));
		try {
			const txSig = await driftClient.updateAMMs([0]);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		await driftClientLoser.fetchAccounts();
		await driftClientLoserUser.fetchAccounts();

		const driftClientLoserUserLeverage2 = convertToNumber(
			driftClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const driftClientLoserUserLiqPrice2 = convertToNumber(
			driftClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		const bank0Value2 = driftClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value2:', bank0Value2.toString());

		const driftClientLoserUserValue2 = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('driftClientLoserUserValue2:', driftClientLoserUserValue2);

		console.log(
			'driftClientLoserUser.getLeverage2:',
			driftClientLoserUserLeverage2,
			'driftClientLoserUserLiqPrice2:',
			driftClientLoserUserLiqPrice2,
			'bank0Value2:',
			bank0Value2.toString(),
			'driftClientLoserUserValue2:',
			driftClientLoserUserValue2.toString()
		);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorDriftClient,
			liquidatorDriftClientWSOLAccount,
			liquidatorDriftClientWUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			chProgram,
			solAmount,
			usdcAmount.mul(new BN(10)),
			[0],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			bulkAccountLoader
		);
		await liquidatorDriftClient.subscribe();

		const bankIndex = 1;
		await liquidatorDriftClient.deposit(
			solAmount,
			bankIndex,
			liquidatorDriftClientWSOLAccount
		);
		await liquidatorDriftClient.deposit(
			usdcAmount.mul(new BN(10)),
			0,
			liquidatorDriftClientWUSDCAccount
		);

		const bank0 = driftClient.getSpotMarketAccount(0);
		let market0 = driftClient.getPerpMarketAccount(0);
		const winnerUser = driftClient.getUserAccount();
		const loserUser = driftClientLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		assert(
			market0.amm.quoteAssetAmount.eq(
				winnerUser.perpPositions[0].quoteAssetAmount.add(
					loserUser.perpPositions[0].quoteAssetAmount
				)
			)
		);
		const oraclePriceData0 = driftClient.getOracleDataForPerpMarket(
			market0.marketIndex
		);
		const [bid1, ask1] = examineSpread(market0, oraclePriceData0);

		console.log('DOUBLE CHECK bids:', bid1.toString(), bid0After.toString());
		console.log('DOUBLE CHECK asks:', ask1.toString(), ask0After.toString());

		// assert(bid1.sub(bid0After).abs().lte(TWO));
		// assert(ask1.sub(ask0After).abs().lte(TWO));

		while (!market0.amm.lastOracleValid) {
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
				market0.amm.historicalOracleData.lastOraclePrice.toString()
			);
			console.log('lastOracleValid:', market0.amm.lastOracleValid.toString());
			console.log('lastUpdateSlot:', market0.amm.lastUpdateSlot.toString());

			console.log('lastAskPriceTwap:', market0.amm.lastAskPriceTwap.toString());
			console.log('lastBidPriceTwap:', market0.amm.lastBidPriceTwap.toString());
			console.log(
				'lastOraclePriceTwap:',
				market0.amm.historicalOracleData.lastOraclePriceTwap.toString()
			);

			try {
				const txSig = await driftClient.updateAMMs([0]);
				console.log(
					'tx logs',
					(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
						.meta.logMessages
				);
			} catch (e) {
				console.error(e);
			}
			driftClient.fetchAccounts();

			market0 = driftClient.getPerpMarketAccount(0);
		}
		const oraclePriceData = driftClient.getOracleDataForPerpMarket(
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
			market0.amm.historicalOracleData.lastOraclePrice.toString()
		);
		console.log('lastOracleValid:', market0.amm.lastOracleValid.toString());
		console.log('lastUpdateSlot:', market0.amm.lastUpdateSlot.toString());

		console.log('lastAskPriceTwap:', market0.amm.lastAskPriceTwap.toString());
		console.log('lastBidPriceTwap:', market0.amm.lastBidPriceTwap.toString());
		console.log(
			'lastOraclePriceTwap:',
			market0.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		assert(market0.amm.lastOracleValid == true);
	});
	it('update market imbalance limits', async () => {
		const marketIndex = 0;
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);

		try {
			const txSig = await driftClient.updateAMMs([0]);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const market0 = driftClient.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		const oraclePriceData0 = driftClient.getOracleDataForPerpMarket(
			market0.marketIndex
		);
		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData0);
		console.log(prepegAMM.pegMultiplier.toString());
		// assert(prepegAMM.pegMultiplier.eq(new BN(248126)));

		assert(market0.unrealizedPnlMaxImbalance.eq(ZERO));

		await driftClient.updatePerpMarketContractTier(0, ContractTier.A);
		await driftClient.fetchAccounts();
		// try {
		const tx1 = await driftClient.updatePerpMarketMaxImbalances(
			marketIndex,
			new BN(40000).mul(QUOTE_PRECISION),
			QUOTE_PRECISION,
			QUOTE_PRECISION
		);
		await printTxLogs(connection, tx1);
		// } catch (e) {
		// 	console.error(e);
		// }

		await sleep(1000);
		driftClient.fetchAccounts();

		const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
		const quoteSpotMarket = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const oraclePriceData = driftClient.getOracleDataForPerpMarket(
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
		console.log(
			'market.insuranceClaim.lastRevenueWithdrawTs:',
			perpMarket.insuranceClaim.lastRevenueWithdrawTs.toString(),
			now.toString()
		);
		assert(perpMarket.insuranceClaim.lastRevenueWithdrawTs.lt(new BN(now)));
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
			perpMarket.amm.totalExchangeFee.toString()
		);
		console.log('totalFee:', perpMarket.amm.totalFee.toString());
		console.log('totalMMFee:', perpMarket.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			perpMarket.amm.totalFeeMinusDistributions.toString()
		);

		await driftClientLoserUser.fetchAccounts();

		const driftClientLoserUserLeverage = convertToNumber(
			driftClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const driftClientLoserUserLiqPrice = convertToNumber(
			driftClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		console.log(
			'driftClientLoserUser.getLeverage:',
			driftClientLoserUserLeverage,
			'driftClientLoserUserLiqPrice:',
			driftClientLoserUserLiqPrice
		);
		assert(driftClientLoserUserLeverage > 1);
	});

	it('whale takes tiny profit', async () => {
		const market0 = driftClient.getPerpMarketAccount(0);
		assert(market0.marginRatioInitial == 1000);
		assert(market0.marginRatioMaintenance == 500);

		const oraclePriceData0 = driftClient.getOracleDataForPerpMarket(
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
		assert(bid.eq(new BN('251312405')));
		assert(prepegAMM.pegMultiplier.eq(new BN('254313114'))); // lowered by 1 for funding offset change
		assert(oraclePriceData0.price.eq(new BN('260500000')));
		assert(ask.eq(new BN('397364256')));

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = bid.mul(new BN(1000)).div(new BN(1049)); // dont breach oracle price bands

		assert(
			driftClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.gt(ZERO)
		);
		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction,
			baseAssetAmount,
			price,
		});

		const txSig = await driftClientLoser.placeAndTakePerpOrder(orderParams);
		await printTxLogs(connection, txSig);

		const market1 = driftClient.getPerpMarketAccount(0);

		const oraclePriceData1 = driftClient.getOracleDataForPerpMarket(
			market1.marketIndex
		);
		const prepegAMM1 = calculateUpdatedAMM(market0.amm, oraclePriceData1);
		console.log(prepegAMM1.pegMultiplier.toString());
		assert(prepegAMM1.pegMultiplier.eq(new BN(254313114))); // lower by 1 for funding offset change
	});

	it('resolvePerpPnlDeficit', async () => {
		const bankIndex = 0;
		const marketIndex = 0;

		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '9998000000000');

		await driftClient.initializeInsuranceFundStake(bankIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);
		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.marketIndex === bankIndex);
		assert(ifStakeAccount.authority.equals(provider.wallet.publicKey));

		const txSig = await driftClient.addInsuranceFundStake({
			marketIndex: bankIndex,
			amount: QUOTE_PRECISION.add(QUOTE_PRECISION.div(new BN(100))), // $1.01
			collateralAccountPublicKey: userUSDCAccount.publicKey,
		});
		await printTxLogs(connection, txSig);

		const market0 = driftClient.getPerpMarketAccount(marketIndex);

		//will fail
		try {
			const txSig2 = await driftClient.resolvePerpPnlDeficit(
				bankIndex,
				marketIndex
			);
			await printTxLogs(connection, txSig2);
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

		await driftClient.updateOracleGuardRails(oracleGuardRails);
		const txSig2 = await driftClient.resolvePerpPnlDeficit(
			bankIndex,
			marketIndex
		);
		await printTxLogs(connection, txSig2);
		await eventSubscriber.awaitTx(txSig2);
		const ifRecord: InsuranceFundRecord = eventSubscriber.getEventsArray(
			'InsuranceFundRecord'
		)[0];
		console.log(ifRecord);
		assert(ifRecord.vaultAmountBefore.eq(new BN('13000000000')));
		assert(ifRecord.insuranceVaultAmountBefore.eq(new BN('1010000')));
		assert(ifRecord.amount.eq(new BN('-1000000')));

		assert(ifRecord.amount.eq(new BN('-1000000')));

		await driftClient.fetchAccounts();
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
		const quoteSpotMarket = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const oraclePriceData = driftClient.getOracleDataForPerpMarket(
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
		console.log(
			'market.insuranceClaim.lastRevenueWithdrawTs:',
			perpMarket.insuranceClaim.lastRevenueWithdrawTs.toString(),
			now.toString()
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
			perpMarket.amm.totalExchangeFee.toString()
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
	// 	const loserUser0 = driftClientLoser.getUserAccount();
	// 	assert(loserUser0.perpPositions[0].baseAssetAmount.gt(0));
	// 	assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(0));
	// 	// console.log(loserUser0.perpPositions[0]);

	// 	const liquidatorDriftClientUser = new User({
	// 		driftClient: liquidatorDriftClient,
	// 		userAccountPublicKey:
	// 			await liquidatorDriftClient.getUserAccountPublicKey(),
	// 	});
	// 	await liquidatorDriftClientUser.subscribe();

	// 	const liquidatorDriftClientValue = convertToNumber(
	// 		liquidatorDriftClientUser.getTotalCollateral(),
	// 		QUOTE_PRECISION
	// 	);
	// 	console.log(
	// 		'liquidatorDriftClientValue:',
	// 		liquidatorDriftClientValue.toString()
	// 	);

	// 	const txSigLiq = await liquidatorDriftClient.liquidatePerp(
	// 		await driftClientLoser.getUserAccountPublicKey(),
	// 		driftClientLoser.getUserAccount(),
	// 		marketIndex,
	// 		BASE_PRECISION.mul(new BN(290))
	// 	);

	// 	console.log(txSigLiq);

	// 	const liquidatorDriftClientValueAfter = convertToNumber(
	// 		liquidatorDriftClientUser.getTotalCollateral(),
	// 		QUOTE_PRECISION
	// 	);
	// 	console.log(
	// 		'liquidatorDriftClientValueAfter:',
	// 		liquidatorDriftClientValueAfter.toString()
	// 	);

	// 	console.log('settle position driftClientLoser');
	// 	const txSig = await driftClientLoser.settleExpiredPosition(
	// 		await driftClientLoser.getUserAccountPublicKey(),
	// 		driftClientLoser.getUserAccount(),
	// 		marketIndex
	// 	);
	// 	await printTxLogs(connection, txSig);

	// 	console.log('settle pnl driftClientLoser');

	// 	try {
	// 		await driftClient.settlePNL(
	// 			await driftClient.getUserAccountPublicKey(),
	// 			driftClient.getUserAccount(),
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

	// 	await driftClientLoser.fetchAccounts();
	// 	const loserUser = driftClientLoser.getUserAccount();
	// 	// console.log(loserUser.perpPositions[0]);
	// 	assert(loserUser.perpPositions[0].baseAssetAmount.eq(0));
	// 	assert(loserUser.perpPositions[0].quoteAssetAmount.eq(0));
	// 	const marketAfter0 = driftClient.getPerpMarketAccount(marketIndex);

	// 	const finalPnlResultMin0 = new BN(1415296436 - 11090);
	// 	const finalPnlResultMax0 = new BN(1415296436 + 111090);

	// 	console.log(marketAfter0.pnlPool.scaledBalance.toString());
	// 	assert(marketAfter0.pnlPool.scaledBalance.gt(finalPnlResultMin0));
	// 	assert(marketAfter0.pnlPool.scaledBalance.lt(finalPnlResultMax0));

	// 	// const ammPnlResult = 0;
	// 	console.log('feePool:', marketAfter0.amm.feePool.scaledBalance.toString());
	// 	console.log(
	// 		'totalExchangeFee:',
	// 		marketAfter0.amm.totalExchangeFee.toString()
	// 	);
	// 	assert(marketAfter0.amm.feePool.scaledBalance.eq(new BN(4356250)));
	// 	await liquidatorDriftClientUser.unsubscribe();
	// });
});
