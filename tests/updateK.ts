import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	AMM_RESERVE_PRECISION,
	BASE_PRECISION,
	BN,
	BulkAccountLoader,
	calculateTradeSlippage,
} from '../sdk';

import { Keypair } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import {
	TestClient,
	PRICE_PRECISION,
	calculateReservePrice,
	User,
	PEG_PRECISION,
	PositionDirection,
	convertToNumber,
	squareRootBN,
	calculateBudgetedKBN,
	QUOTE_SPOT_MARKET_INDEX,
	MarketStatus,
} from '../sdk/src';

import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { QUOTE_PRECISION } from '../sdk/lib';

const ZERO = new BN(0);

describe('update k', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	const initialSOLPrice = 150;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);
	const usdcAmount = new BN(1e9 * 10 ** 6);

	let userAccount: User;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		driftClient = new TestClient({
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
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		const solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});

		await driftClient.initializePerpMarket(
			0,
			solUsdOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(initialSOLPrice * PEG_PRECISION.toNumber())
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

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

	it('increase k (FREE)', async () => {
		const marketIndex = 0;

		const oldKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		const ammOld = driftClient.getPerpMarketAccount(0).amm;
		const newSqrtK = ammInitialBaseAssetReserve.mul(new BN(10));
		await driftClient.updateK(marketIndex, newSqrtK);

		await driftClient.fetchAccounts();
		const newKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);

		const amm = driftClient.getPerpMarketAccount(0).amm;

		const marginOfError = new BN(100);

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK, AMM_RESERVE_PRECISION),
			'oldKPrice:',
			convertToNumber(oldKPrice)
		);
		console.log(
			'newSqrtK',
			convertToNumber(newSqrtK, AMM_RESERVE_PRECISION),
			'newKPrice:',
			convertToNumber(newKPrice)
		);

		assert(ammOld.sqrtK.lt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));
	});

	it('increase k base/quote imbalance (FREE)', async () => {
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;

		const targetPriceUp = new BN(
			initialSOLPrice * PRICE_PRECISION.toNumber() * 44.1
		);
		await driftClient.moveAmmToPrice(marketIndex, targetPriceUp);
		await driftClient.fetchAccounts();

		const marketOld = driftClient.getPerpMarketAccount(0);

		const oldKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		const ammOld = marketOld.amm;

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(1.000132325235 * PRICE_PRECISION.toNumber()))
			.div(PRICE_PRECISION);

		await driftClient.updateK(marketIndex, newSqrtK);

		await driftClient.fetchAccounts();
		const newKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);

		const amm = driftClient.getPerpMarketAccount(0).amm;

		const marginOfError = new BN(PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK),
			'baa/qaa:',
			ammOld.baseAssetReserve.toString(),
			'/',
			ammOld.quoteAssetReserve.toString(),
			'oldKPrice:',
			convertToNumber(oldKPrice)
		);
		console.log(
			'newSqrtK',
			convertToNumber(newSqrtK),
			'baa/qaa:',
			amm.baseAssetReserve.toString(),
			'/',
			amm.quoteAssetReserve.toString(),
			'newKPrice:',
			convertToNumber(newKPrice)
		);

		assert(ammOld.sqrtK.lt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));
	});

	it('failure: lower k (more than 2.5%) position imbalance (AMM PROFIT)', async () => {
		const marketIndex = 0;

		const targetPriceBack = new BN(
			initialSOLPrice * PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = driftClient.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await driftClient.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await driftClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.div(new BN(initialSOLPrice)),
			marketIndex
		);
		console.log('$1 position taken');
		await driftClient.fetchAccounts();
		const marketOld = driftClient.getPerpMarketAccount(0);
		assert(!marketOld.amm.baseAssetAmountWithAmm.eq(ZERO));

		const oldKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		const ammOld = marketOld.amm;
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(0.5 * PRICE_PRECISION.toNumber()))
			.div(PRICE_PRECISION);

		try {
			await driftClient.updateK(marketIndex, newSqrtK);
			assert(false);
		} catch {
			await driftClient.fetchAccounts();
			const marketKChange = await driftClient.getPerpMarketAccount(0);
			const ammKChange = marketKChange.amm;

			const newKPrice = calculateReservePrice(
				driftClient.getPerpMarketAccount(marketIndex),
				undefined
			);

			console.log('$1 position closing');

			await driftClient.closePosition(marketIndex);
			console.log('$1 position closed');

			const amm = driftClient.getPerpMarketAccount(0).amm;

			const marginOfError = new BN(PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

			console.log(
				'oldSqrtK',
				convertToNumber(ammOld.sqrtK),
				'oldKPrice:',
				convertToNumber(oldKPrice)
			);
			console.log(
				'newSqrtK',
				convertToNumber(newSqrtK),
				'newKPrice:',
				convertToNumber(newKPrice)
			);

			assert(ammOld.sqrtK.eq(amm.sqrtK));
			assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
			assert(!amm.sqrtK.eq(newSqrtK));

			console.log(
				'realizedFeeOld',
				convertToNumber(ammOld.totalFeeMinusDistributions, QUOTE_PRECISION),
				'realizedFeePostK',
				convertToNumber(ammKChange.totalFeeMinusDistributions, QUOTE_PRECISION),
				'realizedFeePostClose',
				convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION)
			);
			console.log(
				'USER getTotalCollateral',
				convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
			);

			assert(
				ammKChange.totalFeeMinusDistributions.eq(
					ammOld.totalFeeMinusDistributions
				)
			); // equal since no k change
			assert(
				amm.totalFeeMinusDistributions.gte(ammOld.totalFeeMinusDistributions)
			); // greater/equal since user closed
		}
	});
	it('lower k (2%) position imbalance (AMM PROFIT)', async () => {
		const marketIndex = 0;

		const targetPriceBack = new BN(
			initialSOLPrice * PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = driftClient.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await driftClient.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await driftClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.div(new BN(initialSOLPrice)).mul(new BN(1000)),
			marketIndex
		);
		console.log('$1000 position taken');
		await driftClient.fetchAccounts();
		const marketOld = driftClient.getPerpMarketAccount(0);
		assert(!marketOld.amm.baseAssetAmountWithAmm.eq(ZERO));

		const oldKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		const ammOld = marketOld.amm;
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(0.98 * PRICE_PRECISION.toNumber()))
			.div(PRICE_PRECISION);
		const smallTradeSlipOld = calculateTradeSlippage(
			PositionDirection.LONG,
			QUOTE_PRECISION.mul(new BN(1000)),
			marketOld
		)[0];

		try {
			await driftClient.updateK(marketIndex, newSqrtK);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		await driftClient.fetchAccounts();
		const marketKChange = driftClient.getPerpMarketAccount(0);
		const ammKChange = marketKChange.amm;

		const newKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);

		const smallTradeSlip = calculateTradeSlippage(
			PositionDirection.LONG,
			QUOTE_PRECISION.mul(new BN(1000)),
			marketKChange
		)[0];
		console.log(
			'$1000 slippage (',
			convertToNumber(smallTradeSlipOld),
			'->',
			convertToNumber(smallTradeSlip),
			')'
		);
		assert(smallTradeSlipOld.lt(smallTradeSlip));

		console.log('$1000 position closing');

		await driftClient.closePosition(marketIndex);
		console.log('$1 position closed');

		const amm = driftClient.getPerpMarketAccount(0).amm;

		const marginOfError = new BN(PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK),
			'oldKPrice:',
			convertToNumber(oldKPrice)
		);
		console.log(
			'newSqrtK',
			convertToNumber(newSqrtK),
			'newKPrice:',
			convertToNumber(newKPrice)
		);

		assert(ammOld.sqrtK.gt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));

		console.log(
			'realizedFeeOld',
			convertToNumber(ammOld.totalFeeMinusDistributions, QUOTE_PRECISION),
			'realizedFeePostK',
			convertToNumber(ammKChange.totalFeeMinusDistributions, QUOTE_PRECISION),
			'realizedFeePostClose',
			convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION)
		);
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		assert(
			amm.totalFeeMinusDistributions.gt(ammOld.totalFeeMinusDistributions)
		);
	});
	it('increase k position imbalance (AMM LOSS)', async () => {
		const marketIndex = 0;
		const targetPriceBack = new BN(
			initialSOLPrice * PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = driftClient.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await driftClient.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(QUOTE_PRECISION).mul(new BN(30000)),
			marketIndex
		);
		console.log('$1 position taken');
		await driftClient.fetchAccounts();
		const marketOld = driftClient.getPerpMarketAccount(0);
		assert(!marketOld.amm.baseAssetAmountWithAmm.eq(ZERO));

		const oldKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		const ammOld = marketOld.amm;
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		const smallTradeSlipOld = calculateTradeSlippage(
			PositionDirection.LONG,
			QUOTE_PRECISION,
			marketOld
		)[0];

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(1.02 * PRICE_PRECISION.toNumber()))
			.div(PRICE_PRECISION);
		await driftClient.updateK(marketIndex, newSqrtK);

		await driftClient.fetchAccounts();
		const marketKChange = driftClient.getPerpMarketAccount(0);
		const ammKChange = marketKChange.amm;
		const newKPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);

		const smallTradeSlip = calculateTradeSlippage(
			PositionDirection.LONG,
			QUOTE_PRECISION,
			marketKChange
		)[0];
		console.log(
			'$1 slippage (',
			convertToNumber(smallTradeSlipOld),
			'->',
			convertToNumber(smallTradeSlip),
			')'
		);
		assert(smallTradeSlipOld.gte(smallTradeSlip));

		console.log('$1 position closing');

		await driftClient.closePosition(marketIndex);
		console.log('$1 position closed');

		await driftClient.fetchAccounts();
		const markets = driftClient.getPerpMarketAccount(0);
		const amm = markets.amm;

		const marginOfError = new BN(PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK, AMM_RESERVE_PRECISION),
			'oldKPrice:',
			convertToNumber(oldKPrice)
		);
		console.log(
			'newSqrtK',
			convertToNumber(newSqrtK, AMM_RESERVE_PRECISION),
			'newKPrice:',
			convertToNumber(newKPrice)
		);

		assert(ammOld.sqrtK.lt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));

		console.log(
			'old sqrt X*Y:',
			convertToNumber(
				squareRootBN(ammOld.baseAssetReserve.mul(ammOld.quoteAssetReserve)),
				AMM_RESERVE_PRECISION
			),
			'close sqrt X*Y:',
			convertToNumber(
				squareRootBN(
					ammKChange.baseAssetReserve.mul(ammKChange.quoteAssetReserve)
				),
				AMM_RESERVE_PRECISION
			),
			'close sqrt X*Y:',
			convertToNumber(
				squareRootBN(amm.baseAssetReserve.mul(amm.quoteAssetReserve)),
				AMM_RESERVE_PRECISION
			)
		);

		console.log(
			'realizedFeeOld',
			convertToNumber(ammOld.totalFeeMinusDistributions, QUOTE_PRECISION),
			'realizedFeePostK',
			convertToNumber(ammKChange.totalFeeMinusDistributions, QUOTE_PRECISION),
			'realizedFeePostClose',
			convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION)
		);

		assert(
			amm.totalFeeMinusDistributions.gt(ammOld.totalFeeMinusDistributions)
		);

		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);
	});

	it('budget k change (sdk math)', async () => {
		// // pay $.11 to increase k
		let [numer1, denom1] = calculateBudgetedKBN(
			new BN('4975000000'), // x
			new BN('5025000000'), // y
			new BN('114638'), // cost
			new BN('40000000'), // peg
			new BN('4975000000') // net position
		);
		console.log(numer1.toString(), '/', denom1.toString());

		// Z-TODO
		console.log(denom1.toString());
		console.log(numer1.toString());
		assert(denom1.eq(new BN(4969200900)));
		assert(numer1.gte(new BN(4980550349)));

		// gain $.11 by decreasing k
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('4975000000'), // x
			new BN('5025000000'), // y
			new BN('-114638'), // cost
			new BN('40000000'), // peg
			new BN('4975000000') // net position
		);
		console.log(numer1.toString(), '/', denom1.toString());
		assert(numer1.eq(new BN(4969200900)));
		assert(denom1.eq(new BN(4980550349)));
		assert(numer1.lt(denom1));

		// pay $11 to increase k
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('4975000000'),
			new BN('5025000000'),
			new BN('11463800'),
			new BN('40000000'),
			new BN('4975000000')
		);
		console.log(numer1.toString(), '/', denom1.toString());

		assert(numer1.eq(new BN(5542348054)));
		assert(denom1.eq(new BN(4407403195)));
		assert(numer1.gt(denom1));

		// net pos so small that decreasing k for .01 is sending to zero (squeezing a stone)
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('50000000004975000000'),
			new BN('49999999995025000000'),
			new BN('-10000'),
			new BN('40000000'),
			new BN('-4975000000')
		);
		console.log(numer1.toString(), '/', denom1.toString());

		assert(numer1.eq(new BN('49498762495074625625')));
		assert(denom1.eq(new BN('25000049503737495074625625')));

		// impossible task trying to spend more than amount to make k infinity
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('50000000004975000000'),
			new BN('49999999995025000000'),
			new BN('10000'),
			new BN('40000000'),
			new BN('-4975000000')
		);
		console.log(numer1.toString(), '/', denom1.toString());

		assert(numer1.eq(new BN(10000))); // max k
		assert(denom1.eq(new BN(1))); // max k
	});
});
