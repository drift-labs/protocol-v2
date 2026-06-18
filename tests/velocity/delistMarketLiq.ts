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
} from '../../packages/sdk/src';

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
import {
	BulkAccountLoader,
	calculateReservePrice,
	ContractTier,
	UserStatus,
} from '../../packages/sdk';

async function depositToFeePoolFromIF(
	amount: number,
	velocityClient: TestClient,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	const txSig00 = await velocityClient.depositIntoPerpMarketFeePool(
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
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let velocityClientLoser: TestClient;
	let velocityClientLoserUser: User;

	let liquidatorVelocityClient: TestClient;
	let liquidatorVelocityClientWSOLAccount: PublicKey;
	let liquidatorVelocityClientWUSDCAccount: PublicKey;

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

		velocityClient = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(velocityClient, solOracle);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		await velocityClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		const periodicity = new BN(0);

		await velocityClient.initializePerpMarket(
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
			500
		);

		await velocityClient.updatePerpMarketMinOrderSize(0, new BN(1));

		// await velocityClient.updatePerpMarketBaseSpread(new BN(0), 2000);
		// await velocityClient.updatePerpMarketCurveUpdateIntensity(new BN(0), 100);

		await velocityClient.initializeUserAccountAndDepositCollateral(
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
		velocityClientLoser = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientLoser.subscribe();
		await velocityClientLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		velocityClientLoserUser = new User({
			velocityClient: velocityClientLoser,
			userAccountPublicKey: await velocityClientLoser.getUserAccountPublicKey(),
		});
		await velocityClientLoserUser.subscribe();
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await velocityClientLoser.unsubscribe();
		await velocityClientLoserUser.unsubscribe();
		await liquidatorVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		await depositToFeePoolFromIF(10000, velocityClient, userUSDCAccount);

		try {
			await velocityClient.openPosition(
				PositionDirection.SHORT,
				BASE_PRECISION,
				0,
				calculateReservePrice(
					velocityClient.getPerpMarketAccount(0),
					velocityClient.getOracleDataForPerpMarket(0)
				)
			);
		} catch (e) {
			console.log('velocityClient.openPosition');

			console.error(e);
		}

		const uL = velocityClientLoserUser.getUserAccount();
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

		const bank0Value = velocityClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * 1e6)));

		const velocityClientLoserUserValue = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('velocityClientLoserUserValue:', velocityClientLoserUserValue);
		assert(velocityClientLoserUserValue == 1000); // ??

		// todo
		try {
			const txSig = await velocityClientLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				0,
				new BN(0)
			);
			await printTxLogs(connection, txSig);
		} catch (e) {
			console.log('failed velocityClientLoserc.openPosition');

			console.error(e);
		}

		await velocityClientLoser.fetchAccounts();
		await velocityClientLoserUser.fetchAccounts();
		const userPos = velocityClientLoser.getUserAccount().perpPositions[0];
		console.log(userPos.baseAssetAmount.toString());
		console.log(userPos.quoteAssetAmount.toString());
		assert(userPos.baseAssetAmount.eq(new BN(205).mul(BASE_PRECISION)));
		// assert(userPos.quoteAssetAmount.eq(new BN(-8721212700)));

		const velocityClientLoserUserLeverage = convertToNumber(
			velocityClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const velocityClientLoserUserLiqPrice = convertToNumber(
			velocityClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		console.log(
			'velocityClientLoserUser.getLeverage:',
			velocityClientLoserUserLeverage,
			'velocityClientLoserUserLiqPrice:',
			velocityClientLoserUserLiqPrice
		);
		assert(velocityClientLoserUserLeverage <= 7.8865);
		assert(velocityClientLoserUserLeverage >= 7.8486);
		assert(velocityClientLoserUserLiqPrice < 41.390493);
		assert(velocityClientLoserUserLiqPrice > 41.300493);

		const market00 = velocityClient.getPerpMarketAccount(0);
		assert(market00.amm.feePool.scaledBalance.eq(new BN(10000000000000)));

		const bank0Value1p5 = velocityClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value1p5:', bank0Value1p5.toString());

		const velocityClientLoserUserValue1p5 = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log(
			'velocityClientLoserUserValue1p5:',
			velocityClientLoserUserValue1p5
		);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorVelocityClient,
			liquidatorVelocityClientWSOLAccount,
			liquidatorVelocityClientWUSDCAccount,
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			bulkAccountLoader
		);
		await liquidatorVelocityClient.subscribe();

		const bankIndex = 1;
		await liquidatorVelocityClient.deposit(
			solAmount,
			bankIndex,
			liquidatorVelocityClientWSOLAccount
		);
		await liquidatorVelocityClient.deposit(
			usdcAmount.mul(new BN(100)),
			0,
			liquidatorVelocityClientWUSDCAccount
		);
		// sol falls
		const tankPrice = 36.7;
		await velocityClient.moveAmmToPrice(
			0,
			new BN(tankPrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, tankPrice, solOracle);
		console.log('price move to $', tankPrice);

		await velocityClientLoser.fetchAccounts();
		await velocityClientLoserUser.fetchAccounts();

		const velocityClientLoserUserLeverage2 = convertToNumber(
			velocityClientLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const velocityClientLoserUserLiqPrice2 = convertToNumber(
			velocityClientLoserUser.liquidationPrice(0),
			PRICE_PRECISION
		);

		const bank0Value2 = velocityClientLoserUser.getSpotMarketAssetValue(0);
		console.log('uL.bank0Value2:', bank0Value2.toString());

		const velocityClientLoserUserValue2 = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log(
			'velocityClientLoserUserValue2:',
			velocityClientLoserUserValue2
		);

		console.log(
			'velocityClientLoserUser.getLeverage2:',
			velocityClientLoserUserLeverage2,
			'velocityClientLoserUserLiqPrice2:',
			velocityClientLoserUserLiqPrice2,
			'bank0Value2:',
			bank0Value2.toString(),
			'velocityClientLoserUserValue2:',
			velocityClientLoserUserValue2.toString()
		);

		const market0 = velocityClient.getPerpMarketAccount(0);
		const winnerUser = velocityClient.getUserAccount();
		const loserUser = velocityClientLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		// TODO: quoteAssetAmountShort!= sum of users
		assert(
			market0.quoteAssetAmount.eq(
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

		// await velocityClient.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(43.1337 * PRICE_PRECISION.toNumber())
		// );

		const market0 = velocityClient.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await velocityClient.updatePerpMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		velocityClient.fetchAccounts();

		const market = velocityClient.getPerpMarketAccount(marketIndex);
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

		console.log(
			'totalExchangeFee:',
			market.feeLedger.totalExchangeFee.toString()
		);
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		// should fail
		// try {
		// 	await velocityClientLoser.openPosition(
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
		// await velocityClientLoser.openPosition(
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

		const market0 = velocityClient.getPerpMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// try {
		const txSig = await velocityClient.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		velocityClient.fetchAccounts();

		const market = velocityClient.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log(
			'market.expiryPrice:',
			market.expiryPrice.toString(),
			convertToNumber(market.expiryPrice)
		);

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);

		assert(market.expiryPrice.gt(ZERO));
		assert(market.expiryPrice.eq(new BN(38820329))); // net user pnl calc more accurate now
		// assert(market.marketStats.lastMarkPriceTwap.eq(new BN(42753480)));
		console.log(
			'market.marketStats.lastMarkPriceTwap:',
			convertToNumber(market.marketStats.lastMarkPriceTwap)
		);
		assert(market.marketStats.lastMarkPriceTwap.gte(new BN(42503984 - 200)));
		assert(market.marketStats.lastMarkPriceTwap.lte(new BN(42504249 + 200)));
	});

	it('liq and settle expired market position', async () => {
		const marketIndex = 0;
		const loserUser0 = velocityClientLoser.getUserAccount();
		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));
		// console.log(loserUser0.perpPositions[0]);

		const liquidatorVelocityClientUser = new User({
			velocityClient: liquidatorVelocityClient,
			userAccountPublicKey:
				await liquidatorVelocityClient.getUserAccountPublicKey(),
		});
		await liquidatorVelocityClientUser.subscribe();

		await liquidatorVelocityClient.fetchAccounts();
		await liquidatorVelocityClientUser.fetchAccounts();
		await velocityClientLoser.fetchAccounts();
		await velocityClientLoserUser.fetchAccounts();

		const liquidatorVelocityClientValue = convertToNumber(
			liquidatorVelocityClientUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorVelocityClientValue:',
			liquidatorVelocityClientValue.toString()
		);

		const velocityClientLoserUserValue = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'velocityClientLoserUserValue:',
			velocityClientLoserUserValue.toString()
		);
		console.log(
			'velocityClientLoser.baseamount',
			velocityClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);
		const loserMaintMarginReq0 =
			velocityClientLoserUser.getMaintenanceMarginRequirement();
		console.log('loserMaintMarginReq:', loserMaintMarginReq0.toNumber());

		const liqBuf0 =
			velocityClientLoser.getStateAccount().liquidationMarginBufferRatio;
		console.log('liqBuf:', liqBuf0);

		const loserMaintMarginReqWBuf0 =
			velocityClientLoserUser.getMaintenanceMarginRequirement();
		console.log(
			'loserMaintMarginReqWBuf:',
			loserMaintMarginReqWBuf0.toNumber()
		);

		// try {

		// const txSigLiq = await liquidatorVelocityClient.liquidatePerp(
		// 	await velocityClientLoser.getUserAccountPublicKey(),
		// 	velocityClientLoser.getUserAccount(),
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
		await liquidatorVelocityClient.fetchAccounts();
		await liquidatorVelocityClientUser.fetchAccounts();
		await velocityClientLoser.fetchAccounts();
		await velocityClientLoserUser.fetchAccounts();

		const velocityClientLoserUserValueAfter = convertToNumber(
			velocityClientLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'velocityClientLoserUserValueAfter:',
			velocityClientLoserUserValueAfter.toString()
		);
		console.log(
			'velocityClientLoser.baseamount',
			velocityClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const liquidatorVelocityClientValueAfter = convertToNumber(
			liquidatorVelocityClientUser.getTotalCollateral(),
			QUOTE_PRECISION
		);
		console.log(
			'liquidatorVelocityClientValueAfter:',
			liquidatorVelocityClientValueAfter.toString()
		);
		const loserMaintMarginReq =
			velocityClientLoserUser.getMaintenanceMarginRequirement();
		console.log('loserMaintMarginReq:', loserMaintMarginReq.toNumber());

		const liqBuf =
			velocityClientLoser.getStateAccount().liquidationMarginBufferRatio;
		console.log('liqBuf:', liqBuf);

		const loserMaintMarginReqWBuf =
			velocityClientLoserUser.getMaintenanceMarginRequirement();
		console.log('loserMaintMarginReqWBuf:', loserMaintMarginReqWBuf.toNumber());

		assert(loserMaintMarginReq.eq(ZERO));

		const txSigLiqPnl =
			await liquidatorVelocityClient.liquidatePerpPnlForDeposit(
				await velocityClientLoser.getUserAccountPublicKey(),
				velocityClientLoser.getUserAccount(),
				marketIndex,
				0,
				QUOTE_PRECISION.mul(new BN(10000))
			);
		console.log(txSigLiqPnl);
		await printTxLogs(connection, txSigLiqPnl);

		await sleep(100);
		await velocityClientLoser.fetchAccounts();

		console.log(
			'velocityClientLoserUser.getNetSpotMarketValue=',
			velocityClientLoserUser.getNetSpotMarketValue().toString()
		);
		console.log(
			velocityClientLoser
				.getUserAccount()
				.spotPositions[0].scaledBalance.toString()
		);
		console.log(
			velocityClientLoser.getUserAccount().spotPositions,
			velocityClientLoser.getUserAccount().perpPositions
		);

		assert(velocityClientLoser.getUserAccount().status === UserStatus.BANKRUPT);

		const txSigBankrupt = await liquidatorVelocityClient.resolvePerpBankruptcy(
			await velocityClientLoser.getUserAccountPublicKey(),
			velocityClientLoser.getUserAccount(),
			marketIndex
		);

		console.log(txSigBankrupt);
		await printTxLogs(connection, txSigBankrupt);

		await velocityClientLoser.fetchAccounts();
		assert(velocityClientLoser.getUserAccount().status !== UserStatus.BANKRUPT);
		assert(
			velocityClientLoser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
		);
		assert(
			velocityClientLoser
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(ZERO)
		);
		try {
			// should fail

			console.log('settle position velocityClientLoser');
			const txSig = await velocityClientLoser.settlePNL(
				await velocityClientLoser.getUserAccountPublicKey(),
				velocityClientLoser.getUserAccount(),
				marketIndex
			);
			await printTxLogs(connection, txSig);

			console.log('settle pnl velocityClientLoser');
		} catch (e) {
			//
			console.error(e);
		}

		try {
			await velocityClient.settlePNL(
				await velocityClient.getUserAccountPublicKey(),
				velocityClient.getUserAccount(),
				marketIndex
			);
		} catch (e) {
			// if (!e.toString().search('AnchorError occurred')) {
			// 	assert(false);
			// }
			console.log('Cannot settle pnl under current market status');
		}

		try {
			await liquidatorVelocityClient.settlePNL(
				await liquidatorVelocityClient.getUserAccountPublicKey(),
				liquidatorVelocityClient.getUserAccount(),
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

		await velocityClientLoser.fetchAccounts();
		const liqUser = liquidatorVelocityClient.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(liqUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(liqUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = velocityClient.getPerpMarketAccount(marketIndex);
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
			marketAfter0.feeLedger.totalExchangeFee.toString()
		);
		assert(marketAfter0.amm.feePool.scaledBalance.eq(ZERO));
		assert(marketAfter0.feeLedger.totalExchangeFee.eq(new BN(8712501)));
		await liquidatorDriftClientUser.unsubscribe();
	});
});
