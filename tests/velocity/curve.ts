import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
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
} from '../../packages/sdk/src';

import { liquidityBook } from './liquidityBook';

import { assert } from '../../packages/sdk/src/assert/assert';
import {
	mockOracleNoProgram,
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('AMM Curve', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let velocityClient: TestClient;

	const ammInitialQuoteAssetAmount = new anchor.BN(10 ** 8).mul(BASE_PRECISION);
	const ammInitialBaseAssetAmount = new anchor.BN(10 ** 8).mul(BASE_PRECISION);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = 0;
	const initialSOLPrice = 150;

	const usdcAmount = new BN(1e9 * QUOTE_PRECISION.toNumber());
	const initialBaseAssetAmount = new BN(
		// eslint-disable-next-line @typescript-eslint/no-loss-of-precision
		662251.6556291390728 * BASE_PRECISION.toNumber()
	);

	let userAccount: User;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		// this suite repegs the curve out of accumulated trade fees. Post
		// AMM-isolation the AMM only books its own provision, so route 100%
		// of the trade-fee remainder to it (the on-chain default is 0%).
		const feeStructure = velocityClient.getStateAccount().perpFeeStructure;
		feeStructure.ammFeeNumerator = 100;
		feeStructure.ifFeeNumerator = 0;
		await velocityClient.updatePerpFeeStructure(feeStructure);

		solUsdOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			initialSOLPrice,
			-7,
			undefined,
			10000
		);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await velocityClient.initializePerpMarket(
			0,
			solUsdOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			PEG_PRECISION.mul(new BN(initialSOLPrice))
		);

		await velocityClient.initializeUserAccount();
		userAccount = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await userAccount.subscribe();
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await userAccount.unsubscribe();
	});

	const showCurve = async (marketIndex) => {
		const marketData = velocityClient.getPerpMarketAccount(marketIndex);
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

	const showBook = async (marketIndex) => {
		const market = velocityClient.getPerpMarketAccount(marketIndex);
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
		await velocityClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		await showBook(marketIndex);
	});

	it('After Position Taken', async () => {
		await velocityClient.openPosition(
			PositionDirection.LONG,
			initialBaseAssetAmount,
			marketIndex
		);

		await showBook(marketIndex);
	});

	it('After Position Price Moves', async () => {
		// const _priceIncreaseFactor = new BN(2);
		await velocityClient.moveAmmToPrice(
			marketIndex,
			new BN(initialSOLPrice * PRICE_PRECISION.toNumber() * 1.0001)
		);

		await showBook(marketIndex);
	});
	it('Arb back to Oracle Price Moves', async () => {
		const [direction, basesize] = calculateTargetPriceTrade(
			velocityClient.getPerpMarketAccount(marketIndex),
			new BN(initialSOLPrice).mul(PRICE_PRECISION),
			undefined,
			'base'
		);

		console.log('arbing', direction, basesize.toString());
		await velocityClient.openPosition(direction, basesize, marketIndex);

		await showBook(marketIndex);
	});

	it('Repeg Curve LONG', async () => {
		let marketData = velocityClient.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;
		assert(ammAccountState.totalFee.eq(ammAccountState.totalFee));

		const oldPeg = ammAccountState.pegMultiplier;

		const newOraclePrice = 155;
		const newOraclePriceWithMantissa = new BN(
			newOraclePrice * PRICE_PRECISION.toNumber()
		);
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			newOraclePrice,
			solUsdOracle,
			10000
		);
		// showCurve(marketIndex);

		await velocityClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.div(new BN(10)),
			marketIndex
		);
		// showBook(marketIndex);

		const priceBefore = calculateReservePrice(
			velocityClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		await velocityClient.repegAmmCurve(
			new BN(150.001 * PEG_PRECISION.toNumber()),
			marketIndex
		);
		const priceAfter = calculateReservePrice(
			velocityClient.getPerpMarketAccount(marketIndex),
			undefined
		);

		assert(newOraclePriceWithMantissa.gt(priceBefore));
		assert(priceAfter.gt(priceBefore));
		assert(newOraclePriceWithMantissa.gt(priceAfter));

		console.log('\n post repeg: \n --------');
		await showCurve(marketIndex);
		// showBook(marketIndex);

		marketData = velocityClient.getPerpMarketAccount(marketIndex);
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

		await velocityClient.closePosition(marketIndex);

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

	// 	await velocityClient.openPosition(
	// 		PositionDirection.SHORT,
	// 		BASE_PRECISION.div(new BN(1000)),
	// 		marketIndex
	// 	);
	// 	const marketData1 = velocityClient.getPerpMarketAccount(marketIndex);
	// 	const ammAccountState = marketData1.amm;
	// 	const oldPeg = ammAccountState.pegMultiplier;

	// 	const priceBefore = calculateReservePrice(
	// 		velocityClient.getPerpMarketAccount(marketIndex)
	// 	);

	// 	await velocityClient.repegAmmCurve(
	// 		new BN(148 * PEG_PRECISION.toNumber()),
	// 		marketIndex
	// 	);

	// 	const priceAfter = calculateReservePrice(
	// 		velocityClient.getPerpMarketAccount(marketIndex)
	// 	);

	// 	assert(newOraclePriceWithMantissa.lt(priceBefore));
	// 	assert(priceAfter.lt(priceBefore));
	// 	assert(newOraclePriceWithMantissa.lt(priceAfter));

	// 	const marketData = velocityClient.getPerpMarketAccount(marketIndex);
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

	// 	await velocityClient.closePosition(marketIndex);
	// });

	it('calculateBudgetedPeg (sdk tests)', async () => {
		const marketData1 = velocityClient.getPerpMarketAccount(marketIndex);

		let amm = marketData1.amm;

		// unbalanced but no net position
		console.log('netBaseAssetAmount:', amm.baseAssetAmountWithAmm.toString());
		assert(!amm.baseAssetReserve.eq(amm.quoteAssetReserve));
		console.log(amm.baseAssetAmountWithAmm);
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
		await velocityClient.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			marketIndex
		);

		amm = velocityClient.getPerpMarketAccount(marketIndex).amm;

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

		await velocityClient.closePosition(marketIndex);

		// check if long
		await velocityClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			marketIndex
		);
		await velocityClient.fetchAccounts();
		amm = velocityClient.getPerpMarketAccount(marketIndex).amm;

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
		await velocityClient.fetchAccounts();

		await velocityClient.closePosition(marketIndex);
	});
});
