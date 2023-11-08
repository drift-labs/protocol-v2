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
	calculateBaseAssetValueWithOracle,
	OracleGuardRails,
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
	getOraclePriceData,
	sleep,
} from './testHelpers';
import { BulkAccountLoader, isVariant, PERCENTAGE_PRECISION } from '../sdk';
import { Keypair } from '@solana/web3.js';

async function depositToFeePoolFromIF(
	amount: number,
	driftClient: TestClient,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());
	// const state = await driftClient.getStateAccount();
	// const tokenIx = Token.createTransferInstruction(
	// 	TOKEN_PROGRAM_ID,
	// 	userUSDCAccount.publicKey,
	// 	state.insuranceVault,
	// 	driftClient.provider.wallet.publicKey,
	// 	// usdcMint.publicKey,
	// 	[],
	// 	ifAmount.toNumber()
	// );
	//
	// await sendAndConfirmTransaction(
	// 	driftClient.provider.connection,
	// 	new Transaction().add(tokenIx),
	// 	// @ts-ignore
	// 	[driftClient.provider.wallet.payer],
	// 	{
	// 		skipPreflight: false,
	// 		commitment: 'recent',
	// 		preflightCommitment: 'recent',
	// 	}
	// );

	console.log(userUSDCAccount.publicKey.toString());
	// // send $50 to market from IF
	const txSig00 = await driftClient.depositIntoPerpMarketFeePool(
		0,
		ifAmount,
		userUSDCAccount.publicKey
	);
	console.log(txSig00);
}

