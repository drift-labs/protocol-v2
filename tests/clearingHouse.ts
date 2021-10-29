import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey } from '@solana/web3.js';

import {
	AMM_MANTISSA,
	ClearingHouse,
	ClearingHouseUser,
	PositionDirection,
	BASE_ASSET_PRECISION,
	stripMantissa,
	USDC_PRECISION,
	MAX_LEVERAGE,
} from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mintToInsuranceFund,
	mockOracle,
	setFeedPrice,
} from './testHelpers';

const calculateTradeAmount = (amountOfCollateral: BN) => {
	const ONE_MANTISSA = new BN(100000);
	const fee = ONE_MANTISSA.div(new BN(1000));
	const tradeAmount = amountOfCollateral
		.mul(MAX_LEVERAGE)
		.mul(ONE_MANTISSA.sub(MAX_LEVERAGE.mul(fee)))
		.div(ONE_MANTISSA);
	return tradeAmount;
};

describe('clearing_house', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let userAccountPublicKey: PublicKey;
	let userAccount: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = ClearingHouse.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	it('Initialize State', async () => {
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		const state = clearingHouse.getState();

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [expectedCollateralAccountAuthority, expectedCollateralAccountNonce] =
			await anchor.web3.PublicKey.findProgramAddress(
				[state.collateralVault.toBuffer()],
				clearingHouse.program.programId
			);

		assert.ok(
			state.collateralVaultAuthority.equals(expectedCollateralAccountAuthority)
		);
		assert.ok(state.collateralVaultNonce == expectedCollateralAccountNonce);

		const [expectedInsuranceAccountAuthority, expectedInsuranceAccountNonce] =
			await anchor.web3.PublicKey.findProgramAddress(
				[state.insuranceVault.toBuffer()],
				clearingHouse.program.programId
			);
		assert.ok(
			state.insuranceVaultAuthority.equals(expectedInsuranceAccountAuthority)
		);
		assert.ok(state.insuranceVaultNonce == expectedInsuranceAccountNonce);

		const marketsAccount = clearingHouse.getMarketsAccount();
		assert.ok(marketsAccount.markets.length == 64);

		const fundingRateHistory = clearingHouse.getFundingPaymentHistory();
		assert.ok(fundingRateHistory.head.toNumber() === 0);
		assert.ok(fundingRateHistory.fundingPaymentRecords.length === 1024);

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		assert.ok(tradeHistoryAccount.head.toNumber() === 0);
		assert.ok(tradeHistoryAccount.tradeRecords.length === 1024);
	});

	it('Initialize Market', async () => {
		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		const marketsAccount: any = clearingHouse.getMarketsAccount();

		const marketData = marketsAccount.markets[0];
		assert.ok(marketData.initialized);
		assert.ok(marketData.baseAssetAmount.eq(new BN(0)));
		assert.ok(marketData.openInterest.eq(new BN(0)));

		const ammData = marketData.amm;
		assert.ok(ammData.oracle.equals(solUsd));
		assert.ok(ammData.baseAssetReserve.eq(ammInitialBaseAssetAmount));
		assert.ok(ammData.quoteAssetReserve.eq(ammInitialQuoteAssetAmount));
		assert.ok(ammData.cumulativeFundingRateLong.eq(new BN(0)));
		assert.ok(ammData.cumulativeFundingRateShort.eq(new BN(0)));
		assert.ok(ammData.fundingPeriod.eq(periodicity));
		assert.ok(ammData.lastFundingRate.eq(new BN(0)));
		assert.ok(!ammData.lastFundingRateTs.eq(new BN(0)));
	});

	it('Initialize user account and deposit collateral atomically', async () => {
		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
		assert.ok(user.collateral.eq(usdcAmount));
		assert.ok(user.cumulativeDeposits.eq(usdcAmount));

		// Check that clearing house collateral account has proper collateral
		const clearingHouseState: any = clearingHouse.getState();
		const clearingHouseCollateralVault = await getTokenAccount(
			provider,
			clearingHouseState.collateralVault
		);
		assert.ok(clearingHouseCollateralVault.amount.eq(usdcAmount));

		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(userPositionsAccount.positions.length == 5);
		assert.ok(userPositionsAccount.user.equals(userAccountPublicKey));
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.toNumber() === 0
		);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.toNumber() === 0
		);
		assert.ok(
			userPositionsAccount.positions[0].lastCumulativeFundingRate.toNumber() ===
				0
		);

		const depositHistory = clearingHouse.getDepositHistory();

		assert.ok(depositHistory.head.toNumber() === 1);
		assert.ok(depositHistory.depositRecords[0].recordId.eq(new BN(1)));
		assert.ok(
			depositHistory.depositRecords[0].userAuthority.equals(
				provider.wallet.publicKey
			)
		);
		assert.ok(
			depositHistory.depositRecords[0].user.equals(userAccountPublicKey)
		);

		assert.ok(
			JSON.stringify(depositHistory.depositRecords[0].direction) ===
				JSON.stringify({ deposit: {} })
		);
		assert.ok(depositHistory.depositRecords[0].amount.eq(new BN(10000000)));
		assert.ok(depositHistory.depositRecords[0].collateralBefore.eq(new BN(0)));
		assert.ok(
			depositHistory.depositRecords[0].cumulativeDepositsBefore.eq(new BN(0))
		);
	});

	it('Withdraw Collateral', async () => {
		await clearingHouse.withdrawCollateral(
			userAccountPublicKey,
			usdcAmount,
			userUSDCAccount.publicKey
		);

		// Check that user account has proper collateral
		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		assert.ok(user.collateral.eq(new BN(0)));
		assert.ok(user.cumulativeDeposits.eq(new BN(0)));
		// Check that clearing house collateral account has proper collateral]
		const clearingHouseState: any = clearingHouse.getState();
		const clearingHouseCollateralVault = await getTokenAccount(
			provider,
			clearingHouseState.collateralVault
		);
		assert.ok(clearingHouseCollateralVault.amount.eq(new BN(0)));

		const userUSDCtoken = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);
		assert.ok(userUSDCtoken.amount.eq(usdcAmount));

		const depositHistory = clearingHouse.getDepositHistory();

		const depositRecord = depositHistory.depositRecords[1];
		assert.ok(depositHistory.head.toNumber() === 2);
		assert.ok(depositRecord.recordId.eq(new BN(2)));
		assert.ok(depositRecord.userAuthority.equals(provider.wallet.publicKey));
		assert.ok(depositRecord.user.equals(userAccountPublicKey));

		assert.ok(
			JSON.stringify(depositRecord.direction) ===
				JSON.stringify({ withdraw: {} })
		);
		assert.ok(depositRecord.amount.eq(new BN(10000000)));
		assert.ok(depositRecord.collateralBefore.eq(new BN(10000000)));
		assert.ok(depositRecord.cumulativeDepositsBefore.eq(new BN(10000000)));
	});

	it('Long from 0 position', async () => {
		// Re-Deposit USDC, assuming we have 0 balance here
		await clearingHouse.depositCollateral(
			userAccountPublicKey,
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const incrementalUSDCNotionalAmount = calculateTradeAmount(usdcAmount);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			incrementalUSDCNotionalAmount,
			marketIndex
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9950250)));
		assert(user.totalFeePaid.eq(new BN(49750)));
		assert(user.cumulativeDeposits.eq(usdcAmount));

		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(49750000))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(497450503674885)
			)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();

		const market = marketsAccount.markets[0];
		console.log(market.baseAssetAmount.toNumber());

		assert.ok(market.baseAssetAmount.eq(new BN(497450503674885)));
		assert.ok(market.amm.totalFee.eq(new BN(49750)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(49750)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 1);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[0].recordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[0].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].baseAssetAmount.eq(
				new BN(497450503674885)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[0].liquidation == false);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].quoteAssetAmount.eq(new BN(49750000))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[0].marketIndex.eq(marketIndex));
	});

	it('Withdraw fails due to insufficient collateral', async () => {
		// lil hack to stop printing errors
		const oldConsoleLog = console.log;
		const oldConsoleError = console.error;
		console.log = function () {
			const _noop = '';
		};
		console.error = function () {
			const _noop = '';
		};
		try {
			await clearingHouse.withdrawCollateral(
				userAccountPublicKey,
				usdcAmount,
				userUSDCAccount.publicKey
			);
			assert(false, 'Withdrawal succeeded');
		} catch (e) {
			assert(true);
		} finally {
			console.log = oldConsoleLog;
			console.error = oldConsoleError;
		}
	});

	it('Order fails due to unrealiziable limit price ', async () => {
		// Should be a better a way to catch an exception with chai but wasn't working for me
		try {
			const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
			const marketIndex = new BN(0);
			const estTradePrice = clearingHouse.calculatePriceImpact(
				PositionDirection.SHORT,
				newUSDCNotionalAmount,
				marketIndex,
				'entryPrice'
			);

			// trying to sell at price too high
			const limitPriceTooHigh =
				clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);
			console.log(
				'failed order:',
				estTradePrice.toNumber(),
				limitPriceTooHigh.toNumber()
			);

			await clearingHouse.openPosition(
				userAccountPublicKey,
				PositionDirection.SHORT,
				newUSDCNotionalAmount,
				marketIndex,
				limitPriceTooHigh
			);
			assert(false, 'Order succeeded');
		} catch (e) {
			if (e.message == 'Order succeeded') {
				assert(false, 'Order succeeded');
			}
			assert(true);
		}
	});

	it('Reduce long position', async () => {
		const newUSDCNotionalAmount = calculateTradeAmount(
			usdcAmount.div(new BN(2))
		);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.SHORT,
			newUSDCNotionalAmount,
			new BN(0)
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(24876238))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount.toNumber());
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(248737625303141)
			)
		);
		console.log(user.collateral.toString());
		console.log(user.totalFeePaid.toString());
		assert.ok(user.collateral.eq(new BN(9926613)));
		assert(user.totalFeePaid.eq(new BN(74625)));
		assert(user.cumulativeDeposits.eq(usdcAmount));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(248737625303141)));
		assert.ok(market.amm.totalFee.eq(new BN(74625)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(74625)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 2);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].recordId.eq(new BN(2)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[1].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(tradeHistoryAccount.tradeRecords[1].baseAssetAmount.toNumber());
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].baseAssetAmount.eq(
				new BN(248712878371744)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].liquidation == false);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].quoteAssetAmount.eq(new BN(24875000))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].marketIndex.eq(new BN(0)));
	});

	it('Reverse long position', async () => {
		const newUSDCNotionalAmount = calculateTradeAmount(usdcAmount);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.SHORT,
			newUSDCNotionalAmount,
			new BN(0)
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(user.collateral.eq(new BN(9875624)));
		assert(user.totalFeePaid.eq(new BN(124375)));
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(24875001))
		);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(-248762385929198)
			)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(-248762385929198)));
		assert.ok(market.amm.totalFee.eq(new BN(124375)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(124375)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 3);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].recordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[2].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(tradeHistoryAccount.tradeRecords[2].baseAssetAmount.toNumber());
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].baseAssetAmount.eq(
				new BN(497500011232339)
			)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].quoteAssetAmount.eq(new BN(49750000))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].marketIndex.eq(new BN(0)));
	});

	it('Close position', async () => {
		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);
		assert.ok(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		assert.ok(userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(0)));
		assert.ok(user.collateral.eq(new BN(9850748)));
		assert(user.totalFeePaid.eq(new BN(149250)));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(149250)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(149250)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 4);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[3].recordId.eq(new BN(4)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[3].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].baseAssetAmount.eq(
				new BN(248762385929198)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].liquidation == false);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].quoteAssetAmount.eq(new BN(24875002))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[3].marketIndex.eq(new BN(0)));
	});

	it('Open short position', async () => {
		let user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const incrementalUSDCNotionalAmount = calculateTradeAmount(user.collateral);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.SHORT,
			incrementalUSDCNotionalAmount,
			new BN(0)
		);

		user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(49007471))
		);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(-490122749352851)
			)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(-490122749352851)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 5);
		assert.ok(
			tradeHistoryAccount.tradeRecords[4].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[4].recordId.eq(new BN(5)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[4].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[4].baseAssetAmount.eq(
				new BN(490122749352851)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[4].liquidation == false);
		assert.ok(
			tradeHistoryAccount.tradeRecords[4].quoteAssetAmount.eq(new BN(49007471))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[4].marketIndex.eq(new BN(0)));
	});

	it('Partial Liquidation', async () => {
		const marketIndex = new BN(0);

		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();

		const user0: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount0: any =
			await clearingHouse.program.account.userPositions.fetch(user0.positions);

		const liqPrice = userAccount.liquidationPrice(
			userPositionsAccount0.positions[0],
			new BN(0),
			true
		);

		console.log(
			'liqPrice move:',
			stripMantissa(
				clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex)
			),
			'->',
			stripMantissa(liqPrice),
			'on position',
			stripMantissa(
				userPositionsAccount0.positions[0].baseAssetAmount,
				BASE_ASSET_PRECISION
			),
			'with collateral:',
			stripMantissa(user0.collateral, USDC_PRECISION)
		);

		const marketsAccount: any = clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[0];
		await setFeedPrice(
			anchor.workspace.Pyth,
			stripMantissa(liqPrice),
			marketData.amm.oracle
		);

		await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);
		console.log('margin ratio', userAccount.getMarginRatio().toString());

		console.log(
			'collateral + pnl post px move:',
			stripMantissa(userAccount.getTotalCollateral(), USDC_PRECISION)
		);

		// having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
		await clearingHouse.liquidate(userAccountPublicKey);

		console.log(
			'collateral + pnl post liq:',
			stripMantissa(userAccount.getTotalCollateral(), USDC_PRECISION)
		);
		console.log('can be liquidated', userAccount.canBeLiquidated());
		console.log('margin ratio', userAccount.getMarginRatio().toString());

		const state: any = clearingHouse.getState();
		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount
				.abs()
				.lt(userPositionsAccount0.positions[0].baseAssetAmount.abs())
		);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount
				.abs()
				.lt(userPositionsAccount0.positions[0].quoteAssetAmount.abs())
		);
		assert.ok(user.collateral.lt(user0.collateral));

		const chInsuranceAccountToken = await getTokenAccount(
			provider,
			state.insuranceVault
		);
		console.log(chInsuranceAccountToken.amount.toNumber());

		assert.ok(chInsuranceAccountToken.amount.eq(new BN(38286)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 6);
		assert.ok(
			tradeHistoryAccount.tradeRecords[5].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[5].recordId.eq(new BN(6)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[5].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[5].baseAssetAmount.eq(
				new BN(122540290722645)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[5].liquidation);
		assert.ok(
			tradeHistoryAccount.tradeRecords[5].quoteAssetAmount.eq(new BN(13936590))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[5].marketIndex.eq(new BN(0)));

		const liquidationHistory = clearingHouse.getLiquidationHistory();
		assert.ok(liquidationHistory.head.toNumber() === 1);
		assert.ok(
			liquidationHistory.liquidationRecords[0].user.equals(userAccountPublicKey)
		);
		assert.ok(liquidationHistory.liquidationRecords[0].recordId.eq(new BN(1)));
		assert.ok(liquidationHistory.liquidationRecords[0].partial);

		assert.ok(
			liquidationHistory.liquidationRecords[0].baseAssetValue.eq(
				new BN(55746362)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].baseAssetValueClosed.eq(
				new BN(13936590)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].liquidationFee.eq(new BN(76571))
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].feeToLiquidator.eq(new BN(38285))
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].feeToInsuranceFund.eq(
				new BN(38286)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].liquidator.equals(
				userAccountPublicKey
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].totalCollateral.eq(
				new BN(3062850)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].collateral.eq(new BN(9801741))
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].unrealizedPnl.eq(
				new BN(-6738891)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[0].marginRatio.eq(new BN(549))
		);
	});

	it('Full Liquidation', async () => {
		const marketIndex = new BN(0);

		const user0: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount0: any =
			await clearingHouse.program.account.userPositions.fetch(user0.positions);

		const liqPrice = userAccount.liquidationPrice(
			userPositionsAccount0.positions[0],
			new BN(0),
			false
		);

		const marketsAccount: any = clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[0];
		await setFeedPrice(
			anchor.workspace.Pyth,
			stripMantissa(liqPrice),
			marketData.amm.oracle
		);

		await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);

		// having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
		await clearingHouse.liquidate(userAccountPublicKey);
		const state: any = clearingHouse.getState();
		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);
		console.log(
			stripMantissa(
				userPositionsAccount.positions[0].baseAssetAmount,
				BASE_ASSET_PRECISION
			)
		);
		assert.ok(userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(0)));
		assert.ok(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		assert.ok(user.collateral.eq(new BN(0)));
		assert.ok(
			userPositionsAccount.positions[0].lastCumulativeFundingRate.eq(new BN(0))
		);

		const chInsuranceAccountToken = await getTokenAccount(
			provider,
			state.insuranceVault
		);
		console.log(chInsuranceAccountToken.amount.toNumber());

		assert.ok(chInsuranceAccountToken.amount.eq(new BN(2025225)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 7);
		assert.ok(
			tradeHistoryAccount.tradeRecords[6].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[6].recordId.eq(new BN(7)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[6].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[6].baseAssetAmount.eq(
				new BN(367582458630206)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[6].liquidation);
		assert.ok(
			tradeHistoryAccount.tradeRecords[6].quoteAssetAmount.eq(new BN(42704537))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[6].marketIndex.eq(new BN(0)));

		const liquidationHistory = clearingHouse.getLiquidationHistory();
		assert.ok(liquidationHistory.head.toNumber() === 2);
		assert.ok(
			liquidationHistory.liquidationRecords[1].user.equals(userAccountPublicKey)
		);
		assert.ok(liquidationHistory.liquidationRecords[1].recordId.eq(new BN(2)));
		assert.ok(!liquidationHistory.liquidationRecords[1].partial);
		assert.ok(
			liquidationHistory.liquidationRecords[1].baseAssetValue.eq(
				new BN(42704537)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].baseAssetValueClosed.eq(
				new BN(42704537)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].liquidationFee.eq(
				new BN(2091514)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].feeToLiquidator.eq(
				new BN(104575)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].feeToInsuranceFund.eq(
				new BN(1986939)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].liquidator.equals(
				userAccountPublicKey
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].totalCollateral.eq(
				new BN(2091514)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].collateral.eq(new BN(8041407))
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].unrealizedPnl.eq(
				new BN(-5949893)
			)
		);
		assert.ok(
			liquidationHistory.liquidationRecords[1].marginRatio.eq(new BN(489))
		);
	});

	it('Pay from insurance fund', async () => {
		const state: any = clearingHouse.getState();
		const marketsAccount: any = clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[0];

		mintToInsuranceFund(state.insuranceVault, usdcMint, usdcAmount, provider);
		let userUSDCTokenAccount = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);
		console.log(userUSDCTokenAccount.amount);
		await mintToInsuranceFund(userUSDCAccount, usdcMint, usdcAmount, provider);

		userUSDCTokenAccount = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);

		console.log(userUSDCTokenAccount.amount);

		const initialUserUSDCAmount = userUSDCTokenAccount.amount;

		await clearingHouse.depositCollateral(
			userAccountPublicKey,
			initialUserUSDCAmount,
			userUSDCAccount.publicKey
		);

		await setFeedPrice(anchor.workspace.Pyth, 1.11, marketData.amm.oracle);
		const newUSDCNotionalAmount = calculateTradeAmount(initialUserUSDCAmount);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			newUSDCNotionalAmount,
			new BN(0)
		);

		await setFeedPrice(anchor.workspace.Pyth, 1000, marketData.amm.oracle);
		// Send the price to the moon so that user has huge pnl
		await clearingHouse.moveAmmPrice(
			ammInitialBaseAssetAmount.div(new BN(1000)),
			ammInitialQuoteAssetAmount,
			new BN(0)
		);

		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		assert(user.collateral.gt(initialUserUSDCAmount));

		await clearingHouse.withdrawCollateral(
			userAccountPublicKey,
			user.collateral,
			userUSDCAccount.publicKey
		);

		// To check that we paid from insurance fund, we check that user usdc is greater than start of test
		// and insurance and collateral funds have 0 balance
		userUSDCTokenAccount = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);
		assert(userUSDCTokenAccount.amount.gt(initialUserUSDCAmount));

		const chCollateralAccountToken = await getTokenAccount(
			provider,
			state.collateralVault
		);
		assert(chCollateralAccountToken.amount.eq(new BN(0)));

		const chInsuranceAccountToken = await getTokenAccount(
			provider,
			state.insuranceVault
		);
		assert(chInsuranceAccountToken.amount.eq(new BN(0)));

		await setFeedPrice(anchor.workspace.Pyth, 1, marketData.amm.oracle);
		await clearingHouse.moveAmmPrice(
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			new BN(0)
		);
	});

	it('Trade small size position', async () => {
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			new BN(10000),
			new BN(0)
		);
	});

	it('Short order succeeds due to realiziable limit price ', async () => {
		const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
		const marketIndex = new BN(0);
		const estTradePrice = clearingHouse.calculatePriceImpact(
			PositionDirection.SHORT,
			newUSDCNotionalAmount,
			marketIndex,
			'entryPrice'
		);

		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.SHORT,
			newUSDCNotionalAmount,
			marketIndex,
			estTradePrice
		);

		await clearingHouse.closePosition(userAccountPublicKey, marketIndex);
	});

	it('Long order succeeds due to realiziable limit price ', async () => {
		const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
		const marketIndex = new BN(0);
		const estTradePrice = clearingHouse.calculatePriceImpact(
			PositionDirection.LONG,
			newUSDCNotionalAmount,
			marketIndex,
			'entryPrice'
		);

		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			newUSDCNotionalAmount,
			marketIndex,
			estTradePrice
		);

		await clearingHouse.closePosition(userAccountPublicKey, marketIndex);
	});
});
