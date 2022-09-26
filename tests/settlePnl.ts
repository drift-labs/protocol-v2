import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, isVariant, MarketAccount, OracleSource, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey, TransactionSignature } from '@solana/web3.js';

import {
	Admin,
	PRICE_PRECISION,
	ClearingHouseUser,
	PositionDirection,
	MAX_LEVERAGE,
	getMarketPublicKey,
	EventSubscriber,
	QUOTE_SPOT_MARKET_INDEX,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	initializeQuoteSpotMarket,
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
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;
	let userAccount: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	let solUsd;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
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

		solUsd = await mockOracle(1);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0)],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
		});
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize State', async () => {
		await clearingHouse.initialize(usdcMint.publicKey, true);

		await clearingHouse.subscribe();
		const state = clearingHouse.getStateAccount();

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [expectedInsuranceAccountAuthority, expectedInsuranceAccountNonce] =
			await anchor.web3.PublicKey.findProgramAddress(
				[state.insuranceVault.toBuffer()],
				clearingHouse.program.programId
			);
		assert.ok(
			state.insuranceVaultAuthority.equals(expectedInsuranceAccountAuthority)
		);
		assert.ok(state.insuranceVaultNonce == expectedInsuranceAccountNonce);

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
	});

	it('Initialize Market', async () => {
		const periodicity = new BN(60 * 60); // 1 HOUR

		const marketIndex = new BN(0);
		const txSig = await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const marketPublicKey = await getMarketPublicKey(
			clearingHouse.program.programId,
			marketIndex
		);
		const market = (await clearingHouse.program.account.market.fetch(
			marketPublicKey
		)) as MarketAccount;

		assert.ok(market.status);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.openInterest.eq(new BN(0)));

		const ammD = market.amm;
		console.log(ammD.oracle.toString());
		assert.ok(ammD.oracle.equals(solUsd));
		assert.ok(ammD.baseAssetReserve.eq(ammInitialBaseAssetAmount));
		assert.ok(ammD.quoteAssetReserve.eq(ammInitialQuoteAssetAmount));
		assert.ok(ammD.cumulativeFundingRateLong.eq(new BN(0)));
		assert.ok(ammD.cumulativeFundingRateShort.eq(new BN(0)));
		assert.ok(ammD.fundingPeriod.eq(periodicity));
		assert.ok(ammD.lastFundingRate.eq(new BN(0)));
		assert.ok(!ammD.lastFundingRateTs.eq(new BN(0)));
	});

	it('Initialize user account and deposit collateral atomically', async () => {
		let txSig: TransactionSignature;
		[txSig, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
		const depositTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		assert(depositTokenAmount.eq(usdcAmount));
		assert(
			isVariant(
				clearingHouse.getSpotPosition(QUOTE_SPOT_MARKET_INDEX).balanceType,
				'deposit'
			)
		);

		// Check that clearing house collateral account has proper collateral
		const quoteAssetBankVault = await getTokenAccount(
			provider,
			clearingHouse.getQuoteSpotMarketAccount().vault
		);
		assert.ok(quoteAssetBankVault.amount.eq(usdcAmount));

		assert.ok(user.positions.length == 5);
		assert.ok(user.perp_positions[0].baseAssetAmount.toNumber() === 0);
		assert.ok(user.perp_positions[0].quoteEntryAmount.toNumber() === 0);
		assert.ok(
			user.perp_positions[0].lastCumulativeFundingRate.toNumber() === 0
		);

		await eventSubscriber.awaitTx(txSig);
		const depositRecord =
			eventSubscriber.getEventsArray('DepositRecord')[0].data;

		assert.ok(depositRecord.userAuthority.equals(provider.wallet.publicKey));
		assert.ok(depositRecord.user.equals(userAccountPublicKey));

		assert.ok(
			JSON.stringify(depositRecord.direction) ===
				JSON.stringify({ deposit: {} })
		);
		assert.ok(depositRecord.amount.eq(new BN(10000000)));
	});

	it('Take short position (w/ negative unrealized pnl)', async () => {
		const marketIndex = new BN(0);

		const ogTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log('og getQuoteAssetTokenAmount:', ogTokenAmount.toString());

		const newUSDCNotionalAmount = calculateTradeAmount(usdcAmount);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			newUSDCNotionalAmount,
			marketIndex
		);

		// make user have small loss
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(PRICE_PRECISION.toNumber() * 1.05)
		);

		await clearingHouse.fetchAccounts();

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(
			'market0.amm.feePool.balance:',
			market0.amm.feePool.balance.toString(),
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const user0 = clearingHouse.getUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();
		console.log(
			'before unsettledPnl:',
			user0.perpPositions[0].unsettledPnl.toString()
		);

		const unrealizedPnl = userAccount.getUnrealizedPNL(); //false, marketIndex);
		assert(unrealizedPnl.eq(new BN(-2498026)));

		console.log('before unrealizedPnl:', unrealizedPnl.toString());
		console.log(
			'before quoteAssetAmount:',
			user0.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'before quoteEntryAmount:',
			user0.perpPositions[0].quoteEntryAmount.toNumber()
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		await userAccount.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(marketIndex);

		const userBankBalance = clearingHouse.getSpotPosition(
			QUOTE_SPOT_MARKET_INDEX
		);

		console.log(
			'market.pnlPool.balance:',
			market.pnlPool.balance.toString(),
			'market.amm.feePool.balance:',
			market.amm.feePool.balance.toString(),
			'market.amm.totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		const user = clearingHouse.getUserAccount();
		console.log(
			'after unsettledPnl:',
			user.perpPositions[0].unsettledPnl.toString()
		);
		assert(user.perpPositions[0].unsettledPnl.eq(ZERO));

		const unrealizedPnl2 = userAccount.getUnrealizedPNL(); //(false, marketIndex);

		console.log('after unrealizedPnl:', unrealizedPnl2.toString());
		assert(unrealizedPnl2.eq(ZERO));
		console.log(
			'quoteAssetAmount:',
			user.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.perpPositions[0].quoteEntryAmount.toNumber()
		);

		const ogCostBasis = user.perpPositions[0].quoteAssetAmount.add(
			unrealizedPnl //.add(user0.perp_positions[0].unsettledPnl)
		);
		console.log('ogCostBasis:', ogCostBasis.toString());
		assert(ogCostBasis.eq(user.perpPositions[0].quoteEntryAmount));

		const newTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log(
			'getQuoteAssetTokenAmount:',
			clearingHouse.getQuoteAssetTokenAmount().toString(),
			userBankBalance.balanceType
		);
		assert(isVariant(userBankBalance.balanceType, 'deposit'));

		assert(
			newTokenAmount
				.add(market.pnlPool.balance)
				.add(market.amm.feePool.balance)
				.eq(ogTokenAmount)
		);

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(1)));
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(497549506175864)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(49750000)));

		assert.ok(orderRecord.marketIndex.eq(new BN(0)));

		await clearingHouse.closePosition(marketIndex);
	});

	it('Take short position (w/ positive unrealized pnl)', async () => {
		const marketIndex = new BN(0);

		const ogTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log('og getQuoteAssetTokenAmount:', ogTokenAmount.toString());

		const newUSDCNotionalAmount = calculateTradeAmount(usdcAmount);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			newUSDCNotionalAmount.div(new BN(10)),
			marketIndex
		);

		// make user have small loss
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(PRICE_PRECISION.toNumber() * 0.95)
		);
		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(
			'market0.amm.feePool.balance:',
			market0.amm.feePool.balance.toString(),
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const user0 = clearingHouse.getUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();
		console.log(
			'before unsettledPnl:',
			user0.perpPositions[0].unsettledPnl.toString()
		);

		const unrealizedPnl = userAccount.getUnrealizedPNL(); //false, marketIndex);
		// assert(unrealizedPnl.eq(new BN(-2498026)));

		console.log('before unrealizedPnl:', unrealizedPnl.toString());
		console.log(
			'before quoteAssetAmount:',
			user0.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'before quoteEntryAmount:',
			user0.perpPositions[0].quoteEntryAmount.toNumber()
		);

		// close and
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		await userAccount.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(marketIndex);

		const userBankBalance = clearingHouse.getSpotPosition(
			QUOTE_SPOT_MARKET_INDEX
		);

		console.log(
			'market.pnlPool.balance:',
			market.pnlPool.balance.toString(),
			'market.amm.feePool.balance:',
			market.amm.feePool.balance.toString(),
			'market.amm.totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		const user = clearingHouse.getUserAccount();
		console.log(
			'after unsettledPnl:',
			user.perpPositions[0].unsettledPnl.toString()
		);
		assert(user.perpPositions[0].unsettledPnl.eq(ZERO));

		const unrealizedPnl2 = userAccount.getUnrealizedPNL(); //(false, marketIndex);

		console.log('after unrealizedPnl:', unrealizedPnl2.toString());
		assert(unrealizedPnl2.eq(ZERO));
		console.log(
			'quoteAssetAmount:',
			user.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.perpPositions[0].quoteEntryAmount.toNumber()
		);

		const ogCostBasis = user.perpPositions[0].quoteAssetAmount;
		console.log('ogCostBasis:', ogCostBasis.toString());
		assert(ogCostBasis.eq(user.perpPositions[0].quoteEntryAmount));

		const newTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log(
			'getQuoteAssetTokenAmount:',
			clearingHouse.getQuoteAssetTokenAmount().toString(),
			userBankBalance.balanceType
		);
		assert(isVariant(userBankBalance.balanceType, 'deposit'));

		assert(
			newTokenAmount
				.add(market.pnlPool.balance)
				.add(market.amm.feePool.balance)
				.eq(new BN(10000000))
		);

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});
});
