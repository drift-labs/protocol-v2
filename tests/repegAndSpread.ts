import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BN,
	calculatePrice,
	getMarketOrderParams,
	OracleSource,
	BID_ASK_SPREAD_PRECISION,
	PEG_PRECISION,
	QUOTE_ASSET_BANK_INDEX,
	getTokenAmount,
	BankBalanceType,
} from '../sdk';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
	Keypair,
	sendAndConfirmTransaction,
	Transaction,
} from '@solana/web3.js';
import { Program } from '@project-serum/anchor';

import {
	Admin,
	ClearingHouseUser,
	// MARK_PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	// calculateMarkPrice,
	PositionDirection,
	EventSubscriber,
	convertToNumber,
	calculateBidAskPrice,
	calculateUpdatedAMM,
	calculateSpread,
	calculateSpreadBN,
} from '../sdk/src';

import {
	getFeedData,
	initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	getOraclePriceData,
	initializeQuoteAssetBank,
} from './testHelpers';

async function depositToFeePoolFromIF(
	amount: number,
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());
	const state = await clearingHouse.getStateAccount();
	const tokenIx = Token.createTransferInstruction(
		TOKEN_PROGRAM_ID,
		userUSDCAccount.publicKey,
		state.insuranceVault,
		clearingHouse.provider.wallet.publicKey,
		// usdcMint.publicKey,
		[],
		ifAmount.toNumber()
	);

	await sendAndConfirmTransaction(
		clearingHouse.provider.connection,
		new Transaction().add(tokenIx),
		// @ts-ignore
		[clearingHouse.provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);

	// // send $50 to market from IF
	const txSig00 = await clearingHouse.withdrawFromInsuranceVaultToMarket(
		new BN(0),
		ifAmount
	);
	console.log(txSig00);
}

