import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { Connection, Keypair } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';
import {
	BN,
	Admin,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	ClearingHouseUser,
	PEG_PRECISION,
	PositionDirection,
	convertToNumber,
	AMM_RESERVE_PRECISION,
	// Wallet,
	// calculateTradeSlippage,
	getLimitOrderParams,
	// getTriggerMarketOrderParams,
	findComputeUnitConsumption,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	getFeedData,
} from './testHelpers';

const ZERO = new BN(0);

export const matchEnum = (enum1: any, enum2) => {
	return JSON.stringify(enum1) === JSON.stringify(enum2);
};
async function formRepegHelper(
	connection: Connection,
	clearingHouse: Admin,
	userAccount: ClearingHouseUser,
	marketIndex: BN,
	oraclePrice: number,
	amt: number,
	direction: PositionDirection
) {
	const markets = await clearingHouse.getMarketsAccount();
	const market = markets.markets[marketIndex.toNumber()];
	const amm = market.amm;
	await setFeedPrice(anchor.workspace.Pyth, oraclePrice, amm.oracle);
	const oraclePx = await getFeedData(anchor.workspace.Pyth, amm.oracle);

	// const direction = PositionDirection.LONG;
	const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.toNumber() * amt);
	let price = new BN(calculateMarkPrice(market).toNumber() * 1.02);
	if (matchEnum(direction, PositionDirection.SHORT)) {
		price = new BN(calculateMarkPrice(market).toNumber() * 0.988);
	}

	const prePosition = userAccount.getUserPosition(marketIndex);
	// console.log(prePosition);
	// assert(prePosition == undefined); // no existing position

	// const fillerUserAccount0 = userAccount.getUserAccount();

	const orderParams = getLimitOrderParams(
		marketIndex,
		direction,
		baseAssetAmount,
		price,
		false,
		false
	);
	const txSig = await clearingHouse.placeAndFillOrder(
		orderParams
		// discountTokenAccount.address
	);

	await clearingHouse.fetchAccounts();
	await userAccount.fetchAccounts();

	const postPosition = userAccount.getUserPosition(marketIndex);

	console.log(
		'User position: ',
		convertToNumber(
			prePosition?.baseAssetAmount ?? ZERO,
			AMM_RESERVE_PRECISION
		),
		'->',
		convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
	);

	// assert(postPosition.baseAssetAmount.abs().gt(new BN(0)));
	// assert(postPosition.baseAssetAmount.eq(baseAssetAmount)); // 100% filled

	const marketsAfter = await clearingHouse.getMarketsAccount();
	const marketAfter = marketsAfter.markets[marketIndex.toNumber()];
	const ammAfter = marketAfter.amm;

	// const newPeg = calculateBudgetedPeg(marketAfter, new BN(15000000));
	console.log(
		'Expected Peg Change:',
		market.amm.pegMultiplier.toNumber(),
		'->',
		marketAfter.amm.pegMultiplier.toNumber()
		// ' vs ->',
		// newPeg.toNumber()
	);

	console.log(
		'Oracle:',
		oraclePx.price,
		'Mark:',
		convertToNumber(calculateMarkPrice(market)),
		'->',
		convertToNumber(calculateMarkPrice(marketAfter))
	);

	const netRevenue = convertToNumber(
		ammAfter.totalFeeMinusDistributions.sub(amm.totalFeeMinusDistributions),
		QUOTE_PRECISION
	);

	console.log(
		'Peg:',
		convertToNumber(amm.pegMultiplier, PEG_PRECISION),
		'->',
		convertToNumber(ammAfter.pegMultiplier, PEG_PRECISION),
		'(net rev=',
		netRevenue,
		' | ',
		convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION),
		'->',
		convertToNumber(ammAfter.totalFeeMinusDistributions, QUOTE_PRECISION),

		')'
	);

	try {
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig
		);

		console.log('placeAndFill compute units', computeUnits[0]);
	} catch (e) {
		console.log('err calc in compute units');
	}

	return netRevenue;
}

