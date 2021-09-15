import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey } from '@solana/web3.js';

import { ClearingHouse, Network, PositionDirection} from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mintToInsuranceFund,
} from '../utils/mockAccounts';

describe('clearing_house', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 10);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 10);

	// ammInvariant == k == x * y
	const _ammInvariant = ammInitialQuoteAssetAmount.mul(
		ammInitialBaseAssetAmount
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = new ClearingHouse(
			connection,
			Network.LOCAL,
			provider.wallet,
			chProgram.programId
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Initialize State', async () => {
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		const state = clearingHouse.getState();

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [expectedCollateralAccountAuthority, expectedCollateralAccountNonce] =
			await anchor.web3.PublicKey.findProgramAddress(
				[state.collateralAccount.toBuffer()],
				clearingHouse.program.programId
			);

		assert.ok(
			state.collateralAccountAuthority.equals(
				expectedCollateralAccountAuthority
			)
		);
		assert.ok(state.collateralAccountNonce == expectedCollateralAccountNonce);

		const [expectedInsuranceAccountAuthority, expectedInsuranceAccountNonce] =
			await anchor.web3.PublicKey.findProgramAddress(
				[state.insuranceAccount.toBuffer()],
				clearingHouse.program.programId
			);
		assert.ok(
			state.insuranceAccountAuthority.equals(expectedInsuranceAccountAuthority)
		);
		assert.ok(state.insuranceAccountNonce == expectedInsuranceAccountNonce);

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
		assert.ok(marketData.quoteAssetNotionalAmount.eq(new BN(0)));
		assert.ok(marketData.openInterest.eq(new BN(0)));
		assert.ok(marketData.baseAssetVolume.eq(new BN(0)));
		assert.ok(marketData.pegQuoteAssetVolume.eq(new BN(0)));
		assert.ok(marketData.arbVolume.eq(new BN(0)));

		const ammData = marketData.amm;
		assert.ok(ammData.oracle.equals(solUsd.publicKey));
		assert.ok(ammData.baseAssetAmount.eq(ammInitialBaseAssetAmount));
		assert.ok(ammData.quoteAssetAmount.eq(ammInitialQuoteAssetAmount));
		assert.ok(ammData.cumFundingRate.eq(new BN(0)));
		assert.ok(ammData.periodicity.eq(periodicity));
		assert.ok(ammData.fundingRate.eq(new BN(0)));
		assert.ok(!ammData.fundingRateTs.eq(new BN(0)));
		// assert.ok(ammData.markTwap.eq(new BN(0))); //todo
		// assert.ok(ammData.markTwapTs.eq(new BN(0)));
		assert.ok(ammData.spreadThreshold.eq(new BN(100000)));
		assert.ok(ammData.volume1.eq(new BN(0)));
		assert.ok(ammData.volume2.eq(new BN(0)));
	});

	it('Initialize user account and deposit collateral atomically', async () => {
		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
		assert.ok(user.collateral.eq(usdcAmount));

		// Check that clearing house collateral account has proper collateral
		const clearingHouseState: any = clearingHouse.getState();
		const clearingHouseCollateralAccount = await getTokenAccount(
			provider,
			clearingHouseState.collateralAccount
		);
		assert.ok(clearingHouseCollateralAccount.amount.eq(usdcAmount));

		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositionsAccount.fetch(
				user.positions
			);

		assert.ok(userPositionsAccount.positions.length == 10);
		assert.ok(userPositionsAccount.userAccount.equals(userAccountPublicKey));
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.toNumber() === 0
		);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetNotionalAmount.toNumber() ===
				0
		);
		assert.ok(
			userPositionsAccount.positions[0].lastCumFunding.toNumber() === 0
		);
	});

	it('Withdraw Collateral', async () => {
		await clearingHouse.withdrawCollateral(
			userAccountPublicKey,
			usdcAmount,
			userUSDCAccount.publicKey
		);

		// Check that user account has proper collateral
		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);
		assert.ok(user.collateral.eq(new BN(0)));

		// Check that clearing house collateral account has proper collateral]
		const clearingHouseState: any = clearingHouse.getState();
		const clearingHouseCollateralAccount = await getTokenAccount(
			provider,
			clearingHouseState.collateralAccount
		);
		assert.ok(clearingHouseCollateralAccount.amount.eq(new BN(0)));

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

		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(usdcAmount));

		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositionsAccount.fetch(
				user.positions
			);

		assert.ok(
			userPositionsAccount.positions[0].quoteAssetNotionalAmount.eq(
				new BN(50000000)
			)
		);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(49950050))
		);

		const marketsAccount = clearingHouse.getMarketsAccount();

		const market = marketsAccount.markets[0];
		assert.ok(market.quoteAssetNotionalAmount.eq(new BN(50000000)));
		assert.ok(market.baseAssetAmount.eq(new BN(49950050)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 1);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].userClearingHousePublicKey.equals(
				userAccountPublicKey
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[0].recordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[0].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].baseAssetAmount.eq(new BN(49950050))
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].quoteAssetNotionalAmount.eq(
				new BN(50000000)
			)
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
			const estTradePrice =
				clearingHouse.calculateBaseAssetPriceAfterSwapWithMantissa(
					marketIndex,
					PositionDirection.SHORT,
					newUSDCNotionalAmount
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
		const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.SHORT,
			newUSDCNotionalAmount,
			new BN(0)
		);

		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositionsAccount.fetch(
				user.positions
			);

		assert.ok(
			userPositionsAccount.positions[0].quoteAssetNotionalAmount.eq(
				new BN(25000000)
			)
		);

		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(24987507))
		);
		assert.ok(user.collateral.eq(usdcAmount));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.quoteAssetNotionalAmount.eq(new BN(25000000)));
		assert.ok(market.baseAssetAmount.eq(new BN(24987507)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 2);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].userClearingHousePublicKey.equals(
				userAccountPublicKey
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].recordId.eq(new BN(2)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[1].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].baseAssetAmount.eq(new BN(24962543))
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].quoteAssetNotionalAmount.eq(
				new BN(25000000)
			)
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

		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositionsAccount.fetch(
				user.positions
			);

		assert.ok(user.collateral.eq(usdcAmount));
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetNotionalAmount.eq(
				new BN(25000000)
			)
		);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(-25012506))
		);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.quoteAssetNotionalAmount.eq(new BN(25000000)));
		assert.ok(market.baseAssetAmount.eq(new BN(-25012506)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 3);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].userClearingHousePublicKey.equals(
				userAccountPublicKey
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].recordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[2].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].baseAssetAmount.eq(new BN(50000013))
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].quoteAssetNotionalAmount.eq(
				new BN(50000000)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].marketIndex.eq(new BN(0)));
	});

	it('Close position', async () => {
		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositionsAccount.fetch(
				user.positions
			);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetNotionalAmount.eq(new BN(0))
		);
		assert.ok(userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(0)));
		assert.ok(user.collateral.eq(new BN(10000000)));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.quoteAssetNotionalAmount.eq(new BN(0)));
		assert.ok(market.baseAssetAmount.eq(new BN(0)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 4);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].userClearingHousePublicKey.equals(
				userAccountPublicKey
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[3].recordId.eq(new BN(4)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[3].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].baseAssetAmount.eq(new BN(25012506))
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].quoteAssetNotionalAmount.eq(
				new BN(25000000)
			)
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

		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositionsAccount.fetch(
				user.positions
			);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetNotionalAmount.eq(
				new BN(50000000)
			)
		);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(-50050050))
		);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.quoteAssetNotionalAmount.eq(new BN(50000000)));
		assert.ok(market.baseAssetAmount.eq(new BN(-50050050)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 5);
		assert.ok(
			tradeHistoryAccount.tradeRecords[4].userClearingHousePublicKey.equals(
				userAccountPublicKey
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[4].recordId.eq(new BN(5)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[4].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[4].baseAssetAmount.eq(new BN(50050050))
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[4].quoteAssetNotionalAmount.eq(
				new BN(50000000)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[4].marketIndex.eq(new BN(0)));
	});

	it('Liquidation', async () => {
		await clearingHouse.moveAmmPrice(
			ammInitialBaseAssetAmount.mul(new BN(6)),
			ammInitialQuoteAssetAmount.mul(new BN(7)),
			new BN(0)
		);

		// having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
		await clearingHouse.liquidate(
			userUSDCAccount.publicKey,
			userAccountPublicKey
		);
		const state: any = clearingHouse.getState();
		const user: any = await clearingHouse.program.account.userAccount.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositionsAccount.fetch(
				user.positions
			);

		assert.ok(userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(0)));
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetNotionalAmount.eq(new BN(0))
		);
		assert.ok(user.collateral.eq(new BN(0)));
		assert.ok(userPositionsAccount.positions[0].lastCumFunding.eq(new BN(0)));

		const chInsuranceAccountToken = await getTokenAccount(
			provider,
			state.insuranceAccount
		);
		const userUSDCTokenAccount = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);

		assert.ok(chInsuranceAccountToken.amount.eq(new BN(1518606)));
		assert.ok(userUSDCTokenAccount.amount.eq(new BN(79926)));
	});

	it('Pay from insurance fund', async () => {
		const state: any = clearingHouse.getState();
		mintToInsuranceFund(state.insuranceAccount, usdcMint, usdcAmount, provider);
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
			ammInitialBaseAssetAmount.mul(new BN(1)),
			ammInitialQuoteAssetAmount.mul(new BN(1000)),
			new BN(0)
		);

		await clearingHouse.closePosition(userAccountPublicKey, new BN(0));

		const user: any = await clearingHouse.program.account.userAccount.fetch(
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
			state.collateralAccount
		);
		assert(chCollateralAccountToken.amount.eq(new BN(0)));

		const chInsuranceAccountToken = await getTokenAccount(
			provider,
			state.insuranceAccount
		);
		assert(chInsuranceAccountToken.amount.eq(new BN(0)));
	});
});
