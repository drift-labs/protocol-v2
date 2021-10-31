import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import {
	Admin,
	AMM_MANTISSA,
	PEG_SCALAR,
	USDC_PRECISION,
	calculateTargetPriceTrade,
	ClearingHouseUser,
	PositionDirection,
	stripBaseAssetPrecision,
	stripMantissa,
	liquidityBook,
} from '../sdk/src';
import { assert } from '../sdk/src/assert/assert';
import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';

describe('AMM Curve', () => {
	const provider = anchor.Provider.local();
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
			marketIndex,
			solUsdOracle,
			ammInitialBaseAssetAmount.mul(PEG_SCALAR),
			ammInitialQuoteAssetAmount.mul(PEG_SCALAR),
			periodicity,
			PEG_SCALAR.mul(new BN(initialSOLPrice))
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
		const marketsAccount = clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammAccountState = marketData.amm;

		console.log(
			'baseAssetAmountShort',
			stripBaseAssetPrecision(marketData.baseAssetAmountShort),
			'baseAssetAmountLong',
			stripBaseAssetPrecision(marketData.baseAssetAmountLong)
		);

		console.log(
			'pegMultiplier',
			stripMantissa(ammAccountState.pegMultiplier, PEG_SCALAR)
		);
		console.log(
			'cumulativeRepegRebateShort',
			stripMantissa(ammAccountState.cumulativeRepegRebateShort, USDC_PRECISION)
		);
		console.log(
			'cumulativeRepegRebateLong',
			stripMantissa(ammAccountState.cumulativeRepegRebateLong, USDC_PRECISION)
		);

		const totalFeeNum = stripMantissa(ammAccountState.totalFee, USDC_PRECISION);
		const cumFeeNum = stripMantissa(
			ammAccountState.totalFeeMinusDistributions,
			USDC_PRECISION
		);
		console.log('totalFee', totalFeeNum);
		console.log('cumFee', cumFeeNum);
		return totalFeeNum - cumFeeNum;
	};

	// const calculateFeeDist = (marketIndex) => {
	// 	const marketsAccount = clearingHouse.getMarketsAccount();
	// 	const marketData = marketsAccount.markets[marketIndex.toNumber()];
	// 	const ammAccountState = marketData.amm;

	// 	const feeDist= marketData.amm.cumulativeFee.add(userAccount.getTotalCollateral());
	// 	// console.log(stripMantissa(usdcAmount, USDC_PRECISION), stripMantissa(feeDist, USDC_PRECISION));

	// 	return feeDist;
	// };

	const showBook = (marketIndex) => {
		const market =
			clearingHouse.getMarketsAccount().markets[marketIndex.toNumber()];
		const currentMark =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		const [bidsPrice, bidsCumSize, asksPrice, asksCumSize] = liquidityBook(
			market,
			3,
			0.1
		);

		for (let i = asksCumSize.length - 1; i >= 0; i--) {
			console.log(
				stripMantissa(asksPrice[i]),
				stripMantissa(asksCumSize[i], USDC_PRECISION)
			);
		}

		console.log('------------');
		console.log(currentMark.toNumber() / AMM_MANTISSA.toNumber());
		console.log(
			'peg:',
			stripMantissa(market.amm.pegMultiplier, PEG_SCALAR),
			'k (M*M):',
			stripMantissa(market.amm.sqrtK)
		);
		console.log('------------');
		for (let i = 0; i < bidsCumSize.length; i++) {
			console.log(
				stripMantissa(bidsPrice[i]),
				stripMantissa(bidsCumSize[i], USDC_PRECISION)
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
			new BN(initialSOLPrice * AMM_MANTISSA.toNumber() * 1.0001)
		);

		showBook(marketIndex);
	});
	it('Arb back to Oracle Price Moves', async () => {
		const [direction, quoteSize] = calculateTargetPriceTrade(
			clearingHouse.getMarket(marketIndex),
			new BN(initialSOLPrice).mul(AMM_MANTISSA)
		);

		console.log('arbing', direction, quoteSize.toNumber());
		await clearingHouse.openPosition(direction, quoteSize, marketIndex);

		showBook(marketIndex);
	});

	it('Repeg Curve LONG', async () => {
		let marketsAccount = clearingHouse.getMarketsAccount();
		let marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammAccountState = marketData.amm;
		assert(ammAccountState.totalFee.eq(ammAccountState.totalFee));

		const oldPeg = ammAccountState.pegMultiplier;

		const newOraclePrice = 155;
		const newOraclePriceWithMantissa = new BN(
			newOraclePrice * AMM_MANTISSA.toNumber()
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsdOracle);
		// showCurve(marketIndex);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			USDC_PRECISION.mul(new BN(10)),
			marketIndex
		);
		// showBook(marketIndex);

		const priceBefore =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);
		await clearingHouse.repegAmmCurve(new BN(0), marketIndex);
		const priceAfter =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		assert(newOraclePriceWithMantissa.gt(priceBefore));
		assert(priceAfter.gt(priceBefore));
		assert(newOraclePriceWithMantissa.gt(priceAfter));

		// console.log('\n post repeg: \n --------');
		// showCurve(marketIndex);
		// showBook(marketIndex);

		marketsAccount = clearingHouse.getMarketsAccount();
		marketData = marketsAccount.markets[marketIndex.toNumber()];
		console.log(marketData.amm);
		assert(
			marketData.amm.totalFee.gt(marketData.amm.totalFeeMinusDistributions)
		);

		const newPeg = marketData.amm.pegMultiplier;

		const userMarketPosition =
			userAccount.getUserPositionsAccount().positions[0];
		const costToAMM = stripBaseAssetPrecision(
			newPeg.sub(oldPeg).mul(userMarketPosition.baseAssetAmount).div(PEG_SCALAR)
		);

		const totalCostToAMMChain = showCurve(marketIndex);

		assert(Math.abs(costToAMM - totalCostToAMMChain) < 1e-6);

		// const feeDist1h = calculateFeeDist(marketIndex);

		await clearingHouse.closePosition(marketIndex);

		// showCurve(marketIndex);
		// const feeDist2 = calculateFeeDist(marketIndex);
	});

	it('Repeg Curve SHORT', async () => {
		const newOraclePrice = 145;
		const newOraclePriceWithMantissa = new BN(
			newOraclePrice * AMM_MANTISSA.toNumber()
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsdOracle);
		showCurve(marketIndex);

		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			USDC_PRECISION,
			marketIndex
		);

		const priceBefore =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		// const marketsAccount = clearingHouse.getMarketsAccount();
		// const marketData = marketsAccount.markets[marketIndex.toNumber()];
		await clearingHouse.repegAmmCurve(new BN(0), marketIndex);

		const priceAfter =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		assert(newOraclePriceWithMantissa.lt(priceBefore));
		assert(priceAfter.lt(priceBefore));
		assert(newOraclePriceWithMantissa.lt(priceAfter));

		console.log('\n post repeg: \n --------');
		showCurve(marketIndex);

		await clearingHouse.closePosition(marketIndex);
	});
});
