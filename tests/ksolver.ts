import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { BN, OracleSource } from '../sdk';
import {
	TestClient,
	PRICE_PRECISION,
	calculateReservePrice,
	calculateTradeSlippage,
	calculateTargetPriceTrade,
	PositionDirection,
	PEG_PRECISION,
	MAX_LEVERAGE,
	QUOTE_PRECISION,
	convertToNumber,
	User,
} from '../sdk/src';

import { liquidityBook } from './liquidityBook';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('AMM Curve', () => {
	// K SOLVER: find opitimal k given exchange details

	// const NUM_USERS = 100;
	const MAX_DEPOSIT = 1000;
	const initialSOLPrice = 150;

	const MAX_USER_TRADE = MAX_DEPOSIT * MAX_LEVERAGE.toNumber();
	// const ARB_CAPITAL = 50000;
	// const TARGET_MAX_SLIPPAGE = 0.2; // for MAX_DEPOSIT * MAX_LEVERAGE position

	// function calculateTheoPriceImpact(
	// 	direction: PositionDirection,
	// 	amount: BN,
	// 	kSqrt: BN,
	// 	unit?:
	// 		| 'entryPrice'
	// 		| 'maxPrice'
	// 		| 'priceDelta'
	// 		| 'priceDeltaAsNumber'
	// 		| 'pctAvg'
	// 		| 'pctMax'
	// 		| 'quoteAssetAmount'
	// 		| 'quoteAssetAmountPeg'
	// 		| 'acquiredBaseAssetAmount'
	// 		| 'acquiredQuoteAssetAmount'
	// ) {
	// 	if (amount.eq(new BN(0))) {
	// 		return new BN(0);
	// 	}
	// 	const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
	// 	const oldPrice = this.calculateReservePrice(marketIndex);
	// 	const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);

	// 	const [newQuoteAssetAmount, newBaseAssetAmount] = this.findSwapOutput(
	// 		kSqrt,
	// 		kSqrt,
	// 		direction,
	// 		amount.abs(),
	// 		'quote',
	// 		invariant,
	// 		market.amm.pegMultiplier
	// 	);

	// 	const entryPrice = this.calculateCurvePriceWithMantissa(
	// 		market.amm.baseAssetReserve.sub(newBaseAssetAmount),
	// 		market.amm.quoteAssetReserve.sub(newQuoteAssetAmount),
	// 		market.amm.pegMultiplier
	// 	).mul(new BN(-1));

	// 	if (entryPrice.eq(new BN(0))) {
	// 		return new BN(0);
	// 	}

	// 	const newPrice = this.calculateCurvePriceWithMantissa(
	// 		newBaseAssetAmount,
	// 		newQuoteAssetAmount,
	// 		market.amm.pegMultiplier
	// 	);

	// 	if (oldPrice == newPrice) {
	// 		throw new Error('insufficient `amount` passed:');
	// 	}

	// 	let slippage;
	// 	if (newPrice.gt(oldPrice)) {
	// 		if (unit == 'pctMax') {
	// 			slippage = newPrice.sub(oldPrice).mul(PRICE_PRECISION).div(oldPrice);
	// 		} else if (unit == 'pctAvg') {
	// 			slippage = entryPrice.sub(oldPrice).mul(PRICE_PRECISION).div(oldPrice);
	// 		} else if (
	// 			[
	// 				'priceDelta',
	// 				'quoteAssetAmount',
	// 				'quoteAssetAmountPeg',
	// 				'priceDeltaAsNumber',
	// 			].includes(unit)
	// 		) {
	// 			slippage = newPrice.sub(oldPrice);
	// 		}
	// 	} else {
	// 		if (unit == 'pctMax') {
	// 			slippage = oldPrice.sub(newPrice).mul(PRICE_PRECISION).div(oldPrice);
	// 		} else if (unit == 'pctAvg') {
	// 			slippage = oldPrice.sub(entryPrice).mul(PRICE_PRECISION).div(oldPrice);
	// 		} else if (
	// 			[
	// 				'priceDelta',
	// 				'quoteAssetAmount',
	// 				'quoteAssetAmountPeg',
	// 				'priceDeltaAsNumber',
	// 			].includes(unit)
	// 		) {
	// 			slippage = oldPrice.sub(newPrice);
	// 		}
	// 	}
	// 	if (unit == 'quoteAssetAmount') {
	// 		slippage = slippage.mul(amount);
	// 	} else if (unit == 'quoteAssetAmountPeg') {
	// 		slippage = slippage.mul(amount).div(market.amm.pegMultiplier);
	// 	} else if (unit == 'priceDeltaAsNumber') {
	// 		slippage = convertToNumber(slippage);
	// 	}

	// 	return slippage;
	// }

	// function kSolver() {
	// 	const kSqrt0 = new anchor.BN(2 * 10 ** 13);

	// 	let count = 0;

	// 	let avgSlippageCenter = calculateTheoPriceImpact(
	// 		PositionDirection.LONG,
	// 		new BN(MAX_DEPOSIT).mul(MAX_LEVERAGE).mul(PRICE_PRECISION),
	// 		kSqrt0,
	// 		'pctMax'
	// 	);

	// 	const targetSlippageBN = new BN(
	// 		TARGET_MAX_SLIPPAGE * PRICE_PRECISION.toNumber()
	// 	);
	// 	let kSqrtI: BN;

	// 	while (avgSlippageCenter.gt(targetSlippageBN) || count > 1000) {
	// 		kSqrtI = kSqrt0.mul(targetSlippageBN.div(avgSlippageCenter));
	// 		avgSlippageCenter = calculateTheoPriceImpact(
	// 			PositionDirection.LONG,
	// 			new BN(MAX_DEPOSIT).mul(MAX_LEVERAGE).mul(PRICE_PRECISION),
	// 			kSqrtI,
	// 			'pctMax'
	// 		);

	// 		count += 1;
	// 	}

	// 	return kSqrtI;
	// }

	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	const kSqrt = new anchor.BN(2 * 10 ** 12);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = 0;
	const initialSOLPriceBN = new BN(initialSOLPrice * PEG_PRECISION.toNumber());
	function normAssetAmount(assetAmount: BN, pegMultiplier: BN): BN {
		// assetAmount is scaled to offer comparable slippage
		return assetAmount.mul(PRICE_PRECISION).div(pegMultiplier);
	}
	const usdcAmount = new BN(1000 * 10 ** 6);
	const solPositionInitialValue = usdcAmount;

	let userAccount: User;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		solUsdOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			initialSOLPrice
		);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solUsdOracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		const periodicity = new BN(60 * 60); // 1 HOUR
		const kSqrtNorm = normAssetAmount(kSqrt, initialSOLPriceBN);
		await driftClient.initializePerpMarket(
			0,

			solUsdOracle,
			kSqrtNorm,
			kSqrtNorm,
			periodicity,
			initialSOLPriceBN
		);
		await driftClient.initializeUserAccount();
		userAccount = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await userAccount.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await userAccount.unsubscribe();
	});

	const showBook = (marketIndex) => {
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oraclePriceData = driftClient.getOracleDataForPerpMarket(marketIndex);
		const currentMark = calculateReservePrice(market, oraclePriceData);

		const [bidsPrice, bidsCumSize, asksPrice, asksCumSize] = liquidityBook(
			market,
			3,
			0.5
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
		await driftClient.deposit(usdcAmount, 0, userUSDCAccount.publicKey);
	});

	it('After Position Taken', async () => {
		await driftClient.openPosition(
			PositionDirection.LONG,
			solPositionInitialValue,
			marketIndex
		);

		const avgSlippageCenter = calculateTradeSlippage(
			PositionDirection.LONG,
			new BN(MAX_USER_TRADE * PRICE_PRECISION.toNumber()),
			driftClient.getPerpMarketAccount(0)
		)[0];
		showBook(marketIndex);

		const targetPriceUp = new BN(
			initialSOLPrice * PRICE_PRECISION.toNumber() * 2
		);

		const [_direction, tradeSize, _] = calculateTargetPriceTrade(
			driftClient.getPerpMarketAccount(marketIndex),
			targetPriceUp
		);

		await driftClient.moveAmmToPrice(marketIndex, targetPriceUp);

		const avgSlippage25PctOut = calculateTradeSlippage(
			PositionDirection.LONG,
			new BN(MAX_USER_TRADE * PRICE_PRECISION.toNumber()),
			driftClient.getPerpMarketAccount(0)
		)[0];

		showBook(marketIndex);

		console.log(
			'arbBot Long Size',
			convertToNumber(tradeSize, QUOTE_PRECISION),
			'\n Center Slippage:',
			convertToNumber(avgSlippageCenter) / 100,
			'\n 100% up out Slippage:',
			convertToNumber(avgSlippage25PctOut) / 100
		);
	});
});