describe('delist market', () => {
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

	let liquidatorDriftClient: TestClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
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

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(43_133_000)
		);

		// await driftClient.updatePerpMarketBaseSpread(new BN(0), 2000);
		// await driftClient.updatePerpMarketCurveUpdateIntensity(new BN(0), 100);
		await driftClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(10),
			new BN(1)
		);
		await driftClient.updatePerpMarketMinOrderSize(0, new BN(1));

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
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientLoser.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user positive pnl', async () => {
		await sleep(1000);
		await depositToFeePoolFromIF(1000, driftClient, userUSDCAccount);
		await driftClient.fetchAccounts();
		// try {
		await driftClient.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		// } catch (e) {
		// 	console.log('driftClient.openPosition');

		// 	console.error(e);
		// }

		// todo
		// try {
		await driftClientLoser.fetchAccounts();

		await driftClientLoser.openPosition(
			PositionDirection.LONG,
			new BN(2000 * 2),
			0
		);
		// } catch (e) {
		// 	console.log('driftClientLoserc.openPosition');

		// 	console.error(e);
		// 	return 0;
		// }

		await driftClient.fetchAccounts();
		const market00 = driftClient.getPerpMarketAccount(0);
		assert(market00.amm.feePool.scaledBalance.eq(new BN(1000000000000)));

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
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

		const market0 = driftClient.getPerpMarketAccount(0);
		const winnerUser = driftClient.getUserAccount();
		const loserUser = driftClientLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		assert(
			market0.amm.quoteAssetAmount.eq(
				winnerUser.perpPositions[0].quoteAssetAmount.add(
					loserUser.perpPositions[0].quoteAssetAmount
				)
			)
		);
	});

	it('go through multiple market state changes', async () => {
		const marketIndex = 0;
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(10).mul(PERCENTAGE_PRECISION),
				oracleTwap5MinPercentDivergence: new BN(10).mul(PERCENTAGE_PRECISION),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(100000000),
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		await driftClient.updateFundingRate(marketIndex, solOracle);

		await driftClient.fetchAccounts();
		const perpMarket = await driftClient.getPerpMarketAccount(marketIndex);
		// console.log(perpMarket.amm.cumulativeFundingRateLong.toString());
		assert(!perpMarket.amm.cumulativeFundingRateLong.eq(ZERO));

		await liquidatorDriftClient.addPerpLpShares(BASE_PRECISION, marketIndex);
		await driftClient.updateK(
			marketIndex,
			perpMarket.amm.sqrtK.mul(new BN(10012345)).div(new BN(9912345))
		);
		await driftClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		await driftClient.updateK(marketIndex, perpMarket.amm.sqrtK);
		await driftClient.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		await driftClient.updateFundingRate(marketIndex, solOracle);
		await liquidatorDriftClient.removePerpLpShares(marketIndex);
		await driftClient.updateK(
			marketIndex,
			perpMarket.amm.sqrtK.mul(new BN(9912345)).div(new BN(10012345))
		);

		console.log(
			'liquidatorDriftClient perps:',
			liquidatorDriftClient.getUserAccount().perpPositions[0]
		);
		// await liquidatorDriftClient.closePosition(marketIndex);

		// sol tanks 90%
		await driftClient.moveAmmToPrice(
			0,
			new BN(43.1337 * PRICE_PRECISION.toNumber()).div(new BN(10))
		);
		await setFeedPrice(anchor.workspace.Pyth, 43.1337 / 10, solOracle);
	});
	// return 0;

	it('put market in reduce only mode', async () => {
		const marketIndex = 0;
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

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

		await driftClient.fetchAccounts();
		console.log(
			'lastOraclePriceTwap:',
			market.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		assert(
			market.amm.historicalOracleData.lastOraclePriceTwap.eq(new BN(43133700))
		);

		// should fail
		try {
			await driftClientLoser.openPosition(
				PositionDirection.LONG,
				new BN(10000000),
				0,
				new BN(0)
			);
			console.log('risk increase trade succeed when it should have failed!');

			assert(false);
		} catch (e) {
			console.log(e);

			if (!e.toString().search('AnchorError occurred')) {
				assert(false);
			}
			console.log('risk increase trade failed');
		}

		await driftClientLoser.fetchAccounts();

		const loserUser0 = driftClientLoser.getUserAccount();
		console.log(loserUser0.perpPositions[0]);

		await driftClient.fetchAccounts();
		const marketBeforeReduceUser = driftClient.getPerpMarketAccount(0);
		console.log(
			'lastOraclePriceTwap:',
			marketBeforeReduceUser.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		assert(
			marketBeforeReduceUser.amm.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(43133700)
			)
		);
		// should succeed
		await driftClientLoser.openPosition(
			PositionDirection.SHORT,
			new BN(2000),
			0,
			new BN(0)
		);

		await driftClient.fetchAccounts();
		const marketBeforeReduceUser2 = driftClient.getPerpMarketAccount(0);
		console.log(
			'lastOraclePriceTwap:',
			marketBeforeReduceUser2.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		// assert(marketBeforeReduceUser2.amm.historicalOracleData.lastOraclePriceTwap.eq(new BN(28755800)))
		assert(
			marketBeforeReduceUser2.amm.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(19170534)
			)
		);
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

		const winningUserBefore = driftClient.getUserAccount();
		console.log(winningUserBefore.perpPositions[0]);
		const oraclePriceDataBefore = await getOraclePriceData(
			anchor.workspace.Pyth,
			solOracle
		);
		const beforeExpiryValue = calculateBaseAssetValueWithOracle(
			market0,
			winningUserBefore.perpPositions[0],
			oraclePriceDataBefore
		);

		// try {
		const txSig = await driftClient.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		await driftClient.fetchAccounts();

		const market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log('market.expiryPrice:', convertToNumber(market.expiryPrice));
		console.log(
			'market.amm.historicalOracleData.lastOraclePriceTwap:',
			convertToNumber(market.amm.historicalOracleData.lastOraclePriceTwap)
		);
		assert(
			market.amm.historicalOracleData.lastOraclePriceTwap.eq(new BN(12780356))
		);

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solOracle
		);
		assert(Math.abs(convertToNumber(oraclePriceData.price) - curPrice) < 1e-4);

		assert(market.expiryPrice.gt(ZERO));

		assert(market.amm.baseAssetAmountWithAmm.lt(ZERO));
		assert(oraclePriceData.price.lt(market.expiryPrice));
		assert(
			market.amm.historicalOracleData.lastOraclePriceTwap.lt(market.expiryPrice)
		);
		assert(
			market.expiryPrice.eq(
				market.amm.historicalOracleData.lastOraclePriceTwap.add(new BN(1))
			)
		);

		const winningUser = driftClient.getUserAccount();
		console.log(winningUser.perpPositions[0]);
		const afterExpiryValue = calculateBaseAssetValueWithOracle(
			market,
			winningUser.perpPositions[0],
			oraclePriceData
		);

		console.log(
			'user position value:',
			beforeExpiryValue.toString(),
			'->',
			afterExpiryValue.toString()
		);
		assert(beforeExpiryValue.lt(afterExpiryValue));
	});

	it('settle expired market position', async () => {
		const marketIndex = 0;
		await driftClientLoser.fetchAccounts();

		const loserUser0 = driftClientLoser.getUserAccount();
		console.log(loserUser0.perpPositions[0]);

		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));

		const txSig = await driftClientLoser.settlePNL(
			await driftClientLoser.getUserAccountPublicKey(),
			driftClientLoser.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		// const settleRecord = eventSubscriber.getEventsArray('SettlePnlRecord')[0];
		// console.log(settleRecord);

		await driftClientLoser.fetchAccounts();
		const loserUser = driftClientLoser.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(loserUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(loserUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = driftClient.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin0 = new BN(1000020719000 - 100090);
		console.log(marketAfter0.pnlPool.scaledBalance.toString());
		console.log(marketAfter0.pnlPool.scaledBalance.toString());
		console.log(marketAfter0.pnlPool.scaledBalance.toString());

		// console.log(
		// 	'lastFundingRateLong:',
		// 	marketAfter0.amm.lastFundingRateLong.toString()
		// );
		// console.log(
		// 	'lastFundingRateShort:',
		// 	marketAfter0.amm.lastFundingRateShort.toString()
		// );

		assert(marketAfter0.amm.lastFundingRateLong.toString() === '24205208');
		assert(marketAfter0.amm.lastFundingRateShort.toString() === '24205208');

		assert(marketAfter0.pnlPool.scaledBalance.gt(finalPnlResultMin0));
		assert(
			marketAfter0.pnlPool.scaledBalance.lt(new BN(1000020719000 + 1000000))
		);

		const txSig2 = await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig2);
		await driftClient.fetchAccounts();
		const winnerUser = driftClient.getUserAccount();
		// console.log(winnerUser.perpPositions[0]);
		assert(winnerUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		// assert(winnerUser.perpPositions[0].quoteAssetAmount.gt(new BN(0))); // todo they lose money too after fees

		// await driftClient.settlePNL(
		// 	await driftClientLoser.getUserAccountPublicKey(),
		// 	driftClientLoser.getUserAccount(),
		// 	marketIndex
		// );

		const marketAfter = driftClient.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin = new BN(969699125000 - 109000);
		console.log('pnlPool:', marketAfter.pnlPool.scaledBalance.toString());
		assert(marketAfter.pnlPool.scaledBalance.gt(finalPnlResultMin));
		assert(marketAfter.pnlPool.scaledBalance.lt(new BN(969699125000 + 109000)));

		console.log('feePool:', marketAfter.amm.feePool.scaledBalance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter.amm.totalExchangeFee.toString()
		);
		assert(marketAfter.amm.feePool.scaledBalance.eq(new BN(64700000)));

		// assert(marketAfter.amm.totalExchangeFee.eq(new BN(43134)));
		assert(marketAfter.amm.totalExchangeFee.eq(new BN(129401)));
	});

	it('put settle market pools to revenue pool', async () => {
		const marketIndex = 0;
		const marketBefore = driftClient.getPerpMarketAccount(marketIndex);
		const userCostBasisBefore = marketBefore.amm.quoteAssetAmount;

		console.log('userCostBasisBefore:', userCostBasisBefore.toString());
		assert(userCostBasisBefore.eq(new BN(-2))); // from LP burn

		await liquidatorDriftClient.settlePNL(
			await liquidatorDriftClient.getUserAccountPublicKey(),
			liquidatorDriftClient.getUserAccount(),
			marketIndex
		);

		await driftClient.fetchAccounts();
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const userCostBasis = market.amm.quoteAssetAmount;
		console.log('userCostBasis:', userCostBasis.toString());
		assert(userCostBasis.eq(ZERO)); // ready to settle expiration

		try {
			await driftClient.settleExpiredMarketPoolsToRevenuePool(marketIndex);
		} catch (e) {
			console.log('failed');
		}

		await driftClient.updateStateSettlementDuration(1000); // too far away
		try {
			await driftClient.settleExpiredMarketPoolsToRevenuePool(marketIndex);
		} catch (e) {
			console.log('failed');
		}

		await driftClient.updateStateSettlementDuration(1);
		await driftClient.settleExpiredMarketPoolsToRevenuePool(marketIndex);

		await driftClient.fetchAccounts();
		const marketAfter = driftClient.getPerpMarketAccount(marketIndex);

		console.log(
			marketAfter.amm.baseAssetReserve.toString(),
			marketAfter.amm.quoteAssetReserve.toString(),
			marketAfter.amm.sqrtK.toString(),
			marketAfter.amm.terminalQuoteAssetReserve.toString()
		);

		console.log(marketAfter.pnlPool.scaledBalance.toString());
		console.log(marketAfter.amm.feePool.scaledBalance.toString());
		assert(
			marketAfter.amm.feePool.scaledBalance
				.add(marketAfter.pnlPool.scaledBalance)
				.eq(ZERO)
		);

		const usdcMarket = driftClient.getQuoteSpotMarketAccount();
		console.log(usdcMarket.revenuePool.scaledBalance.toString());
		assert(usdcMarket.revenuePool.scaledBalance.gt(ZERO));
		assert(
			usdcMarket.revenuePool.scaledBalance.gt(new BN(969763827000 - 100000))
		);
		assert(
			usdcMarket.revenuePool.scaledBalance.lt(new BN(969763827000 + 100000))
		);

		console.log('works');
	});
});
