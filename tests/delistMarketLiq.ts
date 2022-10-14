import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	convertToNumber,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
	ClearingHouseUser,
	AMM_RESERVE_PRECISION,
	isVariant,
	MARGIN_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	printTxLogs,
	getFeedData,
	sleep,
} from './testHelpers';
import { Keypair } from '@solana/web3.js';
import { calculateReservePrice } from '../sdk';

async function depositToFeePoolFromIF(
	amount: number,
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	const txSig00 = await clearingHouse.depositIntoPerpMarketFeePool(
		0,
		ifAmount,
		userUSDCAccount.publicKey
	);
	console.log(txSig00);
}

describe('delist market, liquidation of expired position', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let clearingHouseLoser: ClearingHouse;
	let clearingHouseLoserUser: ClearingHouseUser;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;
	let liquidatorClearingHouseWUSDCAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(AMM_RESERVE_PRECISION.toNumber() / 10000);
	const ammInitialQuoteAssetReserve = new anchor.BN(9 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(9 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(1000 * 10 ** 6);
	const userKeypair = new Keypair();

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(10)),
			provider
		);

		solOracle = await mockOracle(43.1337);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(clearingHouse, solOracle);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializePerpMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(42_500_000),
			undefined,
			1000,
			900 // easy to liq
		);

		await clearingHouse.updatePerpMarketMinOrderSize(0, new BN(1));

		// await clearingHouse.updatePerpMarketBaseSpread(new BN(0), 2000);
		// await clearingHouse.updatePerpMarketCurveUpdateIntensity(new BN(0), 100);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		clearingHouseLoser = new Admin({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await clearingHouseLoser.subscribe();
		await clearingHouseLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		clearingHouseLoserUser = new ClearingHouseUser({
			clearingHouse: clearingHouseLoser,
			userAccountPublicKey: await clearingHouseLoser.getUserAccountPublicKey(),
		});
		await clearingHouseLoserUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseLoser.unsubscribe();
		await clearingHouseLoserUser.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		await depositToFeePoolFromIF(1000, clearingHouse, userUSDCAccount);

		try {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				BASE_PRECISION,
				0,
				calculateReservePrice(
					clearingHouse.getPerpMarketAccount(0),
					clearingHouse.getOracleDataForPerpMarket(0)
				)
			);
		} catch (e) {
			console.log('clearingHouse.openPosition');

			console.error(e);
		}

		const uL = clearingHouseLoserUser.getUserAccount();
		console.log(
			'uL.spotPositions[0].scaledBalance:',
			uL.spotPositions[0].scaledBalance.toString()
		);
		assert(
			uL.spotPositions[0].scaledBalance.eq(
				new BN(1000 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);

		console.log(uL.perpPositions[0].baseAssetAmount.toString());
		console.log(uL.perpPositions[0].quoteAssetAmount.toString());

		const bank0Value = clearingHouseLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * 1e6)));

		const clearingHouseLoserUserValue = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('clearingHouseLoserUserValue:', clearingHouseLoserUserValue);
		assert(clearingHouseLoserUserValue == 1000); // ??

		// todo
		try {
			const txSig = await clearingHouseLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				0,
				new BN(0)
			);
			await printTxLogs(connection, txSig);
		} catch (e) {
			console.log('failed clearingHouseLoserc.openPosition');

			console.error(e);
		}

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();
		const userPos = clearingHouseLoser.getUserAccount().perpPositions[0];
		console.log(userPos.baseAssetAmount.toString());
		console.log(userPos.quoteAssetAmount.toString());
		assert(userPos.baseAssetAmount.eq(new BN(205).mul(BASE_PRECISION)));
		assert(userPos.quoteAssetAmount.eq(new BN(-8721212700)));

		const clearingHouseLoserUserLeverage = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: 0,
			}),
			PRICE_PRECISION
		);

		console.log(
			'clearingHouseLoserUser.getLeverage:',
			clearingHouseLoserUserLeverage,
			'clearingHouseLoserUserLiqPrice:',
			clearingHouseLoserUserLiqPrice
		);
		assert(clearingHouseLoserUserLeverage <= 7.8865);
		assert(clearingHouseLoserUserLeverage >= 7.8486);
		assert(clearingHouseLoserUserLiqPrice < 41);
		assert(clearingHouseLoserUserLiqPrice > 40.5);

		const market00 = clearingHouse.getPerpMarketAccount(0);
		assert(market00.amm.feePool.scaledBalance.eq(new BN(1000000000000)));

		const bank0Value1p5 = clearingHouseLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value1p5:', bank0Value1p5.toString());

		const clearingHouseLoserUserValue1p5 = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log(
			'clearingHouseLoserUserValue1p5:',
			clearingHouseLoserUserValue1p5
		);

		// sol tanks 90%
		await clearingHouse.moveAmmToPrice(
			0,
			new BN(40.5 * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, 40.5, solOracle);
		console.log('price move to $40.5');

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage2 = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice2 = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: 0,
			}),
			PRICE_PRECISION
		);

		const bank0Value2 = clearingHouseLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value2:', bank0Value2.toString());

		const clearingHouseLoserUserValue2 = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('clearingHouseLoserUserValue2:', clearingHouseLoserUserValue2);

		console.log(
			'clearingHouseLoserUser.getLeverage2:',
			clearingHouseLoserUserLeverage2,
			'clearingHouseLoserUserLiqPrice2:',
			clearingHouseLoserUserLiqPrice2,
			'bank0Value2:',
			bank0Value2.toString(),
			'clearingHouseLoserUserValue2:',
			clearingHouseLoserUserValue2.toString()
		);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorClearingHouse,
			liquidatorClearingHouseWSOLAccount,
			liquidatorClearingHouseWUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			chProgram,
			solAmount,
			usdcAmount.mul(new BN(100)),
			[0],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			]
		);
		await liquidatorClearingHouse.subscribe();

		const bankIndex = 1;
		await liquidatorClearingHouse.deposit(
			solAmount,
			bankIndex,
			liquidatorClearingHouseWSOLAccount
		);
		await liquidatorClearingHouse.deposit(
			usdcAmount.mul(new BN(100)),
			0,
			liquidatorClearingHouseWUSDCAccount
		);

		const market0 = clearingHouse.getPerpMarketAccount(0);
		const winnerUser = clearingHouse.getUserAccount();
		const loserUser = clearingHouseLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		// TODO: quoteAssetAmountShort!= sum of users
		assert(
			market0.amm.quoteAssetAmountShort.eq(
				winnerUser.perpPositions[0].quoteAssetAmount
			)
		);

		assert(
			market0.amm.quoteAssetAmountLong.eq(
				loserUser.perpPositions[0].quoteAssetAmount
			)
		);
	});

	it('put market in reduce only mode', async () => {
		const marketIndex = 0;
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

		// await clearingHouse.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(43.1337 * PRICE_PRECISION.toNumber())
		// );

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await clearingHouse.updatePerpMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'reduceOnly'));
		console.log(
			'market.expiryTs == ',
			market.expiryTs.toString(),
			'(',
			expiryTs.toString(),
			')'
		);
		assert(market.expiryTs.eq(expiryTs));

		console.log('totalExchangeFee:', market.amm.totalExchangeFee.toString());
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		// should fail
		// try {
		// 	await clearingHouseLoser.openPosition(
		// 		PositionDirection.LONG,
		// 		new BN(10000000),
		// 		new BN(0),
		// 		new BN(0)
		// 	);
		// 	assert(false);
		// } catch (e) {
		// 	console.log(e);

		// 	if (!e.toString().search('AnchorError occurred')) {
		// 		assert(false);
		// 	}
		// 	console.log('risk increase trade failed');
		// }

		// should succeed
		// await clearingHouseLoser.openPosition(
		// 	PositionDirection.SHORT,
		// 	new BN(10000000),
		// 	new BN(0),
		// 	new BN(0)
		// );
	});

	it('put market in settlement mode', async () => {
		const marketIndex = 0;
		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// try {
		const txSig = await clearingHouse.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log('market.expiryPrice:', convertToNumber(market.expiryPrice));

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);

		assert(market.expiryPrice.gt(ZERO));
		assert(market.expiryPrice.eq(new BN(40499999)));
	});

	it('liq and settle expired market position', async () => {
		const marketIndex = 0;
		const loserUser0 = clearingHouseLoser.getUserAccount();
		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));
		// console.log(loserUser0.perpPositions[0]);

		const liquidatorClearingHouseUser = new ClearingHouseUser({
			clearingHouse: liquidatorClearingHouse,
			userAccountPublicKey:
				await liquidatorClearingHouse.getUserAccountPublicKey(),
		});
		await liquidatorClearingHouseUser.subscribe();

		await liquidatorClearingHouse.fetchAccounts();
		await liquidatorClearingHouseUser.fetchAccounts();
		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const liquidatorClearingHouseValue = convertToNumber(
			liquidatorClearingHouseUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorClearingHouseValue:',
			liquidatorClearingHouseValue.toString()
		);

		const clearingHouseLoserUserValue = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'clearingHouseLoserUserValue:',
			clearingHouseLoserUserValue.toString()
		);
		console.log(
			'clearingHouseLoser.baseamount',
			clearingHouseLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		try {
			const txSigLiq = await liquidatorClearingHouse.liquidatePerp(
				await clearingHouseLoser.getUserAccountPublicKey(),
				clearingHouseLoser.getUserAccount(),
				marketIndex,
				BASE_PRECISION.mul(new BN(290))
			);

			console.log(txSigLiq);
		} catch (e) {
			console.error(e);
		}
		await liquidatorClearingHouse.fetchAccounts();
		await liquidatorClearingHouseUser.fetchAccounts();
		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserValueAfter = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'clearingHouseLoserUserValueAfter:',
			clearingHouseLoserUserValueAfter.toString()
		);
		console.log(
			'clearingHouseLoser.baseamount',
			clearingHouseLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const liquidatorClearingHouseValueAfter = convertToNumber(
			liquidatorClearingHouseUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorClearingHouseValueAfter:',
			liquidatorClearingHouseValueAfter.toString()
		);
		const loserMaintMarginReq =
			clearingHouseLoserUser.getMaintenanceMarginRequirement();
		console.log('loserMaintMarginReq:', loserMaintMarginReq.toNumber());

		const liqBuf =
			clearingHouseLoser.getStateAccount().liquidationMarginBufferRatio;
		console.log('liqBuf:', liqBuf);

		const loserMaintMarginReqWBuf =
			clearingHouseLoserUser.getMaintenanceMarginRequirement(new BN(liqBuf));
		console.log('loserMaintMarginReqWBuf:', loserMaintMarginReqWBuf.toNumber());

		assert(
			loserMaintMarginReq.sub(new BN(453307643)).abs().lt(new BN(13307643))
		);

		assert(!clearingHouseLoser.getUserAccount().isBankrupt);

		console.log('settle position clearingHouseLoser');
		const txSig = await clearingHouseLoser.settlePNL(
			await clearingHouseLoser.getUserAccountPublicKey(),
			clearingHouseLoser.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		console.log('settle pnl clearingHouseLoser');

		try {
			await clearingHouse.settlePNL(
				await clearingHouse.getUserAccountPublicKey(),
				clearingHouse.getUserAccount(),
				marketIndex
			);
		} catch (e) {
			// if (!e.toString().search('AnchorError occurred')) {
			// 	assert(false);
			// }
			console.log('Cannot settle pnl under current market status');
		}

		// const settleRecord = eventSubscriber.getEventsArray('SettlePnlRecord')[0];
		// console.log(settleRecord);

		await clearingHouseLoser.fetchAccounts();
		const loserUser = clearingHouseLoser.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(loserUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(loserUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = clearingHouse.getPerpMarketAccount(marketIndex);

		// old 1415296436
		const finalPnlResultMin0 = new BN(1446637831000 - 11090000);
		const finalPnlResultMax0 = new BN(1452538063000 + 11109000);

		console.log(marketAfter0.pnlPool.scaledBalance.toString());
		assert(marketAfter0.pnlPool.scaledBalance.gt(finalPnlResultMin0));
		assert(marketAfter0.pnlPool.scaledBalance.lt(finalPnlResultMax0));

		// const ammPnlResult = new BN(0);
		console.log('feePool:', marketAfter0.amm.feePool.scaledBalance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter0.amm.totalExchangeFee.toString()
		);
		assert(marketAfter0.amm.feePool.scaledBalance.eq(new BN(4356250000)));
		await liquidatorClearingHouseUser.unsubscribe();
	});
});
