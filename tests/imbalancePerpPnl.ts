import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { Program } from '@project-serum/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
	Wallet,
	getInsuranceFundStakeAccountPublicKey,
	InsuranceFundStake,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	convertToNumber,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
	ClearingHouseUser,
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

async function depositToFeePoolFromIF(
	amount: number,
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	const txSig00 = await clearingHouse.depositIntoMarketFeePool(
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
	const [bid, ask] = calculateBidAskPrice(market.amm, oraclePriceData);
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
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let clearingHouseLoser: ClearingHouse;
	let clearingHouseLoserUser: ClearingHouseUser;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;
	let liquidatorClearingHouseWUSDCAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetReserve = new anchor.BN(
		9 * AMM_RESERVE_PRECISION.toNumber()
	).mul(new BN(1000000000));
	const ammInitialBaseAssetReserve = new anchor.BN(
		9 * AMM_RESERVE_PRECISION.toNumber()
	).mul(new BN(1000000000));

	console.log(ammInitialQuoteAssetReserve.toString());
	console.log(ammInitialBaseAssetReserve.toString());

	const ammInitialQuoteAssetReserve2 = new anchor.BN(9)
		.mul(AMM_RESERVE_PRECISION)
		.mul(AMM_RESERVE_PRECISION);
	const ammInitialBaseAssetReserve2 = new anchor.BN(9)
		.mul(AMM_RESERVE_PRECISION)
		.mul(AMM_RESERVE_PRECISION);

	console.log(ammInitialQuoteAssetReserve2.toString());
	console.log(ammInitialBaseAssetReserve2.toString());

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

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		try {
			await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
			await initializeSolSpotMarket(clearingHouse, solOracle);
		} catch (e) {
			console.error(e);
		}
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(42_500_000),
			undefined,
			1000,
			500
		);
		await clearingHouse.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
		await clearingHouse.updateMarketBaseSpread(0, 250);
		await clearingHouse.updateCurveUpdateIntensity(0, 100);
		await sleep(100);
		await clearingHouse.fetchAccounts();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
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
		clearingHouseLoser = new Admin({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await clearingHouseLoser.subscribe();
		await sleep(100);
		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		clearingHouseLoserUser = new ClearingHouseUser({
			clearingHouse: clearingHouseLoser,
			userAccountPublicKey: await clearingHouseLoser.getUserAccountPublicKey(),
		});
		await clearingHouseLoserUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseLoser.unsubscribe();
		await clearingHouseLoserUser.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('update amm', async () => {
		const marketAccount0 = clearingHouse.getPerpMarketAccount(0);
		assert(marketAccount0.amm.totalFee.eq(ZERO));
		assert(marketAccount0.amm.pegMultiplier.eq(new BN(42500000)));
		assert(marketAccount0.amm.totalFeeMinusDistributions.eq(ZERO));

		await depositToFeePoolFromIF(1000, clearingHouse, userUSDCAccount);

		const newPrice = 42.52;
		await setFeedPrice(anchor.workspace.Pyth, newPrice, solOracle);
		console.log('price move to $', newPrice);

		const txSig1 = await clearingHouse.updateAMMs([0]);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig1, { commitment: 'confirmed' }))
				.meta.logMessages
		);

		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		await printTxLogs(connection, txSig);
		await clearingHouse.fetchAccounts();
		const userAccount = clearingHouse.getUserAccount();
		assert(
			userAccount.perpPositions[0].baseAssetAmount.abs().eq(BASE_PRECISION)
		);

		const marketAccount = clearingHouse.getPerpMarketAccount(0);
		assert(marketAccount.amm.totalFee.gt(ZERO));
		assert(marketAccount.amm.pegMultiplier.eq(new BN(42520000)));
		assert(marketAccount.amm.totalFeeMinusDistributions.gt(ZERO));

		const newPrice2 = 42.5;
		await setFeedPrice(anchor.workspace.Pyth, newPrice2, solOracle);
		console.log('price move to $', newPrice2);

		const txSig2 = await clearingHouse.updateAMMs([0]);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig2, { commitment: 'confirmed' }))
				.meta.logMessages
		);
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		const uL = clearingHouseLoserUser.getUserAccount();
		console.log(
			'uL.spotPositions[0].balance:',
			uL.spotPositions[0].balance.toString()
		);
		assert(
			uL.spotPositions[0].balance.eq(
				new BN(1000 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);

		const bank0Value = clearingHouseLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * QUOTE_PRECISION.toNumber())));

		const clearingHouseLoserUserValue = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('clearingHouseLoserUserValue:', clearingHouseLoserUserValue);
		assert(clearingHouseLoserUserValue == 1000); // ??

		// todo
		try {
			const txSig = await clearingHouseLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				0,
				new BN(0)
			);
			await printTxLogs(connection, txSig);
		} catch (e) {
			console.log('failed clearingHouseLoserc.openPosition');

			console.error(e);
		}

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: 0,
			}),
			PRICE_PRECISION
		);

		console.log(
			'clearingHouseLoserUser.getLeverage:',
			clearingHouseLoserUserLeverage,
			'clearingHouseLoserUserLiqPrice:',
			clearingHouseLoserUserLiqPrice
		);

		assert(clearingHouseLoserUserLeverage < 8.95);
		assert(clearingHouseLoserUserLeverage > 8.5);
		assert(clearingHouseLoserUserLiqPrice < 41);
		assert(clearingHouseLoserUserLiqPrice > 30.5);

		const bank00 = clearingHouse.getSpotMarketAccount(0);
		const market00 = clearingHouse.getPerpMarketAccount(0);
		assert(market00.amm.feePool.balance.eq(new BN(1000000000000)));

		const oraclePriceData00 = clearingHouse.getOracleDataForMarket(
			market00.marketIndex
		);

		const imbalance00 = calculateNetUserPnlImbalance(
			market00,
			bank00,
			oraclePriceData00
		);

		console.log('pnlimbalance00:', imbalance00.toString());
		assert(imbalance00.eq(new BN(-9821952)));

		const bank0Value1p5 = clearingHouseLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value1p5:', bank0Value1p5.toString());

		const clearingHouseLoserUserValue1p5 = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log(
			'clearingHouseLoserUserValue1p5:',
			clearingHouseLoserUserValue1p5
		);

		const [bid0, ask0] = examineSpread(market00, oraclePriceData00);
		console.log(bid0.toString(), ask0.toString());
		assert(bid0.eq(new BN(42494730)));
		assert(ask0.eq(new BN(42553141)));

		// sol rallys big
		// await clearingHouse.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(260.5 * PRICE_PRECISION.toNumber())
		// );
		await setFeedPrice(anchor.workspace.Pyth, 260.5, solOracle);
		console.log('price move to $260.5');
		await sleep(1000);
		await clearingHouse.fetchAccounts();

		const oraclePriceData00Again = clearingHouse.getOracleDataForMarket(
			market00.marketIndex
		);
		const newAmm00 = calculateUpdatedAMM(market00.amm, oraclePriceData00Again);
		const [bid0After, ask0After] = calculateBidAskPrice(
			newAmm00,
			oraclePriceData00Again
		);
		console.log('bid0After:', bid0After.toString(), ask0After.toString());
		assert(bid0After.eq(new BN(248126249)));
		assert(ask0After.eq(new BN(260687640)));
		try {
			const txSig = await clearingHouse.updateAMMs([0]);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage2 = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice2 = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: 0,
			}),
			PRICE_PRECISION
		);

		const bank0Value2 = clearingHouseLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value2:', bank0Value2.toString());

		const clearingHouseLoserUserValue2 = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('clearingHouseLoserUserValue2:', clearingHouseLoserUserValue2);

		console.log(
			'clearingHouseLoserUser.getLeverage2:',
			clearingHouseLoserUserLeverage2,
			'clearingHouseLoserUserLiqPrice2:',
			clearingHouseLoserUserLiqPrice2,
			'bank0Value2:',
			bank0Value2.toString(),
			'clearingHouseLoserUserValue2:',
			clearingHouseLoserUserValue2.toString()
		);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorClearingHouse,
			liquidatorClearingHouseWSOLAccount,
			liquidatorClearingHouseWUSDCAccount,
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
			]
		);
		await liquidatorClearingHouse.subscribe();

		const bankIndex = 1;
		await liquidatorClearingHouse.deposit(
			solAmount,
			bankIndex,
			liquidatorClearingHouseWSOLAccount
		);
		await liquidatorClearingHouse.deposit(
			usdcAmount.mul(new BN(10)),
			0,
			liquidatorClearingHouseWUSDCAccount
		);

		const bank0 = clearingHouse.getSpotMarketAccount(0);
		let market0 = clearingHouse.getPerpMarketAccount(0);
		const winnerUser = clearingHouse.getUserAccount();
		const loserUser = clearingHouseLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		// TODO: quoteAssetAmountShort!= sum of users
		assert(
			market0.amm.quoteAssetAmountShort.eq(
				winnerUser.perpPositions[0].quoteAssetAmount
			)
		);

		assert(
			market0.amm.quoteAssetAmountLong.eq(
				loserUser.perpPositions[0].quoteAssetAmount
			)
		);
		const oraclePriceData0 = clearingHouse.getOracleDataForMarket(
			market0.marketIndex
		);
		const [bid1, ask1] = examineSpread(market0, oraclePriceData0);
		assert(bid1.eq(bid0After)); // not sure why it's failing
		assert(ask1.eq(ask0After));

		while (!market0.amm.lastOracleValid) {
			const imbalance = calculateNetUserPnlImbalance(
				market0,
				bank0,
				oraclePriceData0
			);

			console.log('pnlimbalance:', imbalance.toString());
			assert(imbalance.eq(new BN(44462178048))); //44k! :o

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
				const txSig = await clearingHouse.updateAMMs([0]);
				console.log(
					'tx logs',
					(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
						.meta.logMessages
				);
			} catch (e) {
				console.error(e);
			}
			clearingHouse.fetchAccounts();

			market0 = clearingHouse.getPerpMarketAccount(0);
		}
		const oraclePriceData = clearingHouse.getOracleDataForMarket(
			market0.marketIndex
		);

		const imbalance = calculateNetUserPnlImbalance(
			market0,
			bank0,
			oraclePriceData
		);

		console.log('pnlimbalance:', imbalance.toString());
		assert(imbalance.eq(new BN(44462178048))); //44k! :o

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
			const txSig = await clearingHouse.updateAMMs([0]);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		const oraclePriceData0 = clearingHouse.getOracleDataForMarket(
			market0.marketIndex
		);
		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData0);
		console.log(prepegAMM.pegMultiplier.toString());
		// assert(prepegAMM.pegMultiplier.eq(new BN(248126)));

		assert(market0.unrealizedMaxImbalance.eq(ZERO));

		await clearingHouse.updatePerpMarketContractTier(0, ContractTier.A);
		await clearingHouse.fetchAccounts();
		// try {
		const tx1 = await clearingHouse.updateMarketMaxImbalances(
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
		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const bank = clearingHouse.getSpotMarketAccount(marketIndex);

		const oraclePriceData = clearingHouse.getOracleDataForMarket(
			market0.marketIndex
		);

		const imbalance = calculateNetUserPnlImbalance(
			market,
			bank,
			oraclePriceData
		);

		console.log('pnlimbalance:', imbalance.toString());
		assert(imbalance.eq(new BN(44_462_178_048))); //44k still :o

		assert(market.revenueWithdrawSinceLastSettle.eq(ZERO));
		console.log('pnlimbalance:', imbalance.toString());

		assert(market.maxRevenueWithdrawPerPeriod.eq(QUOTE_PRECISION));
		console.log(
			'market.lastRevenueWithdrawTs:',
			market.lastRevenueWithdrawTs.toString(),
			now.toString()
		);
		assert(market.lastRevenueWithdrawTs.lt(new BN(now)));
		assert(
			market.unrealizedMaxImbalance.eq(new BN(40000).mul(QUOTE_PRECISION))
		);
		assert(market.quoteSettledInsurance.eq(ZERO));
		assert(market.quoteMaxInsurance.eq(QUOTE_PRECISION));

		console.log(market.status);
		assert(isVariant(market.status, 'active'));
		console.log('totalExchangeFee:', market.amm.totalExchangeFee.toString());
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: 0,
			}),
			PRICE_PRECISION
		);

		console.log(
			'clearingHouseLoserUser.getLeverage:',
			clearingHouseLoserUserLeverage,
			'clearingHouseLoserUserLiqPrice:',
			clearingHouseLoserUserLiqPrice
		);
		assert(clearingHouseLoserUserLeverage > 1);
	});

	it('whale takes tiny profit', async () => {
		const market0 = clearingHouse.getPerpMarketAccount(0);
		assert(market0.marginRatioInitial == 1000);
		assert(market0.marginRatioMaintenance == 500);

		const oraclePriceData0 = clearingHouse.getOracleDataForMarket(
			market0.marketIndex
		);
		oraclePriceData0.confidence = new BN(0); //oraclePriceData0.price.div(new BN(1000));

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData0);
		console.log(prepegAMM.pegMultiplier.toString());
		// assert(prepegAMM.pegMultiplier.eq(new BN(248126)));

		const [bid, ask] = examineSpread(market0, oraclePriceData0);
		console.log(bid.toString());
		console.log(ask.toString());
		assert(bid.eq(new BN('248126249')));
		assert(ask.eq(new BN('260687640')));

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = bid.mul(new BN(1000)).div(new BN(1049)); // dont breach oracle price bands

		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction,
			baseAssetAmount,
			price,
		});

		//    'Program failed to complete: Access violation in stack frame 11 at address 0x20000bff0 of size 8 by instruction #88129',
		const txSig = await clearingHouseLoser.placeAndTake(orderParams);
		await printTxLogs(connection, txSig);

		const market1 = clearingHouse.getPerpMarketAccount(0);

		const oraclePriceData1 = clearingHouse.getOracleDataForMarket(
			market1.marketIndex
		);
		const prepegAMM1 = calculateUpdatedAMM(market0.amm, oraclePriceData1);
		console.log(prepegAMM1.pegMultiplier.toString());
		assert(prepegAMM1.pegMultiplier.eq(new BN(248126238)));
	});

	it('resolvePerpPnlDeficit', async () => {
		const bankIndex = 0;
		const marketIndex = 0;

		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '9998000000000');

		await clearingHouse.initializeInsuranceFundStake(bankIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);
		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.marketIndex === bankIndex);
		assert(ifStakeAccount.authority.equals(provider.wallet.publicKey));

		const txSig = await clearingHouse.addInsuranceFundStake(
			bankIndex,
			QUOTE_PRECISION.add(QUOTE_PRECISION.div(new BN(100))), // $1.01
			userUSDCAccount.publicKey
		);
		await printTxLogs(connection, txSig);

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);

		//will fail
		try {
			const txSig2 = await clearingHouse.resolvePerpPnlDeficit(
				bankIndex,
				marketIndex
			);
			await printTxLogs(connection, txSig2);
		} catch (e) {
			console.error(e);
		}

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(2),
			},
			useForLiquidations: false,
		};

		await clearingHouse.updateOracleGuardRails(oracleGuardRails);
		const txSig2 = await clearingHouse.resolvePerpPnlDeficit(
			bankIndex,
			marketIndex
		);
		await printTxLogs(connection, txSig2);
		const ifRecord: InsuranceFundRecord = eventSubscriber.getEventsArray(
			'InsuranceFundRecord'
		)[0];
		console.log(ifRecord);
		assert(ifRecord.vaultAmountBefore.eq(new BN('13000000000')));
		assert(ifRecord.insuranceVaultAmountBefore.eq(new BN('1010000')));
		assert(ifRecord.amount.eq(new BN('-1000000')));

		assert(ifRecord.amount.eq(new BN('-1000000')));

		await clearingHouse.fetchAccounts();
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const bank = clearingHouse.getSpotMarketAccount(marketIndex);

		const oraclePriceData = clearingHouse.getOracleDataForMarket(
			market.marketIndex
		);

		const imbalance = calculateNetUserPnlImbalance(
			market,
			bank,
			oraclePriceData
		);

		console.log('pnlimbalance:', imbalance.toString());
		assert(imbalance.lt(new BN(44461135639 + 1000))); //44k still :o
		assert(imbalance.gt(new BN(44461135639 - 1000))); //44k still :o

		console.log(
			'revenueWithdrawSinceLastSettle:',
			market.revenueWithdrawSinceLastSettle.toString()
		);
		assert(market.revenueWithdrawSinceLastSettle.eq(QUOTE_PRECISION));
		console.log(
			'market.maxRevenueWithdrawPerPeriod:',
			market.maxRevenueWithdrawPerPeriod.toString()
		);

		assert(market.maxRevenueWithdrawPerPeriod.eq(QUOTE_PRECISION));
		console.log(
			'market.lastRevenueWithdrawTs:',
			market.lastRevenueWithdrawTs.toString(),
			now.toString()
		);
		assert(market.lastRevenueWithdrawTs.gt(market0.lastRevenueWithdrawTs));
		assert(
			market.unrealizedMaxImbalance.eq(new BN(40000).mul(QUOTE_PRECISION))
		);

		assert(market.quoteSettledInsurance.eq(QUOTE_PRECISION));
		assert(market.quoteMaxInsurance.eq(QUOTE_PRECISION));
		console.log(
			'market0.pnlPool.balance:',

			market0.pnlPool.balance.toString(),
			'->',
			market.pnlPool.balance.toString()
		);
		assert(market.pnlPool.balance.gt(market0.pnlPool.balance));

		console.log(market.status);
		assert(isVariant(market.status, 'active'));
		console.log('totalExchangeFee:', market.amm.totalExchangeFee.toString());
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);
	});

	// it('liq and settle expired market position', async () => {
	// 	const marketIndex = 0;
	// 	const loserUser0 = clearingHouseLoser.getUserAccount();
	// 	assert(loserUser0.perpPositions[0].baseAssetAmount.gt(0));
	// 	assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(0));
	// 	// console.log(loserUser0.perpPositions[0]);

	// 	const liquidatorClearingHouseUser = new ClearingHouseUser({
	// 		clearingHouse: liquidatorClearingHouse,
	// 		userAccountPublicKey:
	// 			await liquidatorClearingHouse.getUserAccountPublicKey(),
	// 	});
	// 	await liquidatorClearingHouseUser.subscribe();

	// 	const liquidatorClearingHouseValue = convertToNumber(
	// 		liquidatorClearingHouseUser.getTotalCollateral(),
	// 		QUOTE_PRECISION
	// 	);
	// 	console.log(
	// 		'liquidatorClearingHouseValue:',
	// 		liquidatorClearingHouseValue.toString()
	// 	);

	// 	const txSigLiq = await liquidatorClearingHouse.liquidatePerp(
	// 		await clearingHouseLoser.getUserAccountPublicKey(),
	// 		clearingHouseLoser.getUserAccount(),
	// 		marketIndex,
	// 		BASE_PRECISION.mul(new BN(290))
	// 	);

	// 	console.log(txSigLiq);

	// 	const liquidatorClearingHouseValueAfter = convertToNumber(
	// 		liquidatorClearingHouseUser.getTotalCollateral(),
	// 		QUOTE_PRECISION
	// 	);
	// 	console.log(
	// 		'liquidatorClearingHouseValueAfter:',
	// 		liquidatorClearingHouseValueAfter.toString()
	// 	);

	// 	console.log('settle position clearingHouseLoser');
	// 	const txSig = await clearingHouseLoser.settleExpiredPosition(
	// 		await clearingHouseLoser.getUserAccountPublicKey(),
	// 		clearingHouseLoser.getUserAccount(),
	// 		marketIndex
	// 	);
	// 	await printTxLogs(connection, txSig);

	// 	console.log('settle pnl clearingHouseLoser');

	// 	try {
	// 		await clearingHouse.settlePNL(
	// 			await clearingHouse.getUserAccountPublicKey(),
	// 			clearingHouse.getUserAccount(),
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

	// 	await clearingHouseLoser.fetchAccounts();
	// 	const loserUser = clearingHouseLoser.getUserAccount();
	// 	// console.log(loserUser.perpPositions[0]);
	// 	assert(loserUser.perpPositions[0].baseAssetAmount.eq(0));
	// 	assert(loserUser.perpPositions[0].quoteAssetAmount.eq(0));
	// 	const marketAfter0 = clearingHouse.getPerpMarketAccount(marketIndex);

	// 	const finalPnlResultMin0 = new BN(1415296436 - 11090);
	// 	const finalPnlResultMax0 = new BN(1415296436 + 111090);

	// 	console.log(marketAfter0.pnlPool.balance.toString());
	// 	assert(marketAfter0.pnlPool.balance.gt(finalPnlResultMin0));
	// 	assert(marketAfter0.pnlPool.balance.lt(finalPnlResultMax0));

	// 	// const ammPnlResult = 0;
	// 	console.log('feePool:', marketAfter0.amm.feePool.balance.toString());
	// 	console.log(
	// 		'totalExchangeFee:',
	// 		marketAfter0.amm.totalExchangeFee.toString()
	// 	);
	// 	assert(marketAfter0.amm.feePool.balance.eq(new BN(4356250)));
	// 	await liquidatorClearingHouseUser.unsubscribe();
	// });
});