describe('repeg and spread amm', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	// let userAccountPublicKey: PublicKeys;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	// const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(94).mul(
		AMM_RESERVE_PRECISION
	);
	const ammInitialBaseAssetAmount = new anchor.BN(94).mul(
		AMM_RESERVE_PRECISION
	);

	const usdcAmount = new BN(10000 * 10 ** 6);

	let marketIndexes;
	let bankIndexes;
	let oracleInfos;
	let btcUsd;
	const mockOracles = [];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)),
			provider
		);

		btcUsd = await mockOracle(21966);
		mockOracles.push(btcUsd);
		for (let i = 1; i <= 4; i++) {
			// init more oracles
			const thisUsd = await mockOracle(i);
			mockOracles.push(thisUsd);
		}

		bankIndexes = [new BN(0)];
		marketIndexes = mockOracles.map((_, i) => new BN(i));
		oracleInfos = mockOracles.map((oracle) => {
			return { publicKey: oracle, source: OracleSource.PYTH };
		});

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: marketIndexes,
			bankIndexes: bankIndexes,
			oracleInfos: oracleInfos,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.updateAuctionDuration(0, 0);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		// BTC
		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(21_966_868),
			undefined,
			500,
			333,
			200
		);
		await clearingHouse.updateMarketBaseSpread(new BN(0), 250);
		await clearingHouse.updateCurveUpdateIntensity(new BN(0), 100);

		for (let i = 1; i <= 4; i++) {
			// init more markets
			const thisUsd = mockOracles[i];
			await clearingHouse.initializeMarket(
				thisUsd,
				ammInitialBaseAssetAmount,
				ammInitialQuoteAssetAmount,
				periodicity,
				new BN(1_000 * i),
				undefined,
				1000
			);
			await clearingHouse.updateMarketBaseSpread(new BN(i), 2000);
			await clearingHouse.updateCurveUpdateIntensity(new BN(i), 100);
		}

		const [, _userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('BTC market massive spread', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(0.19316 * AMM_RESERVE_PRECISION.toNumber());
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await depositToFeePoolFromIF(0.001, clearingHouse, userUSDCAccount);

		// await clearingHouse.placeAndFillOrder(orderParams);
		// await clearingHouse.closePosition(new BN(0));
		const txSig0 = await clearingHouse.placeAndTake(orderParams);

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig0, { commitment: 'confirmed' }))
				.meta.logMessages
		);
		await depositToFeePoolFromIF(50, clearingHouse, userUSDCAccount);

		// old oracle price: 21966
		await setFeedPrice(anchor.workspace.Pyth, 19790, btcUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, btcUsd)).price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			btcUsd
		);
		const market0 = clearingHouse.getMarketAccount(0);
		console.log(
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toNumber() /
				QUOTE_PRECISION.toNumber()
		);
		console.log(
			'market0.amm.pegMultiplier:',
			market0.amm.pegMultiplier.toNumber() / PEG_PRECISION.toNumber()
		);
		console.log(
			'market0.amm.netBaseAssetAmount:',
			market0.amm.netBaseAssetAmount.toString(),
			'terminalQuoteAssetReserve:',
			market0.amm.terminalQuoteAssetReserve.toString(),
			'quoteAssetReserve:',
			market0.amm.quoteAssetReserve.toString(),
			'pegMultiplier:',
			market0.amm.pegMultiplier.toString()
		);

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);
		const longSpread = calculateSpread(
			prepegAMM,
			PositionDirection.LONG,
			oraclePriceData
		);
		const shortSpread = calculateSpread(
			prepegAMM,
			PositionDirection.SHORT,
			oraclePriceData
		);
		console.log('spreads:', longSpread, shortSpread);
		assert(shortSpread > longSpread);

		const markPrice = calculatePrice(
			prepegAMM.baseAssetReserve,
			prepegAMM.quoteAssetReserve,
			prepegAMM.pegMultiplier
		);

		const targetPrice = oraclePriceData?.price || markPrice;

		const targetMarkSpreadPct = markPrice
			.sub(targetPrice)
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(markPrice);

		const tfMD =
			prepegAMM.totalFeeMinusDistributions.toNumber() /
			QUOTE_PRECISION.toNumber();
		console.log('prepegAMM.totalFeeMinusDistributions:', tfMD);
		assert(tfMD < 0); // enforcing max spread

		console.log(
			'prepegAMM.pegMultiplier:',
			prepegAMM.pegMultiplier.toNumber() / PEG_PRECISION.toNumber()
		);

		console.log(
			'prepegAMM.netBaseAssetAmount:',
			prepegAMM.netBaseAssetAmount.toString(),
			'terminalQuoteAssetReserve:',
			prepegAMM.terminalQuoteAssetReserve.toString(),
			'quoteAssetReserve:',
			prepegAMM.quoteAssetReserve.toString(),
			'pegMultiplier:',
			prepegAMM.pegMultiplier.toString()
		);
		const [ls1, ss1] = calculateSpreadBN(
			prepegAMM.baseSpread,
			targetMarkSpreadPct,
			new BN(0),
			prepegAMM.maxSpread,
			prepegAMM.quoteAssetReserve,
			prepegAMM.terminalQuoteAssetReserve,
			prepegAMM.pegMultiplier,
			prepegAMM.netBaseAssetAmount,
			markPrice,
			prepegAMM.totalFeeMinusDistributions
		);
		console.log('spreads:', ls1, ss1);
		const maxSpread = market0.marginRatioInitial * 100;
		assert(ls1 + ss1 == maxSpread);

		console.log(
			'pre trade bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'\n pre trade mark price:',
			convertToNumber(
				calculatePrice(
					prepegAMM.baseAssetReserve,
					prepegAMM.quoteAssetReserve,
					prepegAMM.pegMultiplier
				)
			)
		);

		const midPrice = (convertToNumber(bid) + convertToNumber(ask)) / 2;

		console.log(convertToNumber(oraclePriceData.price), midPrice);

		try {
			const txSig = await clearingHouse.updateAMMs([marketIndex]);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const market = clearingHouse.getMarketAccount(0);
		const [bid1, ask1] = calculateBidAskPrice(
			market.amm,
			oraclePriceData,
			false
		);

		const mark1 = calculatePrice(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);
		console.log(
			'post trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'\n post trade mark price:',
			convertToNumber(mark1)
		);

		assert(bid1.eq(bid));
		assert(ask1.eq(ask));
		assert(mark1.eq(markPrice));

		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		console.log(market.amm.pegMultiplier.toString());
		const actualDist = market.amm.totalFee.sub(
			market.amm.totalFeeMinusDistributions
		);
		console.log('actual distribution:', actualDist.toString());

		console.log(prepegAMM.sqrtK.toString(), '==', market.amm.sqrtK.toString());
		const marketInvariant = market.amm.sqrtK.mul(market.amm.sqrtK);

		// check k math good
		const qAR1 = marketInvariant.div(market.amm.baseAssetReserve);
		const bAR1 = marketInvariant.div(market.amm.quoteAssetReserve);
		console.log(qAR1.toString(), '==', market.amm.quoteAssetReserve.toString());
		assert(qAR1.eq(market.amm.quoteAssetReserve));
		console.log(bAR1.toString(), '==', market.amm.baseAssetReserve.toString());
		assert(bAR1.eq(market.amm.baseAssetReserve));

		await clearingHouse.closePosition(new BN(0));
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();
		console.log(clearingHouseUser.getCollateralValue().toString());
		assert(clearingHouseUser.getCollateralValue().eq(usdcAmount));
		await clearingHouseUser.unsubscribe();
	});

	it('5 users, 15 trades, single market, check invariants', async () => {
		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const market00 = clearingHouse.getMarketAccount(0);
		const initialTotalFeeMinusDistributions = convertToNumber(
			market00.amm.totalFeeMinusDistributions,
			QUOTE_PRECISION
		);

		const [_userUSDCAccounts, _user_keys, clearingHouses, _userAccountInfos] =
			await initUserAccounts(
				5,
				usdcMint,
				usdcAmount,
				provider,
				marketIndexes,
				bankIndexes,
				[]
			);
		let count = 0;
		let btcPrice = 19790;
		while (count < 15) {
			console.log(count);

			if (count % 3 == 0) {
				btcPrice *= 1.075;
			} else {
				btcPrice *= 0.999;
			}
			await setFeedPrice(anchor.workspace.Pyth, btcPrice, btcUsd);
			const oraclePriceData = await getOraclePriceData(
				anchor.workspace.Pyth,
				btcUsd
			);

			const market0 = clearingHouse.getMarketAccount(0);
			const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
			const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);
			const longSpread = calculateSpread(
				prepegAMM,
				PositionDirection.LONG,
				oraclePriceData
			);
			const shortSpread = calculateSpread(
				prepegAMM,
				PositionDirection.SHORT,
				oraclePriceData
			);
			console.log('spreads:', longSpread, shortSpread);
			console.log(
				'bid/oracle/ask:',
				convertToNumber(bid),
				btcPrice,
				convertToNumber(ask)
			);
			let tradeSize =
				0.053 * ((count % 7) + 1) * AMM_RESERVE_PRECISION.toNumber();
			let tradeDirection;
			if (count % 2 == 0) {
				tradeDirection = PositionDirection.LONG;
				tradeSize *= 2;
			} else {
				tradeDirection = PositionDirection.SHORT;
			}

			const orderParams = getMarketOrderParams({
				marketIndex: new BN(0),
				direction: tradeDirection,
				baseAssetAmount: new BN(tradeSize),
			});

			await clearingHouses[count % 5].placeAndTake(orderParams);
			count += 1;
		}

		let allUserCollateral = 0;
		let allUserUnsettledPnl = 0;

		for (let i = 0; i < clearingHouses.length; i++) {
			await clearingHouses[i].closePosition(new BN(0));
			await clearingHouses[i].settlePNL(
				await clearingHouses[i].getUserAccountPublicKey(),
				clearingHouses[i].getUserAccount(),
				new BN(0)
			);

			const clearingHouse = clearingHouses[i];
			const clearingHouseUser = _userAccountInfos[i];
			const userCollateral = convertToNumber(
				clearingHouseUser.getCollateralValue(),
				QUOTE_PRECISION
			);

			const userUnsettledPnl = convertToNumber(
				clearingHouseUser.getUnsettledPNL(),
				QUOTE_PRECISION
			);
			allUserCollateral += userCollateral;
			allUserUnsettledPnl += userUnsettledPnl;
			console.log(
				'user',
				i,
				':',
				'$',
				userCollateral,
				'+',
				userUnsettledPnl,
				'(unsettled)'
			);
			await clearingHouse.unsubscribe();
			await clearingHouseUser.unsubscribe();
		}

		const market0 = clearingHouse.getMarketAccount(0);

		console.log('total Fees:', market0.amm.totalFee.toString());
		console.log(
			'total Fees minus dist:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const bankAccount = clearingHouse.getBankAccount(QUOTE_ASSET_BANK_INDEX);

		const pnlPoolBalance = convertToNumber(
			getTokenAmount(
				market0.pnlPool.balance,
				bankAccount,
				BankBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const feePoolBalance = convertToNumber(
			getTokenAmount(
				market0.amm.feePool.balance,
				bankAccount,
				BankBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const sinceStartTFMD =
			convertToNumber(market0.amm.totalFeeMinusDistributions, QUOTE_PRECISION) -
			initialTotalFeeMinusDistributions;

		console.log(
			'sum all money:',
			allUserCollateral,
			'+',
			pnlPoolBalance,
			'+',
			feePoolBalance,
			'+',
			allUserUnsettledPnl,
			'+',
			sinceStartTFMD,
			'==',
			50000
		);

		assert(Math.abs(allUserUnsettledPnl + sinceStartTFMD) < 2);
		assert(allUserCollateral + pnlPoolBalance + feePoolBalance == 50000);
	});
});
