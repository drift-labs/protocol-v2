import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	BulkAccountLoader,
	getMarketOrderParams,
	OracleSource,
	PEG_PRECISION,
} from '../sdk';

import { Program } from '@coral-xyz/anchor';

import {
	TestClient,
	PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	calculateReservePrice,
	OracleGuardRails,
	calculateTradeSlippage,
	PositionDirection,
	EventSubscriber,
	convertToNumber,
	findComputeUnitConsumption,
	calculateBidAskPrice,
	calculateUpdatedAMM,
} from '../sdk/src';

import {
	getFeedData,
	// initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	getOraclePriceData,
	initializeQuoteSpotMarket,
} from './testHelpers';

async function feePoolInjection(fees, marketIndex, driftClient) {
	let market0 = driftClient.getPerpMarketAccount(marketIndex);
	await driftClient.updatePerpMarketCurveUpdateIntensity(marketIndex, 0);
	const connection = anchor.AnchorProvider.local().connection;

	while (market0.amm.totalFeeMinusDistributions.lt(fees)) {
		const reservePrice = calculateReservePrice(
			market0,
			driftClient.getOracleDataForPerpMarket(marketIndex)
		);
		const baseAmountToTrade = new BN(9000)
			.mul(PRICE_PRECISION)
			.mul(BASE_PRECISION)
			.div(reservePrice);
		const tx = await driftClient.openPosition(
			PositionDirection.LONG,
			baseAmountToTrade,
			marketIndex
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(tx, { commitment: 'confirmed' })).meta
				.logMessages
		);

		// try to cancel remaining order
		try {
			await driftClient.cancelOrder();
		} catch (e) {
			console.error(e);
		}

		await driftClient.closePosition(marketIndex);
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		market0 = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			market0.amm.totalFeeMinusDistributions.toString(),
			'<',
			fees.toString()
		);
	}

	await driftClient.updatePerpMarketCurveUpdateIntensity(marketIndex, 100);
}

