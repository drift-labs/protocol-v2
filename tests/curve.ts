import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import {
	Admin,
	PRICE_PRECISION,
	PEG_PRECISION,
	QUOTE_PRECISION,
	BASE_PRECISION,
	BN,
	calculateReservePrice,
	calculateTargetPriceTrade,
	ClearingHouseUser,
	PositionDirection,
	convertToNumber,
	calculateBudgetedPeg,
	QUOTE_SPOT_MARKET_INDEX,
} from '../sdk/src';

import { liquidityBook } from './liquidityBook';

import { assert } from '../sdk/src/assert/assert';
import {
	createPriceFeed,
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';

describe('AMM Curve', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	const clearingHouse = new Admin({
		connection,
		wallet: provider.wallet,
		programID: chProgram.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeUserId: 0,
		perpMarketIndexes: [0],
		spotMarketIndexes: [0],
	});

	const ammInitialQuoteAssetAmount = new anchor.BN(10 ** 8).mul(BASE_PRECISION);
	const ammInitialBaseAssetAmount = new anchor.BN(10 ** 8).mul(BASE_PRECISION);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = 0;
	const initialSOLPrice = 150;

	const usdcAmount = new BN(1e9 * QUOTE_PRECISION.toNumber());
	const initialBaseAssetAmount = new BN(
		662251.6556291390728 * BASE_PRECISION.toNumber()
	);

	let userAccount: ClearingHouseUser;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsdOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			PEG_PRECISION.mul(new BN(initialSOLPrice))
		);

		await clearingHouse.initializeUserAccount();
		userAccount = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	const showCurve = (marketIndex) => {
		const marketData = clearingHouse.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;

		console.log(
			'baseAssetAmountShort',
			convertToNumber(marketData.baseAssetAmountShort, BASE_PRECISION),
			'baseAssetAmountLong',
			convertToNumber(marketData.baseAssetAmountLong, BASE_PRECISION)
		);

		console.log(
			'pegMultiplier',
			convertToNumber(ammAccountState.pegMultiplier, PEG_PRECISION)
		);

		const totalFeeNum = convertToNumber(
			ammAccountState.totalFee,
			QUOTE_PRECISION
		);
		const cumFeeNum = convertToNumber(
			ammAccountState.totalFeeMinusDistributions,
			QUOTE_PRECISION
		);
		console.log('totalFee', totalFeeNum);
		console.log('cumFee', cumFeeNum);
		return totalFeeNum - cumFeeNum;
	};

	const showBook = (marketIndex) => {
		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const currentMark = calculateReservePrice(market);

		const [bidsPrice, bidsCumSize, asksPrice, asksCumSize] = liquidityBook(
			market,
			3,
			0.1
		);

		for (let i = asksCumSize.length - 1; i >= 0; i--) {
			console.log(
				convertToNumber(asksPrice[i]),
				convertToNumber(asksCumSize[i], QUOTE_PRECISION)
			);
		}

		console.log('------------');
		console.log(currentMark.toNumber() / PRICE_PRECISION.toNumber());
		console.log(
			'peg:',
			convertToNumber(market.amm.pegMultiplier, PEG_PRECISION),
			'k (M*M):',
			convertToNumber(market.amm.sqrtK, BASE_PRECISION)
		);
		console.log('------------');
		for (let i = 0; i < bidsCumSize.length; i++) {
			console.log(
				convertToNumber(bidsPrice[i]),
				convertToNumber(bidsCumSize[i], QUOTE_PRECISION)
			);
		}
	};

	it('After Deposit', async () => {
		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		showBook(marketIndex);
	});

	it('After Position Taken', async () => {
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			initialBaseAssetAmount,
			marketIndex
		);

		showBook(marketIndex);
	});

	it('After Position Price Moves', async () => {
		// const _priceIncreaseFactor = new BN(2);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(initialSOLPrice * PRICE_PRECISION.toNumber() * 1.0001)
		);

		showBook(marketIndex);
	});
	it('Arb back to Oracle Price Moves', async () => {
		const [direction, basesize] = calculateTargetPriceTrade(
			clearingHouse.getPerpMarketAccount(marketIndex),
			new BN(initialSOLPrice).mul(PRICE_PRECISION),
			undefined,
			'base'
		);

		console.log('arbing', direction, basesize.toString());
		await clearingHouse.openPosition(direction, basesize, marketIndex);

		showBook(marketIndex);
	});

	it('Repeg Curve LONG', async () => {
		let marketData = clearingHouse.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;
		assert(ammAccountState.totalFee.eq(ammAccountState.totalFee));

		const oldPeg = ammAccountState.pegMultiplier;

		const newOraclePrice = 155;
		const newOraclePriceWithMantissa = new BN(
			newOraclePrice * PRICE_PRECISION.toNumber()
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsdOracle);
		// showCurve(marketIndex);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.div(new BN(10)),
			marketIndex
		);
		// showBook(marketIndex);

		const priceBefore = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(marketIndex)
		);
		await clearingHouse.repegAmmCurve(
			new BN(150.001 * PEG_PRECISION.toNumber()),
			marketIndex
		);
		const priceAfter = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(marketIndex)
		);

		assert(newOraclePriceWithMantissa.gt(priceBefore));
		assert(priceAfter.gt(priceBefore));
		assert(newOraclePriceWithMantissa.gt(priceAfter));

		console.log('\n post repeg: \n --------');
		showCurve(marketIndex);
		// showBook(marketIndex);

		marketData = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(marketData.amm);
		console.log();
		assert(
			marketData.amm.totalFee.gte(marketData.amm.totalFeeMinusDistributions)
		);

		const newPeg = marketData.amm.pegMultiplier;

		const userPerpPosition = userAccount.getUserAccount().perpPositions[0];
		const linearApproxCostToAMM = convertToNumber(
			newPeg
				.sub(oldPeg)
				.mul(userPerpPosition.baseAssetAmount)
				.div(PEG_PRECISION),
			BASE_PRECISION
		);

		// console.log('cur user position:', convertBaseAssetAmountToNumber(userPerpPosition.baseAssetAmount));

		const totalCostToAMMChain = showCurve(marketIndex);

		assert(linearApproxCostToAMM > totalCostToAMMChain);
		assert(linearApproxCostToAMM / totalCostToAMMChain < 1.1);

		// const feeDist1h = calculateFeeDist(marketIndex);

		await clearingHouse.closePosition(marketIndex);

		// showCurve(marketIndex);
		// const feeDist2 = calculateFeeDist(marketIndex);
	});

	// it('Repeg Curve SHORT', async () => {
	// 	const newOraclePrice = 145;
	// 	const newOraclePriceWithMantissa = new BN(
	// 		newOraclePrice * PRICE_PRECISION.toNumber()
	// 	);
	// 	await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsdOracle);
	// 	showCurve(marketIndex);

	// 	await clearingHouse.openPosition(
	// 		PositionDirection.SHORT,
	// 		BASE_PRECISION.div(new BN(1000)),
	// 		marketIndex
	// 	);
	// 	const marketData1 = clearingHouse.getPerpMarketAccount(marketIndex);
	// 	const ammAccountState = marketData1.amm;
	// 	const oldPeg = ammAccountState.pegMultiplier;

	// 	const priceBefore = calculateReservePrice(
	// 		clearingHouse.getPerpMarketAccount(marketIndex)
	// 	);

	// 	await clearingHouse.repegAmmCurve(
	// 		new BN(148 * PEG_PRECISION.toNumber()),
	// 		marketIndex
	// 	);

	// 	const priceAfter = calculateReservePrice(
	// 		clearingHouse.getPerpMarketAccount(marketIndex)
	// 	);

	// 	assert(newOraclePriceWithMantissa.lt(priceBefore));
	// 	assert(priceAfter.lt(priceBefore));
	// 	assert(newOraclePriceWithMantissa.lt(priceAfter));

	// 	const marketData = clearingHouse.getPerpMarketAccount(marketIndex);
	// 	const newPeg = marketData.amm.pegMultiplier;

	// 	const userPerpPosition = userAccount.getUserAccount().perpPositions[0];

	// 	console.log('\n post repeg: \n --------');

	// 	const linearApproxCostToAMM = convertToNumber(
	// 		newPeg
	// 			.sub(oldPeg)
	// 			.mul(userPerpPosition.baseAssetAmount)
	// 			.div(PEG_PRECISION),
	// 		BASE_PRECISION
	// 	);

	// 	showCurve(marketIndex);
	// 	const totalCostToAMMChain = convertToNumber(
	// 		marketData1.amm.totalFeeMinusDistributions.sub(
	// 			marketData.amm.totalFeeMinusDistributions
	// 		),
	// 		QUOTE_PRECISION
	// 	);
	// 	console.log(linearApproxCostToAMM, 'vs', totalCostToAMMChain);
	// 	assert(linearApproxCostToAMM > totalCostToAMMChain);
	// 	assert(linearApproxCostToAMM / totalCostToAMMChain < 1.02);

	// 	await clearingHouse.closePosition(marketIndex);
	// });

	it('calculateBudgetedPeg (sdk tests)', async () => {
		const marketData1 = clearingHouse.getPerpMarketAccount(marketIndex);

		let amm = marketData1.amm;

		// unbalanced but no net position
		console.log('netBaseAssetAmount:', amm.netBaseAssetAmount.toString());
		assert(!amm.baseAssetReserve.eq(amm.quoteAssetReserve));
		assert(amm.netBaseAssetAmount.eq(new BN(0)));

		// check if balanced
		const candidatePegUp0 = calculateBudgetedPeg(
			amm,
			QUOTE_PRECISION,
			new BN(200 * PRICE_PRECISION.toNumber())
		);

		const candidatePegDown0 = calculateBudgetedPeg(
			amm,
			QUOTE_PRECISION,
			new BN(10 * PRICE_PRECISION.toNumber())
		);

		console.log(candidatePegUp0.toString(), candidatePegDown0.toString());
		assert(candidatePegUp0.eq(new BN(202637647)));
		assert(candidatePegDown0.eq(new BN(10131882)));

		// check if short
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			marketIndex
		);

		amm = clearingHouse.getPerpMarketAccount(marketIndex).amm;

		const candidatePegUp = calculateBudgetedPeg(
			amm,
			QUOTE_PRECISION,
			new BN(200 * PRICE_PRECISION.toNumber())
		);
		console.log(amm.pegMultiplier.toString(), '->', candidatePegUp.toString());
		assert(candidatePegUp.eq(new BN(202637651)));

		const candidatePegDown = calculateBudgetedPeg(
			amm,
			QUOTE_PRECISION,
			new BN(10 * PRICE_PRECISION.toNumber())
		);
		console.log(
			amm.pegMultiplier.toString(),
			'->',
			candidatePegDown.toString()
		);
		assert(candidatePegDown.eq(new BN(148987812)));

		await clearingHouse.closePosition(marketIndex);

		// check if long
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			marketIndex
		);
		amm = clearingHouse.getPerpMarketAccount(marketIndex).amm;

		const candidatePegUp2 = calculateBudgetedPeg(
			amm,
			QUOTE_PRECISION,
			new BN(200 * PRICE_PRECISION.toNumber())
		);
		console.log(
			'USER LONG: target $200',
			amm.pegMultiplier.toString(),
			'->',
			candidatePegUp2.toString()
		);
		assert(candidatePegUp2.eq(new BN(151014188)));

		const candidatePegDown2 = calculateBudgetedPeg(
			amm,
			QUOTE_PRECISION,
			new BN(10 * PRICE_PRECISION.toNumber())
		);
		console.log(
			'USER LONG: target $10',
			amm.pegMultiplier.toString(),
			'->',
			candidatePegDown2.toString()
		);
		assert(candidatePegDown2.eq(new BN(10131882)));

		await clearingHouse.closePosition(marketIndex);
	});
});
