import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	AMM_RESERVE_PRECISION,
	BASE_PRECISION,
	BN,
	calculateTradeSlippage,
	QUOTE_ASSET_BANK_INDEX,
} from '../sdk';

import { Keypair } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';
import {
	Admin,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	ClearingHouseUser,
	PEG_PRECISION,
	PositionDirection,
	convertToNumber,
	squareRootBN,
	calculateBudgetedKBN,
} from '../sdk/src';

import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteAssetBank,
} from './testHelpers';
import { QUOTE_PRECISION } from '../sdk/lib';

const ZERO = new BN(0);

describe('update k', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	const initialSOLPrice = 150;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const usdcAmount = new BN(1e9 * 10 ** 6);

	let userAccount: ClearingHouseUser;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateOrderAuctionTime(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		const solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});

		await clearingHouse.initializeMarket(
			solUsdOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(initialSOLPrice * PEG_PRECISION.toNumber())
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

	it('increase k (FREE)', async () => {
		const marketIndex = new BN(0);

		const oldKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);
		const ammOld = clearingHouse.getMarketAccount(0).amm;
		const newSqrtK = ammInitialBaseAssetReserve.mul(new BN(10));
		await clearingHouse.updateK(newSqrtK, marketIndex);

		await clearingHouse.fetchAccounts();
		const newKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);

		const amm = clearingHouse.getMarketAccount(0).amm;

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
		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_ASSET_BANK_INDEX,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);

		const targetPriceUp = new BN(
			initialSOLPrice * MARK_PRICE_PRECISION.toNumber() * 44.1
		);
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceUp);
		await clearingHouse.fetchAccounts();

		const marketOld = clearingHouse.getMarketAccount(0);

		const oldKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);
		const ammOld = marketOld.amm;

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(1.000132325235 * MARK_PRICE_PRECISION.toNumber()))
			.div(MARK_PRICE_PRECISION);

		await clearingHouse.updateK(newSqrtK, marketIndex);
		// console.log(
		// 	'tx logs',
		// 	(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
		// 		.logMessages
		// );

		await clearingHouse.fetchAccounts();
		const newKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);

		const amm = clearingHouse.getMarketAccount(0).amm;

		const marginOfError = new BN(MARK_PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

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
		const marketIndex = new BN(0);

		const targetPriceBack = new BN(
			initialSOLPrice * MARK_PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.div(new BN(initialSOLPrice)),
			marketIndex
		);
		console.log('$1 position taken');
		await clearingHouse.fetchAccounts();
		const marketOld = clearingHouse.getMarketAccount(0);
		assert(!marketOld.amm.netBaseAssetAmount.eq(ZERO));

		const oldKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);
		const ammOld = marketOld.amm;
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(0.5 * MARK_PRICE_PRECISION.toNumber()))
			.div(MARK_PRICE_PRECISION);

		try {
			await clearingHouse.updateK(newSqrtK, marketIndex);
			assert(false);
		} catch {
			await clearingHouse.fetchAccounts();
			const marketKChange = await clearingHouse.getMarketAccount(0);
			const ammKChange = marketKChange.amm;

			const newKPrice = calculateMarkPrice(
				clearingHouse.getMarketAccount(marketIndex)
			);

			console.log('$1 position closing');

			await clearingHouse.closePosition(marketIndex);
			console.log('$1 position closed');

			const amm = clearingHouse.getMarketAccount(0).amm;

			const marginOfError = new BN(MARK_PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

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

			// assert(amm.totalFeeMinusDistributions.lt(ammOld.totalFeeMinusDistributions));
		}
	});
	it('lower k (2%) position imbalance (AMM PROFIT)', async () => {
		const marketIndex = new BN(0);

		const targetPriceBack = new BN(
			initialSOLPrice * MARK_PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.div(new BN(initialSOLPrice)),
			marketIndex
		);
		console.log('$1 position taken');
		await clearingHouse.fetchAccounts();
		const marketOld = await clearingHouse.getMarketAccount(0);
		assert(!marketOld.amm.netBaseAssetAmount.eq(ZERO));

		const oldKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);
		const ammOld = marketOld.amm;
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(0.98 * MARK_PRICE_PRECISION.toNumber()))
			.div(MARK_PRICE_PRECISION);
		const smallTradeSlipOld = calculateTradeSlippage(
			PositionDirection.LONG,
			QUOTE_PRECISION,
			marketOld
		)[0];

		await clearingHouse.updateK(newSqrtK, marketIndex);

		await clearingHouse.fetchAccounts();
		const marketKChange = await clearingHouse.getMarketAccount(0);
		const ammKChange = marketKChange.amm;

		const newKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
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

		await clearingHouse.closePosition(marketIndex);
		console.log('$1 position closed');

		const amm = clearingHouse.getMarketAccount(0).amm;

		const marginOfError = new BN(MARK_PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

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

		// assert(amm.totalFeeMinusDistributions.lt(ammOld.totalFeeMinusDistributions));
	});
	it('increase k position imbalance (AMM LOSS)', async () => {
		const marketIndex = new BN(0);
		const targetPriceBack = new BN(
			initialSOLPrice * MARK_PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(QUOTE_PRECISION).mul(new BN(30000)),
			marketIndex
		);
		console.log('$1 position taken');
		await clearingHouse.fetchAccounts();
		const marketOld = await clearingHouse.getMarketAccount(0);
		assert(!marketOld.amm.netBaseAssetAmount.eq(ZERO));

		const oldKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
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
			.mul(new BN(1.02 * MARK_PRICE_PRECISION.toNumber()))
			.div(MARK_PRICE_PRECISION);
		await clearingHouse.updateK(newSqrtK, marketIndex);

		await clearingHouse.fetchAccounts();
		const marketKChange = await clearingHouse.getMarketAccount(0);
		const ammKChange = marketKChange.amm;
		const newKPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
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

		await clearingHouse.closePosition(marketIndex);
		console.log('$1 position closed');

		await clearingHouse.fetchAccounts();
		const markets = clearingHouse.getMarketAccount(0);
		const amm = markets.amm;

		const marginOfError = new BN(MARK_PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

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
		// pay $.11 to increase k
		let [numer1, denom1] = calculateBudgetedKBN(
			new BN('49750000004950'), // x
			new BN('50250000000000'), // y
			new BN('114638'), // cost
			new BN('40000'), // peg
			new BN('49750000004950') // net position
		);
		console.log(numer1.toString(), '/', denom1.toString());

		assert(numer1.eq(new BN(4980550350)));
		assert(denom1.eq(new BN(4969200901)));

		// gain $.11 by decreasing k
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('49750000004950'), // x
			new BN('50250000000000'), // y
			new BN('-114638'), // cost
			new BN('40000'), // peg
			new BN('49750000004950') // net position
		);
		console.log(numer1.toString(), '/', denom1.toString());
		assert(numer1.eq(new BN(4969200901)));
		assert(denom1.eq(new BN(4980550350)));
		assert(numer1.lt(denom1));

		// pay $11 to increase k
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('49750000004950'),
			new BN('50250000000000'),
			new BN('11463800'),
			new BN('40000'),
			new BN('49750000004950')
		);
		console.log(numer1.toString(), '/', denom1.toString());

		assert(numer1.eq(new BN(5542348055)));
		assert(denom1.eq(new BN(4407403196)));
		assert(numer1.gt(denom1));

		// net pos so small that decreasing k for .01 is sending to zero (squeezing a stone)
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('500000000049750000004950'),
			new BN('499999999950250000000000'),
			new BN('-10000'),
			new BN('40000'),
			new BN('-49750000004950')
		);
		console.log(numer1.toString(), '/', denom1.toString());

		assert(numer1.eq(new BN('49498762504924880624')));
		assert(denom1.eq(new BN('25000049503737504925373124')));

		// impossible task trying to spend more than amount to make k infinity
		[numer1, denom1] = calculateBudgetedKBN(
			new BN('500000000049750000004950'),
			new BN('499999999950250000000000'),
			new BN('10000'),
			new BN('40000'),
			new BN('-49750000004950')
		);
		console.log(numer1.toString(), '/', denom1.toString());

		assert(denom1.lt(new BN(0))); // throws negative
	});
});
