import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey } from '@solana/web3.js';

import {
	AMM_MANTISSA,
	ClearingHouse,
	UserAccount,
	PositionDirection,
} from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mintToInsuranceFund,
} from '../utils/mockAccounts';
import {
	BASE_ASSET_PRECISION,
	stripMantissa,
	USDC_PRECISION,
} from '../sdk/lib';

describe('clearing_house', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let userAccountPublicKey: PublicKey;
	let userAccount: UserAccount;

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

		clearingHouse = new ClearingHouse(
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
		assert.ok(marketsAccount.markets.length == 1000);

		const fundingRateHistory = clearingHouse.getFundingRateHistory();
		assert.ok(fundingRateHistory.head.toNumber() === 0);
		assert.ok(fundingRateHistory.fundingRateRecords.length === 1000);

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		assert.ok(tradeHistoryAccount.head.toNumber() === 0);
		assert.ok(tradeHistoryAccount.tradeRecords.length === 1000);
	});

	it('Initialize Market', async () => {
		const solUsd = anchor.web3.Keypair.generate();
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd.publicKey,
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
		assert.ok(ammData.oracle.equals(solUsd.publicKey));
		assert.ok(ammData.baseAssetReserve.eq(ammInitialBaseAssetAmount));
		assert.ok(ammData.quoteAssetReserve.eq(ammInitialQuoteAssetAmount));
		assert.ok(ammData.cumulativeFundingRate.eq(new BN(0)));
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

		// Check that clearing house collateral account has proper collateral
		const clearingHouseState: any = clearingHouse.getState();
		const clearingHouseCollateralVault = await getTokenAccount(
			provider,
			clearingHouseState.collateralVault
		);
		assert.ok(clearingHouseCollateralVault.amount.eq(usdcAmount));

		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(userPositionsAccount.positions.length == 10);
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
	});

	it('Long from 0 position', async () => {
		// Re-Deposit USDC, assuming we have 0 balance here
		await clearingHouse.depositCollateral(
			userAccountPublicKey,
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const incrementalUSDCNotionalAmount = usdcAmount.mul(new BN(5));
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			incrementalUSDCNotionalAmount,
			marketIndex
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		assert(user.collateral.eq(new BN(9997500)));
		assert(user.totalFeePaid.eq(new BN(2500)));

		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(50000000))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(499950004999501)
			)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();

		const market = marketsAccount.markets[0];
		console.log(market.baseAssetAmount.toNumber());

		assert.ok(market.baseAssetAmount.eq(new BN(499950004999501)));
		assert.ok(market.amm.cumulativeFee.eq(new BN(2500)));
		assert.ok(market.amm.cumulativeFeeRealized.eq(new BN(2500)));

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
				new BN(499950004999501)
			)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].quoteAssetAmount.eq(new BN(50000000))
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

	it('Reduce long position', async () => {
		const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
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
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(25000000))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount.toNumber());
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(249987500624969)
			)
		);
		assert.ok(user.collateral.eq(new BN(9996250)));
		assert(user.totalFeePaid.eq(new BN(3750)));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(249987500624969)));
		assert.ok(market.amm.cumulativeFee.eq(new BN(3750)));
		assert.ok(market.amm.cumulativeFeeRealized.eq(new BN(3750)));

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
				new BN(249962504374532)
			)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].quoteAssetAmount.eq(new BN(25000000))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].marketIndex.eq(new BN(0)));
	});

	it('Reverse long position', async () => {
		const newUSDCNotionalAmount = usdcAmount.mul(new BN(5));
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

		assert.ok(user.collateral.eq(new BN(9993750)));
		assert(user.totalFeePaid.eq(new BN(6250)));
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(25000000))
		);
		// console.log(userPositionsAccount.positions[0].baseAssetAmount.toNumber());
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(-250012500625031)
			)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(-250012500625031)));
		assert.ok(market.amm.cumulativeFee.eq(new BN(6250)));
		assert.ok(market.amm.cumulativeFeeRealized.eq(new BN(6250)));

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
				new BN(500000001250000)
			)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].quoteAssetAmount.eq(new BN(50000000))
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
		assert.ok(user.collateral.eq(new BN(9992500)));
		assert(user.totalFeePaid.eq(new BN(7500)));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.cumulativeFee.eq(new BN(7500)));
		assert.ok(market.amm.cumulativeFeeRealized.eq(new BN(7500)));

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
				new BN(250012500625031)
			)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].quoteAssetAmount.eq(new BN(25000000))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[3].marketIndex.eq(new BN(0)));
	});

	it('Open short position', async () => {
		const incrementalUSDCNotionalAmount = usdcAmount.mul(new BN(5));
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.SHORT,
			incrementalUSDCNotionalAmount,
			new BN(0)
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(50000000))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount.toNumber());
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(-500050005000500)
			)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(-500050005000500)));

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
				new BN(500050005000500)
			)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[4].quoteAssetAmount.eq(new BN(50000000))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[4].marketIndex.eq(new BN(0)));
	});

	it('Partial Liquidation', async () => {
		const marketIndex = new BN(0);

		userAccount = new UserAccount(clearingHouse, provider.wallet.publicKey);
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

		await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);
		console.log('margin ratio', userAccount.getMarginRatio().toString());

		console.log(
			'collateral + pnl post px move:',
			stripMantissa(userAccount.getTotalCollateral(), USDC_PRECISION)
		);

		// having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
		await clearingHouse.liquidate(
			userUSDCAccount.publicKey,
			userAccountPublicKey
		);

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
		const userUSDCTokenAccount = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);
		console.log(chInsuranceAccountToken.amount.toNumber());
		console.log(userUSDCTokenAccount.amount.toNumber());

		assert.ok(chInsuranceAccountToken.amount.eq(new BN(39058)));
		assert.ok(userUSDCTokenAccount.amount.eq(new BN(39057)));
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

		await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);

		// having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
		await clearingHouse.liquidate(
			userUSDCAccount.publicKey,
			userAccountPublicKey
		);
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
		const userUSDCTokenAccount = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);
		console.log(chInsuranceAccountToken.amount.toNumber());
		console.log(userUSDCTokenAccount.amount.toNumber());

		assert.ok(chInsuranceAccountToken.amount.eq(new BN(2066151)));
		assert.ok(userUSDCTokenAccount.amount.eq(new BN(145746)));
	});

	it('Pay from insurance fund', async () => {
		const state: any = clearingHouse.getState();
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

		const newUSDCNotionalAmount = initialUserUSDCAmount.mul(new BN(5));
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			newUSDCNotionalAmount,
			new BN(0)
		);

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
	});

	it('Trade small size position', async () => {
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			new BN(10000),
			new BN(0)
		);
	});
});
