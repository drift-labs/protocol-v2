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
	OracleGuardRails,
	BulkAccountLoader,
	isVariant,
	MARGIN_PRECISION,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	sleep,
	// sleep,
} from './testHelpers';

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

describe('lp risk mitigation', () => {
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
	const ammInitialBaseAssetReserve = new BN(10000).mul(BASE_PRECISION);
	const ammInitialQuoteAssetReserve = new BN(10000).mul(BASE_PRECISION);

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const stableAmmInitialQuoteAssetReserve =
		BASE_PRECISION.mul(mantissaSqrtScale);
	const stableAmmInitialBaseAssetReserve =
		BASE_PRECISION.mul(mantissaSqrtScale);

	const usdcAmount = new BN(5000 * 1e6); // 2000 bucks

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
				markOraclePercentDivergence: new BN(1000000),
				oracleTwap5MinPercentDivergence: new BN(1000000),
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
		await traderDriftClient.updateUserAdvancedLp([
			{
				advancedLp: true,
				subAccountId: 0,
			},
		]);
		[poorDriftClient, poorDriftClientUser] = await createNewUser(
			chProgram,
			provider,
			usdcMint,
			QUOTE_PRECISION.mul(new BN(10000)),
			oracleInfos,
			undefined,
			bulkAccountLoader
		);
		await poorDriftClient.updateUserAdvancedLp([
			{
				advancedLp: true,
				subAccountId: 0,
			},
		]);
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
	it('perp risk mitigation', async () => {
		const marketIndex = 0;
		console.log('adding liquidity...');
		await driftClient.updatePerpMarketTargetBaseAssetAmountPerLp(
			marketIndex,
			BASE_PRECISION.toNumber()
		);
		sleep(1200);
		await driftClient.fetchAccounts();
		let market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(
			'market.amm.sqrtK:',
			market.amm.userLpShares.toString(),
			'/',
			market.amm.sqrtK.toString(),
			'target:',
			market.amm.targetBaseAssetAmountPerLp
		);
		assert(market.amm.sqrtK.eq(new BN('10000000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		// assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		const _sig = await driftClient.addPerpLpShares(
			new BN(1000 * BASE_PRECISION.toNumber()),
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
		assert(market.amm.sqrtK.eq(new BN('11000000000000')));
		assert(market.amm.baseAssetAmountPerLp.eq(ZERO));
		assert(market.amm.targetBaseAssetAmountPerLp == BASE_PRECISION.toNumber());

		let user = await driftClientUser.getUserAccount();
		assert(user.perpPositions[0].lpShares.toString() == '1000000000000'); // 1000 * 1e9

		// lp goes short
		const tradeSize = new BN(500 * BASE_PRECISION.toNumber());
		try {
			await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
			const _txsig = await driftClient.openPosition(
				PositionDirection.SHORT,
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
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('45454545')));
		console.log(
			'driftClientUser.getFreeCollateral()=',
			driftClientUser.getFreeCollateral().toString()
		);
		assert(driftClientUser.getFreeCollateral().eq(new BN('4761073360')));
		// some user goes long (lp should get more short)
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
		assert(market.amm.baseAssetAmountPerLp.eq(new BN('0')));
		console.log(
			'market.amm.baseAssetAmountWithAmm:',
			market.amm.baseAssetAmountWithAmm.toString()
		);
		assert(market.amm.baseAssetAmountWithAmm.eq(new BN('0')));

		const trader = await traderDriftClient.getUserAccount();
		console.log(
			'trader size',
			trader.perpPositions[0].baseAssetAmount.toString()
		);

		await driftClientUser.fetchAccounts();
		const [userPos, dustBase, sdkPnl] =
			driftClientUser.getPerpPositionWithLPSettle(0);

		console.log('baseAssetAmount:', userPos.baseAssetAmount.toString());
		console.log('dustBase:', dustBase.toString());

		console.log('settling...');
		try {
			const _txsigg = await driftClient.settlePNL(
				await driftClient.getUserAccountPublicKey(),
				await driftClient.getUserAccount(),
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

		const perpLiqPrice = driftClientUser.liquidationPrice(0);
		console.log('perpLiqPrice:', perpLiqPrice.toString());

		await setFeedPrice(anchor.workspace.Pyth, 8, solusdc);
		console.log('settling...');
		try {
			const _txsigg = await driftClient.settlePNL(
				await driftClient.getUserAccountPublicKey(),
				await driftClient.getUserAccount(),
				0
			);
			await _viewLogs(_txsigg);
		} catch (e) {
			console.log(e);
		}

		await driftClient.updateUserCustomMarginRatio([
			{
				marginRatio: MARGIN_PRECISION.toNumber(),
				subAccountId: 0,
			},
		]);

		await sleep(1000);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		console.log(
			'driftClientUser.getUserAccount().openOrders=',
			driftClientUser.getUserAccount().openOrders
		);
		assert(driftClientUser.getUserAccount().openOrders == 0);

		console.log('settling after margin ratio update...');
		try {
			const _txsigg = await driftClient.settlePNL(
				await driftClient.getUserAccountPublicKey(),
				await driftClient.getUserAccount(),
				0
			);
			await _viewLogs(_txsigg);
		} catch (e) {
			console.log(e);
		}
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const afterReduceOrdersAccount = driftClientUser.getUserAccount();
		assert(afterReduceOrdersAccount.openOrders == 1);

		const leOrder = afterReduceOrdersAccount.orders[0];
		console.log(leOrder);
		assert(leOrder.auctionDuration == 80);
		assert(leOrder.auctionStartPrice.lt(ZERO));
		assert(leOrder.auctionEndPrice.gt(ZERO));
		assert(leOrder.reduceOnly);
		assert(!leOrder.postOnly);
		assert(leOrder.marketIndex == 0);
		assert(leOrder.baseAssetAmount.eq(new BN('500000000000')));
		assert(isVariant(leOrder.direction, 'long'));
		assert(isVariant(leOrder.existingPositionDirection, 'short'));

		const afterReduceShares =
			afterReduceOrdersAccount.perpPositions[0].lpShares;

		console.log('afterReduceShares=', afterReduceShares.toString());
		assert(afterReduceShares.lt(new BN(1000 * BASE_PRECISION.toNumber())));
		assert(afterReduceShares.eq(new BN('400000000000')));
	});
});
