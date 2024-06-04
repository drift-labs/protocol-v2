import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	TestClient,
	convertToNumber,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
	User,
	AMM_RESERVE_PRECISION,
	isVariant,
	MARGIN_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	LIQUIDATION_PCT_PRECISION,
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
import {BulkAccountLoader, calculateReservePrice, ContractTier, UserStatus} from '../sdk';

async function depositToFeePoolFromIF(
	amount: number,
	driftClient: TestClient,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	const txSig00 = await driftClient.depositIntoPerpMarketFeePool(
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
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let driftClientLoser: TestClient;
	let driftClientLoserUser: User;

	let liquidatorDriftClient: TestClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;
	let liquidatorDriftClientWUSDCAccount: PublicKey;

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
			usdcAmount.mul(new BN(100)),
			provider
		);

		solOracle = await mockOracle(43.1337);

		driftClient = new TestClient({
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
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(42_500_000),
			undefined,
			ContractTier.A,
			1000,
			900, // easy to liq
			undefined,
			undefined,
			undefined,
			true,
			250,
			500,
		);

		await driftClient.updatePerpMarketMinOrderSize(0, new BN(1));

		// await driftClient.updatePerpMarketBaseSpread(new BN(0), 2000);
		// await driftClient.updatePerpMarketCurveUpdateIntensity(new BN(0), 100);

		await driftClient.initializeUserAccountAndDepositCollateral(
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
		driftClientLoser = new TestClient({
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
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientLoser.subscribe();
		await driftClientLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		driftClientLoserUser = new User({
			driftClient: driftClientLoser,
			userAccountPublicKey: await driftClientLoser.getUserAccountPublicKey(),
		});
		await driftClientLoserUser.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientLoser.unsubscribe();
		await driftClientLoserUser.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		await depositToFeePoolFromIF(10000, driftClient, userUSDCAccount);

		try {
			await driftClient.openPosition(
				PositionDirection.SHORT,
				BASE_PRECISION,
				0,
				calculateReservePrice(
					driftClient.getPerpMarketAccount(0),
					driftClient.getOracleDataForPerpMarket(0)
				)
			);
		} catch (e) {
			console.log('driftClient.openPosition');

			console.error(e);
		}

		const uL = driftClientLoserUser.getUserAccount();
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

		const bank0Value = driftClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * 1e6)));

		const driftClientLoserUserValue = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('driftClientLoserUserValue:', driftClientLoserUserValue);
		assert(driftClientLoserUserValue == 1000); // ??

		// todo
		try {
			const txSig = await driftClientLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				0,
				new BN(0)
			);
			await printTxLogs(connection, txSig);
		} catch (e) {
			console.log('failed driftClientLoserc.openPosition');

			console.error(e);
		}

		await driftClientLoser.fetchAccounts();
		await driftClientLoserUser.fetchAccounts();
		const userPos = driftClientLoser.getUserAccount().perpPositions[0];
		console.log(userPos.baseAssetAmount.toString());
		console.log(userPos.quoteAssetAmount.toString());
		assert(userPos.baseAssetAmount.eq(new BN(205).mul(BASE_PRECISION)));
		// assert(userPos.quoteAssetAmount.eq(new BN(-8721212700)));

		const driftClientLoserUserLeverage = convertToNumber(
			driftClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const driftClientLoserUserLiqPrice = convertToNumber(
			driftClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		console.log(
			'driftClientLoserUser.getLeverage:',
			driftClientLoserUserLeverage,
			'driftClientLoserUserLiqPrice:',
			driftClientLoserUserLiqPrice
		);
		assert(driftClientLoserUserLeverage <= 7.8865);
		assert(driftClientLoserUserLeverage >= 7.8486);
		assert(driftClientLoserUserLiqPrice < 41.390493);
		assert(driftClientLoserUserLiqPrice > 41.300493);

		const market00 = driftClient.getPerpMarketAccount(0);
		assert(market00.amm.feePool.scaledBalance.eq(new BN(10000000000000)));

		const bank0Value1p5 = driftClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value1p5:', bank0Value1p5.toString());

		const driftClientLoserUserValue1p5 = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('driftClientLoserUserValue1p5:', driftClientLoserUserValue1p5);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorDriftClient,
			liquidatorDriftClientWSOLAccount,
			liquidatorDriftClientWUSDCAccount,
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
			],
			bulkAccountLoader
		);
		await liquidatorDriftClient.subscribe();

		const bankIndex = 1;
		await liquidatorDriftClient.deposit(
			solAmount,
			bankIndex,
			liquidatorDriftClientWSOLAccount
		);
		await liquidatorDriftClient.deposit(
			usdcAmount.mul(new BN(100)),
			0,
			liquidatorDriftClientWUSDCAccount
		);
		// sol falls
		const tankPrice = 36.7;
		await driftClient.moveAmmToPrice(
			0,
			new BN(tankPrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, tankPrice, solOracle);
		console.log('price move to $', tankPrice);

		await driftClientLoser.fetchAccounts();
		await driftClientLoserUser.fetchAccounts();

		const driftClientLoserUserLeverage2 = convertToNumber(
			driftClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const driftClientLoserUserLiqPrice2 = convertToNumber(
			driftClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		const bank0Value2 = driftClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value2:', bank0Value2.toString());

		const driftClientLoserUserValue2 = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('driftClientLoserUserValue2:', driftClientLoserUserValue2);

		console.log(
			'driftClientLoserUser.getLeverage2:',
			driftClientLoserUserLeverage2,
			'driftClientLoserUserLiqPrice2:',
			driftClientLoserUserLiqPrice2,
			'bank0Value2:',
			bank0Value2.toString(),
			'driftClientLoserUserValue2:',
			driftClientLoserUserValue2.toString()
		);

		const market0 = driftClient.getPerpMarketAccount(0);
		const winnerUser = driftClient.getUserAccount();
		const loserUser = driftClientLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		// TODO: quoteAssetAmountShort!= sum of users
		assert(
			market0.amm.quoteAssetAmount.eq(
				winnerUser.perpPositions[0].quoteAssetAmount.add(
					loserUser.perpPositions[0].quoteAssetAmount
				)
			)
		);
	});

	it('put market in reduce only mode', async () => {
		const marketIndex = 0;
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

		// await driftClient.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(43.1337 * PRICE_PRECISION.toNumber())
		// );

		const market0 = driftClient.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await driftClient.updatePerpMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		driftClient.fetchAccounts();

		const market = driftClient.getPerpMarketAccount(marketIndex);
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
		// 	await driftClientLoser.openPosition(
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
		// await driftClientLoser.openPosition(
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

		const market0 = driftClient.getPerpMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// try {
		const txSig = await driftClient.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		driftClient.fetchAccounts();

		const market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log('market.expiryPrice:', market.expiryPrice.toString(), convertToNumber(market.expiryPrice));

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);

		assert(market.expiryPrice.gt(ZERO));
		assert(market.expiryPrice.eq(new BN(38820329))); // net user pnl calc more accurate now
		// assert(market.amm.lastMarkPriceTwap.eq(new BN(42753480)));
		console.log(
			'market.amm.lastMarkPriceTwap:',
			convertToNumber(market.amm.lastMarkPriceTwap)
		);
		assert(market.amm.lastMarkPriceTwap.gte(new BN(42503984 - 200)));
		assert(market.amm.lastMarkPriceTwap.lte(new BN(42504249 + 200)));

	});

	it('liq and settle expired market position', async () => {
		const marketIndex = 0;
		const loserUser0 = driftClientLoser.getUserAccount();
		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));
		// console.log(loserUser0.perpPositions[0]);

		const liquidatorDriftClientUser = new User({
			driftClient: liquidatorDriftClient,
			userAccountPublicKey:
				await liquidatorDriftClient.getUserAccountPublicKey(),
		});
		await liquidatorDriftClientUser.subscribe();

		await liquidatorDriftClient.fetchAccounts();
		await liquidatorDriftClientUser.fetchAccounts();
		await driftClientLoser.fetchAccounts();
		await driftClientLoserUser.fetchAccounts();

		const liquidatorDriftClientValue = convertToNumber(
			liquidatorDriftClientUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorDriftClientValue:',
			liquidatorDriftClientValue.toString()
		);

		const driftClientLoserUserValue = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'driftClientLoserUserValue:',
			driftClientLoserUserValue.toString()
		);
		console.log(
			'driftClientLoser.baseamount',
			driftClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);
		const loserMaintMarginReq0 =
			driftClientLoserUser.getMaintenanceMarginRequirement();
		console.log('loserMaintMarginReq:', loserMaintMarginReq0.toNumber());

		const liqBuf0 =
			driftClientLoser.getStateAccount().liquidationMarginBufferRatio;
		console.log('liqBuf:', liqBuf0);

		const loserMaintMarginReqWBuf0 =
			driftClientLoserUser.getMaintenanceMarginRequirement();
		console.log(
			'loserMaintMarginReqWBuf:',
			loserMaintMarginReqWBuf0.toNumber()
		);

		// try {

		// const txSigLiq = await liquidatorDriftClient.liquidatePerp(
		// 	await driftClientLoser.getUserAccountPublicKey(),
		// 	driftClientLoser.getUserAccount(),
		// 	marketIndex,
		// 	BASE_PRECISION.mul(new BN(290))
		// );

		// console.log(txSigLiq);
		// await printTxLogs(connection, txSigLiq);

		// const liquidationRecord =
		// 	eventSubscriber.getEventsArray('LiquidationRecord')[0];
		// console.log(liquidationRecord);
		// assert(liquidationRecord.liquidationId === 1);
		// assert(isVariant(liquidationRecord.liquidationType, 'liquidatePerp'));
		// } catch (e) {
		// 	console.error(e);
		// }
		await liquidatorDriftClient.fetchAccounts();
		await liquidatorDriftClientUser.fetchAccounts();
		await driftClientLoser.fetchAccounts();
		await driftClientLoserUser.fetchAccounts();

		const driftClientLoserUserValueAfter = convertToNumber(
			driftClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'driftClientLoserUserValueAfter:',
			driftClientLoserUserValueAfter.toString()
		);
		console.log(
			'driftClientLoser.baseamount',
			driftClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const liquidatorDriftClientValueAfter = convertToNumber(
			liquidatorDriftClientUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorDriftClientValueAfter:',
			liquidatorDriftClientValueAfter.toString()
		);
		const loserMaintMarginReq =
			driftClientLoserUser.getMaintenanceMarginRequirement();
		console.log('loserMaintMarginReq:', loserMaintMarginReq.toNumber());

		const liqBuf =
			driftClientLoser.getStateAccount().liquidationMarginBufferRatio;
		console.log('liqBuf:', liqBuf);

		const loserMaintMarginReqWBuf =
			driftClientLoserUser.getMaintenanceMarginRequirement();
		console.log('loserMaintMarginReqWBuf:', loserMaintMarginReqWBuf.toNumber());

		assert(loserMaintMarginReq.eq(ZERO));

		const txSigLiqPnl = await liquidatorDriftClient.liquidatePerpPnlForDeposit(
			await driftClientLoser.getUserAccountPublicKey(),
			driftClientLoser.getUserAccount(),
			marketIndex,
			0,
			QUOTE_PRECISION.mul(new BN(10000))
		);
		console.log(txSigLiqPnl);
		await printTxLogs(connection, txSigLiqPnl);

		await sleep(100);
		await driftClientLoser.fetchAccounts();

		console.log(
			'driftClientLoserUser.getNetSpotMarketValue=',
			driftClientLoserUser.getNetSpotMarketValue().toString()
		);
		console.log(
			driftClientLoser
				.getUserAccount()
				.spotPositions[0].scaledBalance.toString()
		);
		console.log(
			driftClientLoser.getUserAccount().spotPositions,
			driftClientLoser.getUserAccount().perpPositions
		);

		assert(driftClientLoser.getUserAccount().status === UserStatus.BANKRUPT);

		const txSigBankrupt = await liquidatorDriftClient.resolvePerpBankruptcy(
			await driftClientLoser.getUserAccountPublicKey(),
			driftClientLoser.getUserAccount(),
			marketIndex
		);

		console.log(txSigBankrupt);
		await printTxLogs(connection, txSigBankrupt);

		await driftClientLoser.fetchAccounts();
		assert(driftClientLoser.getUserAccount().status !== UserStatus.BANKRUPT);
		assert(
			driftClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
		);
		assert(
			driftClientLoser
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(ZERO)
		);
		try {
			// should fail

			console.log('settle position driftClientLoser');
			const txSig = await driftClientLoser.settlePNL(
				await driftClientLoser.getUserAccountPublicKey(),
				driftClientLoser.getUserAccount(),
				marketIndex
			);
			await printTxLogs(connection, txSig);

			console.log('settle pnl driftClientLoser');
		} catch (e) {
			//
			console.error(e);
		}

		try {
			await driftClient.settlePNL(
				await driftClient.getUserAccountPublicKey(),
				driftClient.getUserAccount(),
				marketIndex
			);
		} catch (e) {
			// if (!e.toString().search('AnchorError occurred')) {
			// 	assert(false);
			// }
			console.log('Cannot settle pnl under current market status');
		}

		try {
			await liquidatorDriftClient.settlePNL(
				await liquidatorDriftClient.getUserAccountPublicKey(),
				liquidatorDriftClient.getUserAccount(),
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

		await driftClientLoser.fetchAccounts();
		const liqUser = liquidatorDriftClient.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(liqUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(liqUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = driftClient.getPerpMarketAccount(marketIndex);
		console.log(marketAfter0);
		assert(marketAfter0.numberOfUsersWithBase === 0);

		// old 1415296436
		const finalPnlResultMin0 = new BN(2266346249000 - 110900000);
		const finalPnlResultMax0 = new BN(2266346249000 + 111090000);

		console.log(
			'marketAfter0.pnlPool.scaledBalance:',
			marketAfter0.pnlPool.scaledBalance.toString()
		);
		assert(marketAfter0.pnlPool.scaledBalance.gt(finalPnlResultMin0));
		assert(marketAfter0.pnlPool.scaledBalance.lt(finalPnlResultMax0));

		// const ammPnlResult = new BN(0);
		console.log('feePool:', marketAfter0.amm.feePool.scaledBalance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter0.amm.totalExchangeFee.toString()
		);
		assert(marketAfter0.amm.feePool.scaledBalance.eq(ZERO));
		assert(marketAfter0.amm.totalExchangeFee.eq(new BN(8712501)));
		await liquidatorDriftClientUser.unsubscribe();
	});
});
