import * as web3 from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert } from 'chai';

import {
	TestClient,
	QUOTE_PRECISION,
	EventSubscriber,
	PRICE_PRECISION,
	PositionDirection,
	ZERO,
	BN,
	calculateAmmReservesAfterSwap,
	calculatePrice,
	User,
	OracleSource,
	SwapDirection,
	Wallet,
	LPRecord,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleGuardRails,
	PostOnlyParams,
	BulkAccountLoader,
	isVariant,
	calculateBidAskPrice,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	// sleep,
} from './testHelpers';

let lastOrderRecordsLength = 0;

async function adjustOraclePostSwap(baa, swapDirection, market) {
	const price = calculatePrice(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);

	const [newQaa, newBaa] = calculateAmmReservesAfterSwap(
		market.amm,
		'base',
		baa.abs(),
		swapDirection
	);

	const newPrice = calculatePrice(newBaa, newQaa, market.amm.pegMultiplier);
	const _newPrice = newPrice.toNumber() / PRICE_PRECISION.toNumber();
	await setFeedPrice(anchor.workspace.Pyth, _newPrice, market.amm.oracle);

	console.log('price => new price', price.toString(), newPrice.toString());

	return _newPrice;
}

async function createNewUser(
	program,
	provider,
	usdcMint,
	usdcAmount,
	oracleInfos,
	wallet,
	bulkAccountLoader
) {
	let walletFlag = true;
	if (wallet == undefined) {
		const kp = new web3.Keypair();
		const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 ** 9);
		await provider.connection.confirmTransaction(sig);
		wallet = new Wallet(kp);
		walletFlag = false;
	}

	console.log('wallet:', walletFlag);
	const usdcAta = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		provider,
		wallet.publicKey
	);

	const driftClient = new TestClient({
		connection: provider.connection,
		wallet: wallet,
		programID: program.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: [0, 1, 2, 3],
		spotMarketIndexes: [0],
		oracleInfos,
		accountSubscription: bulkAccountLoader
			? {
					type: 'polling',
					accountLoader: bulkAccountLoader,
			  }
			: {
					type: 'websocket',
			  },
	});

	if (walletFlag) {
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	} else {
		await driftClient.subscribe();
	}

	await driftClient.initializeUserAccountAndDepositCollateral(
		usdcAmount,
		usdcAta.publicKey
	);

	const driftClientUser = new User({
		driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
	});
	driftClientUser.subscribe();

	return [driftClient, driftClientUser];
}

