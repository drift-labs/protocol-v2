import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, ONE, OracleSource, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';
import {
	Admin,
	MARK_PRICE_PRECISION,
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

describe('prepeg', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

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

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.updateAuctionDuration(0, 0);

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

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Long from 0 position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450500000000);
		const market0 = clearingHouse.getMarketAccount(0);

		// await setFeedPrice(anchor.workspace.Pyth, 1.01, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
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
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		const txSig = await clearingHouse.placeAndTake(orderParams);

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

		console.log(
			clearingHouse.getUserAccount().positions[0].quoteAssetAmount.toString()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteEntryAmount.gt(new BN(49750001))
		);
		console.log(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.toString()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		console.log('sqrtK:', market.amm.sqrtK.toString());

		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(497450500000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(497450500000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.gt(new BN(49750)));
		assert.ok(market.amm.totalFeeMinusDistributions.gt(new BN(49750)));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(497450500000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.gt(new BN(49750001)));
		assert.ok(orderRecord.takerOrder.marketIndex.eq(marketIndex));
	});

	it('Long even more', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450503674885 / 50);
		const market0 = clearingHouse.getMarketAccount(0);

		await setFeedPrice(anchor.workspace.Pyth, 1.0281, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
		);

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
		console.log(prepegAMM.pegMultiplier.toString());
		assert(prepegAMM.pegMultiplier.eq(new BN(1005)));
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

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});

		const txSig = await clearingHouse.placeAndTake(orderParams);
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
			convertToNumber(market.amm.sqrtK),
			'/',
			convertToNumber(ask1),
			'after trade mark price:',
			convertToNumber(calculateMarkPrice(market, oraclePriceData))
		);
		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		console.log(market.amm.pegMultiplier.toString());
		assert(market.amm.pegMultiplier.eq(new BN(1005)));
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
		assert(actualDist.sub(estDist).abs().lte(new BN(4))); // cost is near equal
		assert(market.amm.sqrtK.lt(market0.amm.sqrtK)); // k was lowered

		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteEntryAmount.gt(new BN(49750001))
		);
		console.log(clearingHouse.getUserAccount().positions[0].baseAssetAmount);
	});

	it('Reduce long position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(248725250000000);
		const market0 = clearingHouse.getMarketAccount(0);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});

		await setFeedPrice(anchor.workspace.Pyth, 1.02234232, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
		);
		const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.SHORT,
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

		const txSig = await clearingHouse.placeAndTake(orderParams);
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

		console.log(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.toNumber()
		);

		console.log(market.amm.netBaseAssetAmount.toString());

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(248725250000000)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Many market balanced prepegs, long position', async () => {
		for (let i = 1; i <= 4; i++) {
			const thisUsd = mockOracles[i];
			const marketIndex = new BN(i);
			const baseAssetAmount = new BN(31.02765 * 10e13);
			const market0 = clearingHouse.getMarketAccount(i);
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
			try {
				const txSig = await clearingHouse.placeAndTake(orderParams);
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
			} catch (e) {
				console.error(e);
				assert(false);
			}

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

	it('Many market expensive prepeg margin', async () => {
		const user = clearingHouse.getUserAccount();

		// todo cheapen margin peg enough to make this work w/ 5 positions
		for (let i = 1; i <= 4; i++) {
			console.log(
				'user market',
				user.positions[i].marketIndex.toString(),
				' base position',
				'=',
				user.positions[i].baseAssetAmount.toNumber() / 1e13
			);
			const thisUsd = mockOracles[i];
			const curPrice = (await getFeedData(anchor.workspace.Pyth, thisUsd))
				.price;
			await setFeedPrice(anchor.workspace.Pyth, curPrice * 1.03, thisUsd);
		}
		const curPrice = (await getFeedData(anchor.workspace.Pyth, mockOracles[0]))
			.price;
		await setFeedPrice(anchor.workspace.Pyth, curPrice * 1.01, mockOracles[0]);

		const orderParams = getMarketOrderParams({
			marketIndex: new BN(0),
			direction: PositionDirection.SHORT,
			baseAssetAmount: user.positions[0].baseAssetAmount.div(new BN(2)),
		});

		const txSig = await clearingHouse.placeAndTake(orderParams);
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
	});
});
