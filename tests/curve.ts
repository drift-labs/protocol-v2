import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import {
	TestClient,
	PRICE_PRECISION,
	PEG_PRECISION,
	QUOTE_PRECISION,
	BASE_PRECISION,
	BN,
	calculateReservePrice,
	calculateTargetPriceTrade,
	User,
	PositionDirection,
	convertToNumber,
	calculateBudgetedPeg,
	QUOTE_SPOT_MARKET_INDEX,
	PublicKey,
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
import { BulkAccountLoader } from '../sdk';

/**
 * # Tests the functionality of the AMM Curve.
 * 
 * This test case tests the AMM Curve by initializing the quote and spot markets, creating a price feed,
 * initializing the perp market, and initializing a user account. Then, it shows the curve and the book.
 * 
 * ## Common steps for each test:
 * 1. Mock USDC mint and user account.
 * 2. Initialize test drift client.
 * 3. Create a SOL/USD oracle and set its initial price.
 * 4. Initialize the perp market using the oracle and the initial asset amounts.
 * 5. Initialize the user account and subscribe to updates.
 * 6. Show the curve data and the book.
 * 
 * ## Test Cases
 * 
 * ### After Deposit
 * 
 * ### After Position Taken
 * 
 * ### Arb back to Oracle Price Moves
 * Checks if the arbitrage between the oracle and perp market prices works as
 * expected. It calculates the target price trade based on the given parameters
 * and opens a position with the calculated direction and base size.
 *
 * ### Repeg Curve LONG  
 * Scenario where the AMM curve of a perp market is repegged by a user, causing
 * the reserve price to increase. It asserts that the new reserve price is greater
 * than the old one, and that the cost to the user for the AMM change is less
 * than the total cost to the AMM chain.
 * 
 * ### calculateBudgetedPeg (sdk tests)
 * Tests Budgeted Peg calculation for up($150->$200) and down($150->$10) moves.
 */
describe('AMM Curve', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	const driftClient = new TestClient({
		connection,
		wallet: provider.wallet,
		programID: chProgram.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: [0],
		spotMarketIndexes: [0],
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});

	const ammInitialQuoteAssetAmount = new anchor.BN(10 ** 8).mul(BASE_PRECISION);
	const ammInitialBaseAssetAmount = new anchor.BN(10 ** 8).mul(BASE_PRECISION);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle: PublicKey;
	const marketIndex = 0;
	const initialSOLPrice = 150;

	const usdcAmount = new BN(1e9 * QUOTE_PRECISION.toNumber());
	const initialBaseAssetAmount = new BN(
		// eslint-disable-next-line @typescript-eslint/no-loss-of-precision
		662251.6556291390728 * BASE_PRECISION.toNumber()
	);

	let userAccount: User;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});
		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			solUsdOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			PEG_PRECISION.mul(new BN(initialSOLPrice))
		);

		await driftClient.initializeUserAccount();
		userAccount = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await userAccount.unsubscribe();
	});

	/**
	 * Shows curve data.
	 * 
	 * @param {number} marketIndex - The index of the perp market.
	 * 
	 * @returns {Promise<number>} - The difference between the total fee and the cumulative fee.
	 */
	const showCurve = async (marketIndex: number): Promise<number> => {
		const marketData = driftClient.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;

		console.log(
			'baseAssetAmountShort',
			convertToNumber(marketData.amm.baseAssetAmountShort, BASE_PRECISION),
			'baseAssetAmountLong',
			convertToNumber(marketData.amm.baseAssetAmountLong, BASE_PRECISION)
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

	/**
	 * Displays the liquidity book for the specified perp market, including
	 * the current mark price, the peg multiplier, and the current k value.
	 * 
	 * @param {number} marketIndex - The index of the perp market.
	 * 
	 * @returns {Promise<void>}
	 */
	const showBook = async (marketIndex: number) => {
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const currentMark = calculateReservePrice(market, undefined);

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
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		await showBook(marketIndex);
	});

	it('After Position Taken', async () => {
		await driftClient.openPosition(
			PositionDirection.LONG,
			initialBaseAssetAmount,
			marketIndex
		);

		await showBook(marketIndex);
	});

	it('After Position Price Moves', async () => {
		// const _priceIncreaseFactor = new BN(2);
		await driftClient.moveAmmToPrice(
			marketIndex,
			new BN(initialSOLPrice * PRICE_PRECISION.toNumber() * 1.0001)
		);

		await showBook(marketIndex);
	});
	it('Arb back to Oracle Price Moves', async () => {
		const [direction, basesize] = calculateTargetPriceTrade(
			driftClient.getPerpMarketAccount(marketIndex),
			new BN(initialSOLPrice).mul(PRICE_PRECISION),
			undefined,
			'base'
		);

		console.log('arbing', direction, basesize.toString());
		await driftClient.openPosition(direction, basesize, marketIndex);

		await showBook(marketIndex);
	});

	it('Repeg Curve LONG', async () => {
		let marketData = driftClient.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;
		assert(ammAccountState.totalFee.eq(ammAccountState.totalFee));

		const oldPeg = ammAccountState.pegMultiplier;

		const newOraclePrice = 155;
		const newOraclePriceWithMantissa = new BN(
			newOraclePrice * PRICE_PRECISION.toNumber()
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsdOracle);
		// showCurve(marketIndex);

		await driftClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.div(new BN(10)),
			marketIndex
		);
		// showBook(marketIndex);

		const priceBefore = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		await driftClient.repegAmmCurve(
			new BN(150.001 * PEG_PRECISION.toNumber()),
			marketIndex
		);
		const priceAfter = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);

		assert(newOraclePriceWithMantissa.gt(priceBefore));
		assert(priceAfter.gt(priceBefore));
		assert(newOraclePriceWithMantissa.gt(priceAfter));

		console.log('\n post repeg: \n --------');
		await showCurve(marketIndex);
		// showBook(marketIndex);

		marketData = driftClient.getPerpMarketAccount(marketIndex);
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

		const totalCostToAMMChain = await showCurve(marketIndex);

		assert(linearApproxCostToAMM > totalCostToAMMChain);
		assert(linearApproxCostToAMM / totalCostToAMMChain < 1.1);

		// const feeDist1h = calculateFeeDist(marketIndex);

		await driftClient.closePosition(marketIndex);

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

	// 	await driftClient.openPosition(
	// 		PositionDirection.SHORT,
	// 		BASE_PRECISION.div(new BN(1000)),
	// 		marketIndex
	// 	);
	// 	const marketData1 = driftClient.getPerpMarketAccount(marketIndex);
	// 	const ammAccountState = marketData1.amm;
	// 	const oldPeg = ammAccountState.pegMultiplier;

	// 	const priceBefore = calculateReservePrice(
	// 		driftClient.getPerpMarketAccount(marketIndex)
	// 	);

	// 	await driftClient.repegAmmCurve(
	// 		new BN(148 * PEG_PRECISION.toNumber()),
	// 		marketIndex
	// 	);

	// 	const priceAfter = calculateReservePrice(
	// 		driftClient.getPerpMarketAccount(marketIndex)
	// 	);

	// 	assert(newOraclePriceWithMantissa.lt(priceBefore));
	// 	assert(priceAfter.lt(priceBefore));
	// 	assert(newOraclePriceWithMantissa.lt(priceAfter));

	// 	const marketData = driftClient.getPerpMarketAccount(marketIndex);
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

	// 	await driftClient.closePosition(marketIndex);
	// });

	it('calculateBudgetedPeg (sdk tests)', async () => {
		const marketData1 = driftClient.getPerpMarketAccount(marketIndex);

		let amm = marketData1.amm;

		// unbalanced but no net position
		console.log('netBaseAssetAmount:', amm.baseAssetAmountWithAmm.toString());
		assert(!amm.baseAssetReserve.eq(amm.quoteAssetReserve));
		assert(amm.baseAssetAmountWithAmm.eq(new BN(0)));

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
		await driftClient.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			marketIndex
		);

		amm = driftClient.getPerpMarketAccount(marketIndex).amm;

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
		assert(candidatePegDown.eq(new BN(148987813)));

		await driftClient.closePosition(marketIndex);

		// check if long
		await driftClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			marketIndex
		);
		await driftClient.fetchAccounts();
		amm = driftClient.getPerpMarketAccount(marketIndex).amm;

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
		assert(candidatePegUp2.eq(new BN(151014187)));

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
		await driftClient.fetchAccounts();

		await driftClient.closePosition(marketIndex);
	});
});