describe('update amm', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
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

	// let userAccountPublicKey: PublicKeys;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetAmount = new anchor.BN(9)
		.mul(AMM_RESERVE_PRECISION)
		.mul(AMM_RESERVE_PRECISION);
	const ammInitialBaseAssetAmount = new anchor.BN(9)
		.mul(AMM_RESERVE_PRECISION)
		.mul(AMM_RESERVE_PRECISION);

	const usdcAmount = new BN(10000 * 10 ** 6);

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;
	let solUsd;
	const mockOracles = [];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		mockOracles.push(solUsd);
		for (let i = 1; i <= 4; i++) {
			// init more oracles
			const thisUsd = await mockOracle(i);
			mockOracles.push(thisUsd);
		}

		spotMarketIndexes = [0];
		marketIndexes = mockOracles.map((_, i) => i);
		oracleInfos = mockOracles.map((oracle) => {
			return { publicKey: oracle, source: OracleSource.PYTH };
		});

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos: oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.updatePerpAuctionDuration(0);

		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(1 * PEG_PRECISION.toNumber()),
			undefined,
			1000
		);
		await driftClient.updatePerpMarketBaseSpread(0, 2000);
		await driftClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		for (let i = 1; i <= 4; i++) {
			// init more markets
			const thisUsd = mockOracles[i];
			await driftClient.initializePerpMarket(
				i,
				thisUsd,
				ammInitialBaseAssetAmount,
				ammInitialQuoteAssetAmount,
				periodicity,
				new BN(i * PEG_PRECISION.toNumber()),
				undefined,
				1000
			);
			await driftClient.updatePerpMarketBaseSpread(i, 2000);
			await driftClient.updatePerpMarketCurveUpdateIntensity(i, 100);
		}

		const [, _userAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('update AMM (balanced) move peg up to oracle', async () => {
		// console.log('hi');
		const marketIndex = 0;
		const baseAssetAmount = new BN(
			(49.7450503674885 * AMM_RESERVE_PRECISION.toNumber()) / 50
		);
		const market0 = driftClient.getPerpMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.003, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
		);

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
		const expectedPeg = new BN(1002999);
		console.log(
			prepegAMM.pegMultiplier.toString(),
			'==',
			expectedPeg.toString()
		);
		assert(prepegAMM.pegMultiplier.eq(expectedPeg));
		const estDist = prepegAMM.totalFee.sub(
			prepegAMM.totalFeeMinusDistributions
		);
		console.log('est distribution:', estDist.toString());

		const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.LONG,
				baseAssetAmount,
				market0,
				'base',
				oraclePriceData
			);
		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

		console.log(
			'bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'after trade est. mark price:',
			convertToNumber(newPrice)
		);
		const txSig = await driftClient.updateAMMs([marketIndex]);
		const computeUnits = await findComputeUnitConsumption(
			driftClient.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const market = driftClient.getPerpMarketAccount(0);
		const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
		console.log(
			'after trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'after trade mark price:',
			convertToNumber(calculateReservePrice(market, oraclePriceData))
		);
		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		const expectedPeg2 = new BN(1.003 * PEG_PRECISION.toNumber());
		console.log(
			prepegAMM.pegMultiplier.toString(),
			'==',
			expectedPeg2.toString()
		);
		assert(market.amm.pegMultiplier.eq(expectedPeg2));

		const actualDist = market.amm.totalFee.sub(
			market.amm.totalFeeMinusDistributions
		);
		console.log('actual distribution:', actualDist.toString());

		console.log(prepegAMM.sqrtK.toString(), '==', market.amm.sqrtK.toString());
		const marketInvariant = market.amm.sqrtK.mul(market.amm.sqrtK);

		// check k math good
		assert(
			marketInvariant
				.div(market.amm.baseAssetReserve)
				.eq(market.amm.quoteAssetReserve)
		);
		assert(
			marketInvariant
				.div(market.amm.quoteAssetReserve)
				.eq(market.amm.baseAssetReserve)
		);

		// check prepeg and post trade worked as expected
		assert(prepegAMM.sqrtK.eq(market.amm.sqrtK)); // predicted k = post trade k
		assert(actualDist.sub(estDist).abs().lte(new BN(1))); // cost is near equal
		assert(market.amm.sqrtK.eq(market0.amm.sqrtK)); // k was same
	});

	it('update AMM (balanced) move peg down to oracle', async () => {
		// console.log('hi');
		const marketIndex = 1;
		const baseAssetAmount = new BN(
			(49.7450503674885 * AMM_RESERVE_PRECISION.toNumber()) / 50
		);
		const market0 = driftClient.getPerpMarketAccount(1);
		await setFeedPrice(anchor.workspace.Pyth, 0.9378, mockOracles[1]);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, mockOracles[1]))
			.price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			mockOracles[1]
		);

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
		console.log(prepegAMM.pegMultiplier.toString());
		assert(
			prepegAMM.pegMultiplier.eq(new BN(0.9378 * PEG_PRECISION.toNumber()))
		);
		const estDist = prepegAMM.totalFee.sub(
			prepegAMM.totalFeeMinusDistributions
		);
		console.log('est distribution:', estDist.toString());

		const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.LONG,
				baseAssetAmount,
				market0,
				'base',
				oraclePriceData
			);
		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

		console.log(
			'bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'after trade est. mark price:',
			convertToNumber(newPrice)
		);
		const txSig = await driftClient.updateAMMs([marketIndex]);
		const computeUnits = await findComputeUnitConsumption(
			driftClient.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const market = driftClient.getPerpMarketAccount(1);
		const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
		console.log(
			'after trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'after trade mark price:',
			convertToNumber(calculateReservePrice(market, oraclePriceData))
		);
		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		const expectedPeg2 = new BN(0.9378 * PEG_PRECISION.toNumber());
		console.log(
			market.amm.pegMultiplier.toString(),
			'==',
			expectedPeg2.toString()
		);
		assert(market.amm.pegMultiplier.eq(expectedPeg2));

		const actualDist = market.amm.totalFee.sub(
			market.amm.totalFeeMinusDistributions
		);
		console.log('actual distribution:', actualDist.toString());

		console.log(prepegAMM.sqrtK.toString(), '==', market.amm.sqrtK.toString());
		const marketInvariant = market.amm.sqrtK.mul(market.amm.sqrtK);

		// check k math good
		assert(
			marketInvariant
				.div(market.amm.baseAssetReserve)
				.eq(market.amm.quoteAssetReserve)
		);
		assert(
			marketInvariant
				.div(market.amm.quoteAssetReserve)
				.eq(market.amm.baseAssetReserve)
		);

		// check prepeg and post trade worked as expected
		assert(prepegAMM.sqrtK.eq(market.amm.sqrtK)); // predicted k = post trade k
		assert(actualDist.sub(estDist).abs().lte(new BN(1))); // cost is near equal
		assert(market.amm.sqrtK.eq(market0.amm.sqrtK)); // k was same
	});

	it('update AMM (imbalanced, oracle > peg, sufficient fees)', async () => {
		const marketIndex = 1;

		await feePoolInjection(
			new BN(250 * QUOTE_PRECISION.toNumber()),
			1,
			driftClient
		);
		const market = driftClient.getPerpMarketAccount(marketIndex);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			mockOracles[marketIndex]
		);

		const baseAssetAmount = new BN(1.02765 * AMM_RESERVE_PRECISION.toNumber());
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.LONG,
				baseAssetAmount,
				market,
				'base',
				oraclePriceData
			);

		const [bid, ask] = calculateBidAskPrice(market.amm, oraclePriceData);

		console.log(
			'bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'after trade est. mark price:',
			convertToNumber(newPrice)
		);
		let txSig;
		try {
			txSig = await driftClient.placeAndTakePerpOrder(orderParams);
		} catch (e) {
			console.error(e);
		}

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await setFeedPrice(anchor.workspace.Pyth, 1.9378, mockOracles[marketIndex]);
		const curPrice = (
			await getFeedData(anchor.workspace.Pyth, mockOracles[marketIndex])
		).price;
		console.log('new oracle price:', curPrice);

		const _txSig2 = await driftClient.updateAMMs([marketIndex]);
		const market2 = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market2.amm.pegMultiplier = ',
			market2.amm.pegMultiplier.toString()
		);
		assert(market2.amm.pegMultiplier.eq(new BN(1937799)));
		assert(
			market2.amm.totalFeeMinusDistributions.gte(
				market.amm.totalFeeMinusDistributions.div(new BN(2))
			)
		);
	});

	it('Many market balanced prepegs, long position', async () => {
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(1000000),
				oracleTwap5MinPercentDivergence: new BN(1000000),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(1000),
			},
			useForLiquidations: false,
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		for (let i = 0; i <= 4; i++) {
			const thisUsd = mockOracles[i];
			const marketIndex = i;
			const baseAssetAmount = new BN(
				31.02765 * AMM_RESERVE_PRECISION.toNumber()
			);
			const market0 = driftClient.getPerpMarketAccount(i);
			const orderParams = getMarketOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
			});

			const curPrice = (await getFeedData(anchor.workspace.Pyth, thisUsd))
				.price;
			console.log('new oracle price:', curPrice);
			const oraclePriceData = await getOraclePriceData(
				anchor.workspace.Pyth,
				thisUsd
			);
			const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
				calculateTradeSlippage(
					PositionDirection.LONG,
					baseAssetAmount,
					market0,
					'base',
					oraclePriceData
				);

			const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

			console.log(
				'bid/ask:',
				convertToNumber(bid),
				'/',
				convertToNumber(ask),
				'after trade est. mark price:',
				convertToNumber(newPrice)
			);
			let txSig;
			try {
				txSig = await driftClient.placeAndTakePerpOrder(orderParams);
			} catch (e) {
				console.error(e);
			}
			const computeUnits = await findComputeUnitConsumption(
				driftClient.program.programId,
				connection,
				txSig,
				'confirmed'
			);
			console.log('compute units', computeUnits);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);

			const market = driftClient.getPerpMarketAccount(i);
			const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
			console.log(
				'after trade bid/ask:',
				convertToNumber(bid1),
				'/',
				convertToNumber(ask1),
				'after trade mark price:',
				convertToNumber(calculateReservePrice(market, oraclePriceData))
			);
			console.log('----');
		}
	});

	it('update AMMs (unbalanced, oracle > peg, cost > 0 and insufficient fees)', async () => {
		const prepegAMMs = [];
		const market0s = [];

		const tradeDirection = PositionDirection.SHORT;
		const tradeSize = AMM_RESERVE_PRECISION;
		for (let i = 0; i <= 4; i++) {
			const thisUsd = mockOracles[i];
			const marketIndex = i;
			const market0 = driftClient.getPerpMarketAccount(marketIndex);
			market0s.push(market0);
			const curPrice = (await getFeedData(anchor.workspace.Pyth, thisUsd))
				.price;

			await setFeedPrice(anchor.workspace.Pyth, curPrice * 1.02, thisUsd);
			const newPrice = (await getFeedData(anchor.workspace.Pyth, thisUsd))
				.price;

			// const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
			console.log('new oracle price:', newPrice);

			const oraclePriceData = await getOraclePriceData(
				anchor.workspace.Pyth,
				thisUsd
			);

			const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
			prepegAMMs.push(prepegAMM);
			console.log('market', i, ':', prepegAMM.pegMultiplier.toString());
			// assert(prepegAMM.pegMultiplier.eq(new BN(1006)));
			const estDist = prepegAMM.totalFee.sub(
				prepegAMM.totalFeeMinusDistributions
			);
			console.log('est distribution:', estDist.toString());

			// const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			// 	calculateTradeSlippage(
			// 		PositionDirection.LONG,
			// 		baseAssetAmount,
			// 		market0,
			// 		'base',
			// 		oraclePriceData
			// 	);
			const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

			console.log(
				'bid/ask:',
				convertToNumber(bid),
				'/',
				convertToNumber(ask)
				// 'after trade est. mark price:',
				// convertToNumber(newPrice)
			);
		}

		const orderParams = getMarketOrderParams({
			marketIndex: 4,
			direction: tradeDirection,
			baseAssetAmount: tradeSize,
		});

		const txSig21 = await driftClient.updateAMMs([0, 1, 2, 3]);
		const computeUnits21 = await findComputeUnitConsumption(
			driftClient.program.programId,
			connection,
			txSig21,
			'confirmed'
		);
		console.log(computeUnits21);

		const txSig3 = await driftClient.placeAndTakePerpOrder(orderParams);
		await driftClient.fetchAccounts();

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig3, { commitment: 'confirmed' }))
				.meta.logMessages
		);

		// check if markets were updated as expected
		for (let i = 0; i <= 4; i++) {
			const thisUsd = mockOracles[i];
			const oraclePriceData = await getOraclePriceData(
				anchor.workspace.Pyth,
				thisUsd
			);
			const market = driftClient.getPerpMarketAccount(i);
			const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
			console.log(
				'after trade bid/ask:',
				convertToNumber(bid1),
				'/',
				convertToNumber(ask1),
				'after trade mark price:',
				convertToNumber(calculateReservePrice(market, oraclePriceData))
			);
			assert(bid1.lt(ask1));
			assert(ask1.gt(oraclePriceData.price));
			assert(bid1.lt(oraclePriceData.price));

			const prepegAMM = prepegAMMs[i];
			const market0 = market0s[i];

			if (i == 0) {
				assert(
					market.amm.pegMultiplier.eq(
						new BN(1.01356 * PEG_PRECISION.toNumber())
					)
				);
			} else if (i == 1) {
				assert(
					market.amm.pegMultiplier.eq(
						new BN(1.976555 * PEG_PRECISION.toNumber())
					)
				);
			} else if (i == 2) {
				assert(market.amm.pegMultiplier.eq(new BN(2021060)));
			} else if (i == 3) {
				assert(
					market.amm.pegMultiplier.eq(
						new BN(3.03159 * PEG_PRECISION.toNumber())
					)
				);
			} else if (i == 4) {
				console.log(market.amm.pegMultiplier.toString());
				assert(market.amm.pegMultiplier.eq(new BN(4042120)));
			}

			assert(market.amm.pegMultiplier.gt(market0.amm.pegMultiplier));
			const actualDist = market.amm.totalFee.sub(
				market.amm.totalFeeMinusDistributions
			);
			console.log('actual distribution:', actualDist.toString());

			console.log(
				prepegAMM.sqrtK.toString(),
				'==',
				market.amm.sqrtK.toString()
			);
			const marketInvariant = market.amm.sqrtK.mul(market.amm.sqrtK);

			// check k math good
			// TODO can be off by 1?
			console.log(
				marketInvariant.div(market.amm.baseAssetReserve).toString(),

				'==',

				market.amm.quoteAssetReserve.toString()
			);
			assert(
				marketInvariant
					.div(market.amm.baseAssetReserve)
					.sub(market.amm.quoteAssetReserve)
					.abs()
					.lte(new BN(1))
			);
			console.log(
				marketInvariant.div(market.amm.quoteAssetReserve).toString(),

				'==',

				market.amm.baseAssetReserve.toString()
			);
			assert(
				marketInvariant
					.div(market.amm.quoteAssetReserve)
					.sub(market.amm.baseAssetReserve)
					.abs()
					.lte(new BN(1))
			);

			const estDist = prepegAMM.totalFee.sub(
				prepegAMM.totalFeeMinusDistributions
			);
			console.log('estDist:', estDist.toString());
			// check prepeg and post trade worked as expected
			assert(prepegAMM.sqrtK.eq(market.amm.sqrtK)); // predicted k = post trade k

			// TODO: fix est cost rounding
			assert(
				actualDist
					.sub(estDist)
					.abs()
					.lte(market0.amm.pegMultiplier.sub(market.amm.pegMultiplier).abs())
			); // cost is near equal

			assert(prepegAMM.pegMultiplier.eq(market.amm.pegMultiplier));

			if (i != 1) {
				assert(market.amm.sqrtK.lt(market0.amm.sqrtK)); // k was lowered
			}
		}
	});
});