describe('lp jit', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	async function _viewLogs(txsig) {
		const tx = await connection.getTransaction(txsig, {
			commitment: 'confirmed',
		});
		console.log('tx logs', tx.meta.logMessages);
	}
	async function delay(time) {
		await new Promise((resolve) => setTimeout(resolve, time));
	}

	// ammInvariant == k == x * y
	const ammInitialBaseAssetReserve = new BN(300).mul(BASE_PRECISION);
	const ammInitialQuoteAssetReserve = new BN(300).mul(BASE_PRECISION);

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const stableAmmInitialQuoteAssetReserve =
		BASE_PRECISION.mul(mantissaSqrtScale);
	const stableAmmInitialBaseAssetReserve =
		BASE_PRECISION.mul(mantissaSqrtScale);

	const usdcAmount = new BN(1_000_000_000 * 1e6); // 1 milli

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint: web3.Keypair;

	let driftClientUser: User;
	let traderDriftClient: TestClient;
	let traderDriftClientUser: User;

	let poorDriftClient: TestClient;
	let poorDriftClientUser: User;

	let solusdc;
	let solusdc2;
	let solusdc3;
	let btcusdc;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		solusdc3 = await mockOracle(1, -7); // make invalid
		solusdc2 = await mockOracle(1, -7); // make invalid
		solusdc = await mockOracle(1, -7); // make invalid
		btcusdc = await mockOracle(26069, -7);

		const oracleInfos = [
			{ publicKey: solusdc, source: OracleSource.PYTH },
			{ publicKey: solusdc2, source: OracleSource.PYTH },
			{ publicKey: solusdc3, source: OracleSource.PYTH },
			{ publicKey: btcusdc, source: OracleSource.PYTH },
		];

		[driftClient, driftClientUser] = await createNewUser(
			chProgram,
			provider,
			usdcMint,
			usdcAmount,
			oracleInfos,
			provider.wallet,
			bulkAccountLoader
		);
		// used for trading / taking on baa
		await driftClient.initializePerpMarket(
			0,
			solusdc,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(60 * 60)
		);
		await driftClient.updateLpCooldownTime(new BN(0));
		await driftClient.updatePerpMarketMaxFillReserveFraction(0, 1);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(10),
				slotsBeforeStaleForMargin: new BN(10),
				confidenceIntervalMaxSize: new BN(100),
				tooVolatileRatio: new BN(100),
			},
		};
		await driftClient.updateOracleGuardRails(oracleGuardRails);

		// await driftClient.updateMarketBaseAssetAmountStepSize(
		// 	new BN(0),
		// 	new BN(1)
		// );

		// second market -- used for funding ..
		await driftClient.initializePerpMarket(
			1,
			solusdc2,
			stableAmmInitialBaseAssetReserve,
			stableAmmInitialQuoteAssetReserve,
			new BN(0)
		);
		await driftClient.updateLpCooldownTime(new BN(0));
		await driftClient.updatePerpAuctionDuration(new BN(0));

		// third market
		await driftClient.initializePerpMarket(
			2,
			solusdc3,
			stableAmmInitialBaseAssetReserve,
			stableAmmInitialQuoteAssetReserve,
			new BN(0)
		);

		// third market
		await driftClient.initializePerpMarket(
			3,
			btcusdc,
			stableAmmInitialBaseAssetReserve.div(new BN(1000)),
			stableAmmInitialQuoteAssetReserve.div(new BN(1000)),
			new BN(0),
			new BN(26690 * 1000)
		);
		await driftClient.updateLpCooldownTime(new BN(0));
		await driftClient.updatePerpAuctionDuration(new BN(0));

		[traderDriftClient, traderDriftClientUser] = await createNewUser(
			chProgram,
			provider,
			usdcMint,
			usdcAmount,
			oracleInfos,
			undefined,
			bulkAccountLoader
		);
		[poorDriftClient, poorDriftClientUser] = await createNewUser(
			chProgram,
			provider,
			usdcMint,
			QUOTE_PRECISION.mul(new BN(10000)),
			oracleInfos,
			undefined,
			bulkAccountLoader
		);
	});

	after(async () => {
		await eventSubscriber.unsubscribe();

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();

		await traderDriftClient.unsubscribe();
		await traderDriftClientUser.unsubscribe();

		await poorDriftClient.unsubscribe();
		await poorDriftClientUser.unsubscribe();
	});

	const lpCooldown = 1;
	it('perp jit check (amm jit intensity = 0)', async () => {
		const marketIndex = 0;
		console.log('adding liquidity...');
		await driftClient.updatePerpMarketTargetBaseAssetAmountPerLp(
			0,
			BASE_PRECISION.toNumber()
		);

		await driftClient.fetchAccounts();
		let market = driftClient.getPerpMarketAccount(0);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('300000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		const _sig = await driftClient.addPerpLpShares(
			new BN(100 * BASE_PRECISION.toNumber()),
			market.marketIndex
		);
		await delay(lpCooldown + 1000);
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(0);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('400000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		let user = await driftClientUser.getUserAccount();
		assert(user.perpPositions[0].lpShares.toString() == '100000000000'); // 10 * 1e9

		// lp goes long
		const tradeSize = new BN(5 * BASE_PRECISION.toNumber());
		try {
			await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
			const _txsig = await driftClient.openPosition(
				PositionDirection.LONG,
				tradeSize,
				market.marketIndex
				// new BN(100 * BASE_PRECISION.toNumber())
			);
			await _viewLogs(_txsig);
		} catch (e) {
			console.log(e);
		}
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(0);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-12500000')));

		// some user goes long (lp should get a short + pnl for closing long on settle)
		try {
			await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
			const _txsig = await traderDriftClient.openPosition(
				PositionDirection.LONG,
				tradeSize,
				market.marketIndex
				// new BN(100 * BASE_PRECISION.toNumber())
			);
			await _viewLogs(_txsig);
		} catch (e) {
			console.log(e);
		}
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(0);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-25000000')));
		console.log(
			'market.amm.baseAssetAmountWithAmm:',
			market.amm.baseAssetAmountWithAmm.toString()
		);
		assert(market.amm.baseAssetAmountWithAmm.eq(new BN('7500000000')));

		// add jit maker going other way
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: tradeSize,
			price: new BN(0.9 * PRICE_PRECISION.toNumber()),
			auctionStartPrice: new BN(0.99 * PRICE_PRECISION.toNumber()),
			auctionEndPrice: new BN(0.929 * PRICE_PRECISION.toNumber()),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await traderDriftClient.placePerpOrder(takerOrderParams);
		await traderDriftClient.fetchAccounts();
		const order = traderDriftClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: tradeSize,
			price: new BN(1.011 * PRICE_PRECISION.toNumber()),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const txSig = await poorDriftClient.placeAndMakePerpOrder(
			makerOrderParams,
			{
				taker: await traderDriftClient.getUserAccountPublicKey(),
				order: traderDriftClient.getOrderByUserId(1),
				takerUserAccount: traderDriftClient.getUserAccount(),
				takerStats: traderDriftClient.getUserStatsAccountPublicKey(),
			}
		);
		await _viewLogs(txSig);
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(0);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-12500000')));
		console.log(
			'market.amm.baseAssetAmountWithAmm:',
			market.amm.baseAssetAmountWithAmm.toString()
		);
		assert(market.amm.baseAssetAmountWithAmm.eq(new BN('3750000000')));
		console.log(
			'market.amm.baseAssetAmountWithUnsettledLp:',
			market.amm.baseAssetAmountWithUnsettledLp.toString()
		);

		assert(market.amm.baseAssetAmountWithUnsettledLp.eq(new BN('1250000000')));

		const trader = await traderDriftClient.getUserAccount();
		console.log(
			'trader size',
			trader.perpPositions[0].baseAssetAmount.toString()
		);

		await driftClientUser.fetchAccounts();
		const sdkPnl = driftClientUser.getSettledLPPosition(0)[2];

		console.log('settling...');
		try {
			const _txsigg = await driftClient.settleLP(
				await driftClient.getUserAccountPublicKey(),
				0
			);
			await _viewLogs(_txsigg);
		} catch (e) {
			console.log(e);
		}
		user = await await driftClientUser.getUserAccount();

		const settleLiquidityRecord: LPRecord =
			eventSubscriber.getEventsArray('LPRecord')[0];

		console.log(
			'settle pnl vs sdk',
			settleLiquidityRecord.pnl.toString(),
			sdkPnl.toString()
		);
		assert(settleLiquidityRecord.pnl.eq(sdkPnl));
	});
	it('perp jit check (amm jit intensity = 100)', async () => {
		const marketIndex = 1;
		await driftClient.updateAmmJitIntensity(marketIndex, 100);

		console.log('adding liquidity...');
		await driftClient.updatePerpMarketTargetBaseAssetAmountPerLp(
			marketIndex,
			BASE_PRECISION.toNumber()
		);

		await driftClient.fetchAccounts();
		let market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('1000000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		const _sig = await driftClient.addPerpLpShares(
			new BN(100 * BASE_PRECISION.toNumber()),
			market.marketIndex
		);
		await delay(lpCooldown + 1000);
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('1100000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		let user = await driftClientUser.getUserAccount();
		assert(user.perpPositions[0].lpShares.toString() == '100000000000'); // 10 * 1e9

		// lp goes long
		const tradeSize = new BN(5 * BASE_PRECISION.toNumber());
		try {
			await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
			const _txsig = await driftClient.openPosition(
				PositionDirection.LONG,
				tradeSize,
				market.marketIndex
				// new BN(100 * BASE_PRECISION.toNumber())
			);
			await _viewLogs(_txsig);
		} catch (e) {
			console.log(e);
		}
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-4545454')));

		// some user goes long (lp should get a short + pnl for closing long on settle)
		try {
			await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
			const _txsig = await traderDriftClient.openPosition(
				PositionDirection.LONG,
				tradeSize,
				market.marketIndex
				// new BN(100 * BASE_PRECISION.toNumber())
			);
			await _viewLogs(_txsig);
		} catch (e) {
			console.log(e);
		}
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-9090908')));
		console.log(
			'market.amm.baseAssetAmountWithAmm:',
			market.amm.baseAssetAmountWithAmm.toString()
		);
		assert(market.amm.baseAssetAmountWithAmm.eq(new BN('9090909200')));

		// add jit maker going other way
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: tradeSize,
			price: new BN(0.9 * PRICE_PRECISION.toNumber()),
			auctionStartPrice: new BN(0.99 * PRICE_PRECISION.toNumber()),
			auctionEndPrice: new BN(0.929 * PRICE_PRECISION.toNumber()),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await traderDriftClient.placePerpOrder(takerOrderParams);
		await traderDriftClient.fetchAccounts();
		const order = traderDriftClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: tradeSize,
			price: new BN(1.011 * PRICE_PRECISION.toNumber()),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const txSig = await poorDriftClient.placeAndMakePerpOrder(
			makerOrderParams,
			{
				taker: await traderDriftClient.getUserAccountPublicKey(),
				order: traderDriftClient.getOrderByUserId(1),
				takerUserAccount: traderDriftClient.getUserAccount(),
				takerStats: traderDriftClient.getUserStatsAccountPublicKey(),
			}
		);
		await _viewLogs(txSig);
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-5455090')));
		console.log(
			'market.amm.baseAssetAmountWithAmm:',
			market.amm.baseAssetAmountWithAmm.toString()
		);
		assert(market.amm.baseAssetAmountWithAmm.eq(new BN('5204991000')));
		console.log(
			'market.amm.baseAssetAmountWithUnsettledLp:',
			market.amm.baseAssetAmountWithUnsettledLp.toString()
		);

		assert(market.amm.baseAssetAmountWithUnsettledLp.eq(new BN('545509000')));

		const trader = await traderDriftClient.getUserAccount();
		console.log(
			'trader size',
			trader.perpPositions[0].baseAssetAmount.toString()
		);

		await driftClientUser.fetchAccounts();
		const sdkPnl = driftClientUser.getSettledLPPosition(0)[2];

		console.log('settling...');
		try {
			const _txsigg = await driftClient.settleLP(
				await driftClient.getUserAccountPublicKey(),
				0
			);
			await _viewLogs(_txsigg);
		} catch (e) {
			console.log(e);
		}
		user = await await driftClientUser.getUserAccount();

		const settleLiquidityRecord: LPRecord =
			eventSubscriber.getEventsArray('LPRecord')[0];

		console.log(
			'settle pnl vs sdk',
			settleLiquidityRecord.pnl.toString(),
			sdkPnl.toString()
		);
		// assert(settleLiquidityRecord.pnl.eq(sdkPnl)); //TODO
	});
	it('perp jit check (amm jit intensity = 200)', async () => {
		const marketIndex = 2;

		await driftClient.updateAmmJitIntensity(marketIndex, 200);

		console.log('adding liquidity...');
		await driftClient.updatePerpMarketTargetBaseAssetAmountPerLp(
			marketIndex,
			BASE_PRECISION.toNumber()
		);

		await driftClient.fetchAccounts();
		let market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('1000000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		const _sig = await driftClient.addPerpLpShares(
			new BN(100 * BASE_PRECISION.toNumber()),
			market.marketIndex
		);
		await delay(lpCooldown + 1000);
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('1100000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		let user = await driftClientUser.getUserAccount();
		assert(user.perpPositions[0].lpShares.toString() == '100000000000'); // 10 * 1e9

		// lp goes long
		const tradeSize = new BN(5 * BASE_PRECISION.toNumber());
		try {
			await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
			const _txsig = await driftClient.openPosition(
				PositionDirection.LONG,
				tradeSize,
				market.marketIndex
				// new BN(100 * BASE_PRECISION.toNumber())
			);
			await _viewLogs(_txsig);
		} catch (e) {
			console.log(e);
		}
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-4545454')));

		// some user goes long (lp should get a short + pnl for closing long on settle)
		// try {
		await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
		const _txsig = await traderDriftClient.openPosition(
			PositionDirection.LONG,
			tradeSize,
			market.marketIndex
			// new BN(100 * BASE_PRECISION.toNumber())
		);
		await _viewLogs(_txsig);
		// } catch (e) {
		// 	console.log(e);
		// }
		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.baseAssetAmountPerLp:',
			market.amm.baseAssetAmountPerLp.toString()
		);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('-9090908')));
		console.log(
			'market.amm.baseAssetAmountWithAmm:',
			market.amm.baseAssetAmountWithAmm.toString()
		);
		assert(market.amm.baseAssetAmountWithAmm.eq(new BN('9090909200')));

		// const trader = await traderDriftClient.getUserAccount();
		// console.log(
		// 	'trader size',
		// 	trader.perpPositions[0].baseAssetAmount.toString()
		// );

		for (let i = 0; i < 10; i++) {
			// add jit maker going other way
			const takerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount: tradeSize,
				price: new BN(0.9 * PRICE_PRECISION.toNumber()),
				auctionStartPrice: new BN(0.99 * PRICE_PRECISION.toNumber()),
				auctionEndPrice: new BN(0.929 * PRICE_PRECISION.toNumber()),
				auctionDuration: 10,
				userOrderId: 1,
				postOnly: PostOnlyParams.NONE,
			});
			await traderDriftClient.placePerpOrder(takerOrderParams);
			await traderDriftClient.fetchAccounts();
			console.log(takerOrderParams);
			const order = traderDriftClientUser.getOrderByUserOrderId(1);
			console.log(order);

			assert(!order.postOnly);

			const makerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount: tradeSize,
				price: new BN(1.011 * PRICE_PRECISION.toNumber()),
				userOrderId: 1,
				postOnly: PostOnlyParams.MUST_POST_ONLY,
				immediateOrCancel: true,
			});
			console.log('maker:', makerOrderParams);

			const txSig = await poorDriftClient.placeAndMakePerpOrder(
				makerOrderParams,
				{
					taker: await traderDriftClient.getUserAccountPublicKey(),
					order: traderDriftClient.getOrderByUserId(1),
					takerUserAccount: traderDriftClient.getUserAccount(),
					takerStats: traderDriftClient.getUserStatsAccountPublicKey(),
				}
			);
			await _viewLogs(txSig);
			await driftClient.fetchAccounts();
			market = driftClient.getPerpMarketAccount(marketIndex);
			console.log(
				'market.amm.baseAssetAmountPerLp:',
				market.amm.baseAssetAmountPerLp.toString()
			);
			console.log(
				'market.amm.baseAssetAmountWithAmm:',
				market.amm.baseAssetAmountWithAmm.toString()
			);
			console.log(
				'market.amm.baseAssetAmountWithUnsettledLp:',
				market.amm.baseAssetAmountWithUnsettledLp.toString()
			);

			if (i == 0) {
				assert(market.amm.baseAssetAmountPerLp.eq(new BN('-5227727')));
				assert(market.amm.baseAssetAmountWithAmm.eq(new BN('5227727300')));
				assert(
					market.amm.baseAssetAmountWithUnsettledLp.eq(new BN('522772700'))
				);
			}
		}
		market = driftClient.getPerpMarketAccount(marketIndex);
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('12499904')));
		assert(market.amm.baseAssetAmountWithAmm.eq(new BN('90400')));
		assert(market.amm.baseAssetAmountWithUnsettledLp.eq(new BN('-1249990400')));

		const trader = await traderDriftClient.getUserAccount();
		console.log(
			'trader size',
			trader.perpPositions[0].baseAssetAmount.toString()
		);

		await driftClientUser.fetchAccounts();
		const sdkPnl = driftClientUser.getSettledLPPosition(0)[2];

		console.log('settling...');
		try {
			const _txsigg = await driftClient.settleLP(
				await driftClient.getUserAccountPublicKey(),
				0
			);
			await _viewLogs(_txsigg);
		} catch (e) {
			console.log(e);
		}
		user = await await driftClientUser.getUserAccount();
		const orderRecords = eventSubscriber.getEventsArray('OrderActionRecord');

		const matchOrderRecord = orderRecords[1];
		assert(
			isVariant(matchOrderRecord.actionExplanation, 'orderFilledWithMatchJit')
		);
		assert(matchOrderRecord.baseAssetAmountFilled.toString(), '3750000000');
		assert(matchOrderRecord.quoteAssetAmountFilled.toString(), '3791212');

		const jitOrderRecord = orderRecords[2];
		assert(isVariant(jitOrderRecord.actionExplanation, 'orderFilledWithLpJit'));
		assert(jitOrderRecord.baseAssetAmountFilled.toString(), '1250000000');
		assert(jitOrderRecord.quoteAssetAmountFilled.toString(), '1263738');

		// console.log('len of orderRecords', orderRecords.length);
		lastOrderRecordsLength = orderRecords.length;

		// Convert the array to a JSON string
		// const fs = require('fs');
		// // Custom replacer function to convert BN values to numerical representation
		// const replacer = (key, value) => {
		// 	if (value instanceof BN) {
		// 		return value.toString(10); // Convert BN to base-10 string
		// 	}
		// 	return value;
		// };
		// const jsonOrderRecords = JSON.stringify(orderRecords, replacer);

		// // Write the JSON string to a file
		// fs.writeFile('orderRecords.json', jsonOrderRecords, 'utf8', (err) => {
		// 	if (err) {
		// 		console.error('Error writing to JSON file:', err);
		// 		return;
		// 	}
		// 	console.log('orderRecords successfully written to orderRecords.json');
		// });

		// assert(orderRecords)
		const settleLiquidityRecord: LPRecord =
			eventSubscriber.getEventsArray('LPRecord')[0];

		console.log(
			'settle pnl vs sdk',
			settleLiquidityRecord.pnl.toString(),
			sdkPnl.toString()
		);
		// assert(settleLiquidityRecord.pnl.eq(sdkPnl));
	});
	it('perp jit check BTC inout (amm jit intensity = 200)', async () => {
		const marketIndex = 3;

		await driftClient.updateAmmJitIntensity(marketIndex, 200);
		await driftClient.updatePerpMarketCurveUpdateIntensity(marketIndex, 100);
		await driftClient.updatePerpMarketMaxSpread(marketIndex, 100000);
		await driftClient.updatePerpMarketBaseSpread(marketIndex, 10000);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		let market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('1000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == 0);

		console.log('adding liquidity...');
		const _sig = await driftClient.addPerpLpShares(
			BASE_PRECISION,
			market.marketIndex
		);
		await delay(lpCooldown + 1000);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString()
		);
		assert(market.amm.sqrtK.eq(new BN('2000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		let [bid, ask] = calculateBidAskPrice(
			driftClient.getPerpMarketAccount(marketIndex).amm,
			driftClient.getOracleDataForPerpMarket(marketIndex)
		);
		console.log(bid.toString(), '/', ask.toString());
		console.log('bid:', bid.toString());
		console.log('ask:', ask.toString());

		let perpy = await driftClientUser.getPerpPosition(marketIndex);

		assert(perpy.lpShares.toString() == '1000000000'); //  1e9
		console.log(
			'user.perpPositions[0].baseAssetAmount:',
			perpy.baseAssetAmount.toString()
		);
		assert(perpy.baseAssetAmount.toString() == '0'); // no fills

		// trader goes long
		const tradeSize = BASE_PRECISION.div(new BN(20));
		const _txsig = await traderDriftClient.openPosition(
			PositionDirection.LONG,
			tradeSize,
			market.marketIndex
			// new BN(100 * BASE_PRECISION.toNumber())
		);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		perpy = await driftClientUser.getPerpPosition(marketIndex);
		assert(perpy.baseAssetAmount.toString() == '0'); // unsettled

		await driftClient.settleLP(
			await driftClient.getUserAccountPublicKey(),
			marketIndex
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		perpy = await driftClientUser.getPerpPosition(marketIndex);
		console.log('perpy.baseAssetAmount:', perpy.baseAssetAmount.toString());
		assert(perpy.baseAssetAmount.toString() == '-10000000'); // settled

		[bid, ask] = calculateBidAskPrice(
			driftClient.getPerpMarketAccount(marketIndex).amm,
			driftClient.getOracleDataForPerpMarket(marketIndex)
		);
		console.log(bid.toString(), '/', ask.toString());
		console.log('bid:', bid.toString());
		console.log('ask:', ask.toString());

		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: tradeSize,
			price: new BN(26000 * PRICE_PRECISION.toNumber()),
			auctionStartPrice: new BN(26400.99 * PRICE_PRECISION.toNumber()),
			auctionEndPrice: new BN(26000.929 * PRICE_PRECISION.toNumber()),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await traderDriftClient.placePerpOrder(takerOrderParams);
		await traderDriftClient.fetchAccounts();
		// console.log(takerOrderParams);
		// const order = traderDriftClientUser.getOrderByUserOrderId(1);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: tradeSize,
			price: new BN(26488.88 * PRICE_PRECISION.toNumber()),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		[bid, ask] = calculateBidAskPrice(
			driftClient.getPerpMarketAccount(marketIndex).amm,
			driftClient.getOracleDataForPerpMarket(marketIndex)
		);
		console.log(bid.toString(), '/', ask.toString());
		console.log('bid:', bid.toString());
		console.log('ask:', ask.toString());

		await poorDriftClient.placeAndMakePerpOrder(makerOrderParams, {
			taker: await traderDriftClient.getUserAccountPublicKey(),
			order: traderDriftClient.getOrderByUserId(1),
			takerUserAccount: traderDriftClient.getUserAccount(),
			takerStats: traderDriftClient.getUserStatsAccountPublicKey(),
		});

		await driftClient.fetchAccounts();
		const marketAfter = driftClient.getPerpMarketAccount(marketIndex);
		const orderRecords = eventSubscriber.getEventsArray('OrderActionRecord');

		console.log('len of orderRecords', orderRecords.length);
		assert(orderRecords.length - lastOrderRecordsLength == 7);
		lastOrderRecordsLength = orderRecords.length;
		// Convert the array to a JSON string

		// console.log(marketAfter);
		console.log(marketAfter.amm.baseAssetAmountPerLp.toString());
		console.log(marketAfter.amm.quoteAssetAmountPerLp.toString());
		console.log(marketAfter.amm.baseAssetAmountWithUnsettledLp.toString());
		console.log(marketAfter.amm.baseAssetAmountWithAmm.toString());

		assert(marketAfter.amm.baseAssetAmountPerLp.eq(new BN(-5000000)));
		assert(marketAfter.amm.quoteAssetAmountPerLp.eq(new BN(144606790)));
		assert(marketAfter.amm.baseAssetAmountWithUnsettledLp.eq(new BN(-5000000)));
		assert(marketAfter.amm.baseAssetAmountWithAmm.eq(new BN(5000000)));

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const perpPos = driftClientUser.getPerpPosition(marketIndex);
		console.log(perpPos.baseAssetAmount.toString());
		assert(perpPos.baseAssetAmount.toString() == '-10000000');

		const [settledPos, dustPos, lpPnl] =
			driftClientUser.getSettledLPPosition(marketIndex);
		console.log('settlePos:', settledPos);
		console.log('dustPos:', dustPos.toString());
		console.log('lpPnl:', lpPnl.toString());

		assert(dustPos.toString() == '0');
		assert(lpPnl.toString() == '6134172');

		const _sig2 = await driftClient.settleLP(
			await driftClient.getUserAccountPublicKey(),
			marketIndex
		);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const perpPosAfter = driftClientUser.getPerpPosition(marketIndex);
		console.log(
			'perpPosAfter.baseAssetAmount:',
			perpPosAfter.baseAssetAmount.toString()
		);
		assert(perpPosAfter.baseAssetAmount.toString() == '-5000000');
		assert(perpPosAfter.baseAssetAmount.eq(settledPos.baseAssetAmount));

		const takerOrderParams2 = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: tradeSize.mul(new BN(20)),
			price: new BN(26000 * PRICE_PRECISION.toNumber()),
			auctionStartPrice: new BN(26400.99 * PRICE_PRECISION.toNumber()),
			auctionEndPrice: new BN(26000.929 * PRICE_PRECISION.toNumber()),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await traderDriftClient.placePerpOrder(takerOrderParams2);
		await traderDriftClient.fetchAccounts();
		// console.log(takerOrderParams);
		// const order = traderDriftClientUser.getOrderByUserOrderId(1);

		const makerOrderParams2 = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: tradeSize.mul(new BN(20)),
			price: new BN(26488.88 * PRICE_PRECISION.toNumber()),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		[bid, ask] = calculateBidAskPrice(
			driftClient.getPerpMarketAccount(marketIndex).amm,
			driftClient.getOracleDataForPerpMarket(marketIndex)
		);
		console.log(bid.toString(), '/', ask.toString());
		console.log('bid:', bid.toString());
		console.log('ask:', ask.toString());

		await poorDriftClient.placeAndMakePerpOrder(makerOrderParams2, {
			taker: await traderDriftClient.getUserAccountPublicKey(),
			order: traderDriftClient.getOrderByUserId(1),
			takerUserAccount: traderDriftClient.getUserAccount(),
			takerStats: traderDriftClient.getUserStatsAccountPublicKey(),
		});
		const marketAfter2 = driftClient.getPerpMarketAccount(marketIndex);

		console.log(marketAfter2.amm.baseAssetAmountPerLp.toString());
		console.log(marketAfter2.amm.quoteAssetAmountPerLp.toString());
		console.log(marketAfter2.amm.baseAssetAmountWithUnsettledLp.toString());
		console.log(marketAfter2.amm.baseAssetAmountWithAmm.toString());

		assert(marketAfter2.amm.baseAssetAmountPerLp.eq(new BN(-2500000)));
		assert(marketAfter2.amm.quoteAssetAmountPerLp.eq(new BN(78437568)));
		assert(
			marketAfter2.amm.baseAssetAmountWithUnsettledLp.eq(new BN(-2500000))
		);
		assert(marketAfter2.amm.baseAssetAmountWithAmm.eq(new BN(2500000)));

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const perpPos2 = driftClientUser.getPerpPosition(marketIndex);
		console.log(perpPos2.baseAssetAmount.toString());
		assert(perpPos2.baseAssetAmount.toString() == '-5000000');

		const [settledPos2, dustPos2, lpPnl2] =
			driftClientUser.getSettledLPPosition(marketIndex);
		console.log('settlePos:', settledPos2);
		console.log('dustPos:', dustPos2.toString());
		console.log('lpPnl:', lpPnl2.toString());

		assert(dustPos2.toString() == '0');
		assert(lpPnl2.toString() == '3067087');

		await driftClient.settleLP(
			await driftClient.getUserAccountPublicKey(),
			marketIndex
		);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const perpPosAfter2 = driftClientUser.getPerpPosition(marketIndex);
		console.log(
			'perpPosAfter2.baseAssetAmount:',
			perpPosAfter2.baseAssetAmount.toString()
		);
		assert(perpPosAfter2.baseAssetAmount.toString() == '-2500000');
		assert(perpPosAfter2.baseAssetAmount.eq(settledPos2.baseAssetAmount));

		const orderRecords2 = eventSubscriber.getEventsArray('OrderActionRecord');
		console.log('len of orderRecords', orderRecords2.length);
		// assert(orderRecords.length - lastOrderRecordsLength == 7);
		lastOrderRecordsLength = orderRecords2.length;

		// const fs = require('fs');
		// // Custom replacer function to convert BN values to numerical representation
		// const replacer = (key, value) => {
		// 	if (value instanceof BN) {
		// 		return value.toString(10); // Convert BN to base-10 string
		// 	}
		// 	return value;
		// };
		// const jsonOrderRecords2 = JSON.stringify(orderRecords2, replacer);

		// // Write the JSON string to a file
		// fs.writeFile('orderRecords.json', jsonOrderRecords2, 'utf8', (err) => {
		// 	if (err) {
		// 		console.error('Error writing to JSON file:', err);
		// 		return;
		// 	}
		// 	console.log('orderRecords successfully written to orderRecords.json');
		// });
	});
});