describe('formulaic curve (repeg)', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	const initialSOLPrice = 150;

	const marketIndex = new BN(12); // for soft launch

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
	let solUsdOracle;
	let dogUsdOracle;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const periodicity = new BN(0); // 1 HOUR

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});

		dogUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: 0.11,
		});

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsdOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(initialSOLPrice * PEG_PRECISION.toNumber())
		);

		await clearingHouse.initializeMarket(
			marketIndex.add(new BN(1)),
			dogUsdOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(110)
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

	it('track netRevenueSinceLastFunding', async () => {
		await clearingHouse.depositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const targetPriceBack = new BN(
			initialSOLPrice * MARK_PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);
		await clearingHouse.updateFundingPaused(true);

		let count = 0;
		while (count <= 2) {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				new BN(100000).mul(QUOTE_PRECISION),
				marketIndex
			);
			await clearingHouse.closePosition(marketIndex);
			count += 1;
		}

		const markets = await clearingHouse.getMarketsAccount();

		const amm = markets.markets[marketIndex.toNumber()].amm;
		console.log(
			'realizedFeePostClose',
			convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION),
			'netRevenue',
			convertToNumber(amm.netRevenueSinceLastFunding, QUOTE_PRECISION)
		);

		assert(amm.netRevenueSinceLastFunding.eq(amm.totalFeeMinusDistributions));
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);
	});
	it('update funding/price (netRevenueSinceLastFunding)', async () => {
		await clearingHouse.updateFundingPaused(false);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const _tx = await clearingHouse.updateFundingRate(
			solUsdOracle,
			marketIndex
		);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second
		await clearingHouse.updateFundingPaused(true);

		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[marketIndex.toNumber()];
		const amm = market.amm;

		await setFeedPrice(anchor.workspace.Pyth, 155, amm.oracle);

		const oraclePx = await getFeedData(anchor.workspace.Pyth, amm.oracle);

		console.log(
			'markPrice:',
			convertToNumber(calculateMarkPrice(market)),
			'oraclePrice:',
			oraclePx.price
		);
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION),
			'fundingPnL:',
			convertToNumber(userAccount.getUnrealizedFundingPNL(), QUOTE_PRECISION)
		);
		console.log(
			'fundingRate:',
			convertToNumber(amm.lastFundingRate, MARK_PRICE_PRECISION)
		);
		console.log(
			'realizedFeePostClose',
			convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION),
			'netRevenue',
			convertToNumber(amm.netRevenueSinceLastFunding, QUOTE_PRECISION)
		);
	});

	it('cause repeg? oracle > mark', async () => {
		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			155,
			1,
			PositionDirection.LONG
		);
	});
	it('cause repeg? oracle > mark close', async () => {
		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			155,
			1,
			PositionDirection.SHORT
		);
	});
	it('cause repeg? oracle < mark open/close', async () => {
		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			149,
			1,
			PositionDirection.SHORT
		);
		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			149,
			1,
			PositionDirection.LONG
		);
	});

	it('cause repeg? PROFIT. oracle < mark open/close', async () => {
		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			149,
			2,
			PositionDirection.SHORT
		);

		const newOracle = 151;
		const base = 1;

		const profit = await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			newOracle,
			base,
			PositionDirection.LONG
		);

		// net revenue above fee collected
		const feeCollected = newOracle * base * 0.001;
		assert(profit > feeCollected);

		const netRev2 = await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			newOracle,
			base,
			PositionDirection.LONG
		);

		assert(netRev2 > 0);
	});

	it('cause repeg? ignore invalid oracle', async () => {
		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[marketIndex.toNumber()];
		const amm = market.amm;
		await setFeedPrice(anchor.workspace.Pyth, 0.14, amm.oracle);
		try {
			await clearingHouse.repegAmmCurve(new BN(200), marketIndex);
			assert(false);
		} catch (e) {
			console.log('oracle invalid');
		}

		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			0.14,
			2,
			PositionDirection.SHORT
		);

		const newOracle = 0.16;
		const base = 2;

		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			marketIndex,
			newOracle,
			base,
			PositionDirection.LONG
		);
	});

	it('cause repeg? tiny prices', async () => {
		const dogIndex = marketIndex.add(new BN(1));
		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[dogIndex.toNumber()];
		const amm = market.amm;
		await setFeedPrice(anchor.workspace.Pyth, 0.14, amm.oracle);

		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			dogIndex,
			0.111,
			100,
			PositionDirection.SHORT
		);

		const newOracle = 0.1699;
		const base = 100;

		await formRepegHelper(
			connection,
			clearingHouse,
			userAccount,
			dogIndex,
			newOracle,
			base,
			PositionDirection.LONG
		);
	});
});
