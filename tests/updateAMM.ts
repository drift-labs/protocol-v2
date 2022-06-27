import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, OracleSource, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';

// import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	calculateMarkPrice,
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
	initializeQuoteAssetBank,
} from './testHelpers';

describe('update amm', () => {
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
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10000 * 10 ** 6);

	let marketIndexes;
	let bankIndexes;
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

		bankIndexes = [new BN(0)];
		marketIndexes = mockOracles.map((_, i) => new BN(i));
		oracleInfos = mockOracles.map((oracle) => {
			return { publicKey: oracle, source: OracleSource.PYTH };
		});

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);

		await clearingHouse.initialize(usdcMint.publicKey, true);

		await clearingHouse.subscribe();
		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(1_000),
			undefined,
			1000
		);
		await clearingHouse.updateMarketBaseSpread(new BN(0), 2000);
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

	it('update AMM (balanced)', async () => {
		// console.log('hi');
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(
			(49.7450503674885 * AMM_RESERVE_PRECISION.toNumber()) / 50
		);
		const market0 = clearingHouse.getMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.003, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
		);

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
		console.log(prepegAMM.pegMultiplier.toString());
		assert(prepegAMM.pegMultiplier.eq(new BN(1003)));
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
		const txSig = await clearingHouse.updateAMMs([marketIndex]);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
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
		const market = clearingHouse.getMarketAccount(0);
		const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
		console.log(
			'after trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'after trade mark price:',
			convertToNumber(calculateMarkPrice(market, oraclePriceData))
		);
		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		console.log(market.amm.pegMultiplier.toString());
		assert(market.amm.pegMultiplier.eq(new BN(1003)));
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

	it('Many market balanced prepegs, long position', async () => {
		for (let i = 0; i <= 4; i++) {
			const thisUsd = mockOracles[i];
			const marketIndex = new BN(i);
			const baseAssetAmount = new BN(
				31.02765 * AMM_RESERVE_PRECISION.toNumber()
			);
			const market0 = clearingHouse.getMarketAccount(i);
			const orderParams = getMarketOrderParams(
				marketIndex,
				PositionDirection.LONG,
				ZERO,
				baseAssetAmount,
				false
			);

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
			const txSig = await clearingHouse.updateAndPlaceAndFillOrder(orderParams);
			const computeUnits = await findComputeUnitConsumption(
				clearingHouse.program.programId,
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

			const market = clearingHouse.getMarketAccount(i);
			const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
			console.log(
				'after trade bid/ask:',
				convertToNumber(bid1),
				'/',
				convertToNumber(ask1),
				'after trade mark price:',
				convertToNumber(calculateMarkPrice(market, oraclePriceData))
			);
			console.log('----');
		}
	});

	it('update AMM (unbalanced)', async () => {
		// console.log('hi');
		// const marketIndex = new BN(0);
		// const baseAssetAmount = new BN(497450503674885 / 50);

		const prepegAMMs = [];
		const market0s = [];

		for (let i = 0; i <= 4; i++) {
			const thisUsd = mockOracles[i];
			const marketIndex = new BN(i);
			const market0 = clearingHouse.getMarketAccount(marketIndex);
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

		// bulk market update number 1
		// const txSig = await clearingHouse.updateAMMs([
		// 	new BN(0),
		// 	new BN(1),
		// 	new BN(2),
		// 	// new BN(3),
		// 	// new BN(4),
		// ]);
		// const computeUnits = await findComputeUnitConsumption(
		// 	clearingHouse.program.programId,
		// 	connection,
		// 	txSig,
		// 	'confirmed'
		// );

		// console.log(
		// 	'tx logs',
		// 	(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
		// 		.logMessages
		// );
		// console.log('compute units', computeUnits);
		// assert(computeUnits[0] < 200000);
		// // TODO bulk market update number 2
		// const txSig2 = await clearingHouse.updateAMMs([
		// 	// new BN(0),
		// 	// new BN(1),
		// 	// new BN(2),
		// 	new BN(3),
		// 	new BN(4),
		// ]);
		// const computeUnits2 = await findComputeUnitConsumption(
		// 	clearingHouse.program.programId,
		// 	connection,
		// 	txSig,
		// 	'confirmed'
		// );
		// console.log('compute units', computeUnits2);
		// assert(computeUnits2[0] < 200000);
		// console.log(
		// 	'tx logs',
		// 	(await connection.getTransaction(txSig2, { commitment: 'confirmed' }))
		// 		.meta.logMessages
		// );

		const orderParams = getMarketOrderParams(
			new BN(4),
			PositionDirection.SHORT,
			ZERO,
			AMM_RESERVE_PRECISION,
			false
		);
		const txSig3 = await clearingHouse.updateAndPlaceAndFillOrder(orderParams);
		// const computeUnits3 = await findComputeUnitConsumption(
		// 	clearingHouse.program.programId,
		// 	connection,
		// 	txSig3,
		// 	'confirmed'
		// );
		// console.log('compute units', computeUnits3);
		// assert(computeUnits3[0] < 400000);
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
			const market = clearingHouse.getMarketAccount(i);
			const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
			console.log(
				'after trade bid/ask:',
				convertToNumber(bid1),
				'/',
				convertToNumber(ask1),
				'after trade mark price:',
				convertToNumber(calculateMarkPrice(market, oraclePriceData))
			);
			assert(bid1.lt(ask1));
			assert(ask1.gt(oraclePriceData.price));
			assert(bid1.lt(oraclePriceData.price));

			const prepegAMM = prepegAMMs[i];
			const market0 = market0s[i];

			console.log(market.amm.pegMultiplier.toString());
			assert(market.amm.pegMultiplier.gt(market0.amm.pegMultiplier));
			// assert(market.amm.pegMultiplier.eq(new BN(1006)));
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
			assert(market.amm.sqrtK.lt(market0.amm.sqrtK)); // k was lowered
		}
	});
});
