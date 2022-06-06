import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import { BASE_PRECISION, BN } from '../sdk';
import {
	Admin,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	QUOTE_PRECISION,
	calculateMarkPrice,
	calculateTargetPriceTrade,
	ClearingHouseUser,
	PositionDirection,
	convertToNumber,
} from '../sdk/src';

import { liquidityBook } from './liquidityBook';

import { assert } from '../sdk/src/assert/assert';
import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';

describe('AMM Curve', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	const clearingHouse = Admin.from(
		connection,
		provider.wallet,
		chProgram.programId
	);

	const ammInitialQuoteAssetAmount = new anchor.BN(10 ** 8).mul(
		new BN(10 ** 10)
	);
	const ammInitialBaseAssetAmount = new anchor.BN(10 ** 8).mul(
		new BN(10 ** 10)
	);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = new BN(0);
	const initialSOLPrice = 150;

	const usdcAmount = new BN(1e9 * 10 ** 6);
	const solPositionInitialValue = usdcAmount.div(new BN(10));

	let userAccount: ClearingHouseUser;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsdOracle,
			ammInitialBaseAssetAmount.mul(PEG_PRECISION),
			ammInitialQuoteAssetAmount.mul(PEG_PRECISION),
			periodicity,
			PEG_PRECISION.mul(new BN(initialSOLPrice))
		);

		await clearingHouse.initializeUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	const showCurve = (marketIndex) => {
		const marketData = clearingHouse.getMarketAccount(marketIndex);
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
		console.log(
			'cumulativeRepegRebateShort',
			convertToNumber(
				ammAccountState.cumulativeRepegRebateShort,
				QUOTE_PRECISION
			)
		);
		console.log(
			'cumulativeRepegRebateLong',
			convertToNumber(
				ammAccountState.cumulativeRepegRebateLong,
				QUOTE_PRECISION
			)
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
		const market = clearingHouse.getMarketAccount(marketIndex);
		const currentMark = calculateMarkPrice(market);

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
		console.log(currentMark.toNumber() / MARK_PRICE_PRECISION.toNumber());
		console.log(
			'peg:',
			convertToNumber(market.amm.pegMultiplier, PEG_PRECISION),
			'k (M*M):',
			convertToNumber(market.amm.sqrtK)
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
		await clearingHouse.depositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		showBook(marketIndex);
	});

	it('After Position Taken', async () => {
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			solPositionInitialValue,
			marketIndex
		);

		showBook(marketIndex);
	});

	it('After Position Price Moves', async () => {
		// const _priceIncreaseFactor = new BN(2);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(initialSOLPrice * MARK_PRICE_PRECISION.toNumber() * 1.0001)
		);

		showBook(marketIndex);
	});
	it('Arb back to Oracle Price Moves', async () => {
		const [direction, quoteSize] = calculateTargetPriceTrade(
			clearingHouse.getMarketAccount(marketIndex),
			new BN(initialSOLPrice).mul(MARK_PRICE_PRECISION)
		);

		console.log('arbing', direction, quoteSize.toNumber());
		await clearingHouse.openPosition(direction, quoteSize, marketIndex);

		showBook(marketIndex);
	});

	it('Repeg Curve LONG', async () => {
		let marketData = clearingHouse.getMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;
		assert(ammAccountState.totalFee.eq(ammAccountState.totalFee));

		const oldPeg = ammAccountState.pegMultiplier;

		const newOraclePrice = 155;
		const newOraclePriceWithMantissa = new BN(
			newOraclePrice * MARK_PRICE_PRECISION.toNumber()
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsdOracle);
		// showCurve(marketIndex);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			QUOTE_PRECISION.mul(new BN(10)),
			marketIndex
		);
		// showBook(marketIndex);

		const priceBefore = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);
		await clearingHouse.repegAmmCurve(
			new BN(150.001 * PEG_PRECISION.toNumber()),
			marketIndex
		);
		const priceAfter = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);

		assert(newOraclePriceWithMantissa.gt(priceBefore));
		assert(priceAfter.gt(priceBefore));
		assert(newOraclePriceWithMantissa.gt(priceAfter));

		console.log('\n post repeg: \n --------');
		showCurve(marketIndex);
		// showBook(marketIndex);

		marketData = clearingHouse.getMarketAccount(marketIndex);
		console.log(marketData.amm);
		console.log();
		assert(
			marketData.amm.totalFee.gte(marketData.amm.totalFeeMinusDistributions)
		);

		const newPeg = marketData.amm.pegMultiplier;

		const userMarketPosition = userAccount.getUserAccount().positions[0];
		const linearApproxCostToAMM = convertToNumber(
			newPeg
				.sub(oldPeg)
				.mul(userMarketPosition.baseAssetAmount)
				.div(PEG_PRECISION),
			BASE_PRECISION
		);

		// console.log('cur user position:', convertBaseAssetAmountToNumber(userMarketPosition.baseAssetAmount));

		const totalCostToAMMChain = showCurve(marketIndex);

		assert(linearApproxCostToAMM > totalCostToAMMChain);
		assert(linearApproxCostToAMM / totalCostToAMMChain < 1.1);

		// const feeDist1h = calculateFeeDist(marketIndex);

		await clearingHouse.closePosition(marketIndex);

		// showCurve(marketIndex);
		// const feeDist2 = calculateFeeDist(marketIndex);
	});

	it('Repeg Curve SHORT', async () => {
		const newOraclePrice = 145;
		const newOraclePriceWithMantissa = new BN(
			newOraclePrice * MARK_PRICE_PRECISION.toNumber()
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsdOracle);
		showCurve(marketIndex);

		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			QUOTE_PRECISION.mul(new BN(100000)),
			marketIndex
		);
		const marketData1 = clearingHouse.getMarketAccount(marketIndex);
		const ammAccountState = marketData1.amm;
		const oldPeg = ammAccountState.pegMultiplier;

		const priceBefore = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);

		await clearingHouse.repegAmmCurve(
			new BN(148 * PEG_PRECISION.toNumber()),
			marketIndex
		);

		const priceAfter = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);

		assert(newOraclePriceWithMantissa.lt(priceBefore));
		assert(priceAfter.lt(priceBefore));
		assert(newOraclePriceWithMantissa.lt(priceAfter));

		const marketData = clearingHouse.getMarketAccount(marketIndex);
		const newPeg = marketData.amm.pegMultiplier;

		const userMarketPosition = userAccount.getUserAccount().positions[0];

		console.log('\n post repeg: \n --------');

		const linearApproxCostToAMM = convertToNumber(
			newPeg
				.sub(oldPeg)
				.mul(userMarketPosition.baseAssetAmount)
				.div(PEG_PRECISION),
			BASE_PRECISION
		);

		showCurve(marketIndex);
		const totalCostToAMMChain = convertToNumber(
			marketData1.amm.totalFeeMinusDistributions.sub(
				marketData.amm.totalFeeMinusDistributions
			),
			QUOTE_PRECISION
		);
		console.log(linearApproxCostToAMM, 'vs', totalCostToAMMChain);
		assert(linearApproxCostToAMM > totalCostToAMMChain);
		assert(linearApproxCostToAMM / totalCostToAMMChain < 1.02);

		await clearingHouse.closePosition(marketIndex);
	});
});
