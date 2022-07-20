import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BN,
	calculateAmmReservesAfterSwap,
	calculatePrice,
	ClearingHouseUser,
	OracleSource,
	SwapDirection,
	Wallet,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import * as web3 from '@solana/web3.js';

import {
	Admin,
	AMM_RESERVE_PRECISION,
	EventSubscriber,
	MARK_PRICE_PRECISION,
	PositionDirection,
	ZERO,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { setFeedPrice } from '../stress/mockPythUtils';

async function adjustOraclePostSwap(baa, swapDirection, market) {
	const [newQaa, newBaa] = calculateAmmReservesAfterSwap(
		market.amm,
		'base',
		baa.abs(),
		swapDirection
	);

	const newPrice = calculatePrice(newBaa, newQaa, market.amm.pegMultiplier);
	const _newPrice = newPrice.toNumber() / MARK_PRICE_PRECISION.toNumber();
	await setFeedPrice(anchor.workspace.Pyth, _newPrice, market.amm.oracle);

	return _newPrice;
}

async function createNewUser(
	program,
	provider,
	usdcMint,
	usdcAmount,
	oracleInfos,
	wallet
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

	const clearingHouse = new Admin({
		connection: provider.connection,
		wallet: wallet,
		programID: program.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeUserId: 0,
		marketIndexes: [new BN(0), new BN(1)],
		bankIndexes: [new BN(0)],
		oracleInfos,
	});
	await clearingHouse.subscribe();

	if (walletFlag) {
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
	}

	await clearingHouse.initializeUserAccountAndDepositCollateral(
		usdcAmount,
		usdcAta.publicKey
	);

	const clearingHouseUser = new ClearingHouseUser({
		clearingHouse,
		userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
	});
	clearingHouseUser.subscribe();

	return [clearingHouse, clearingHouseUser];
}

describe('liquidity providing', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	// async function viewLogs(txsig) {
	// 	let tx = await connection.getTransaction(txsig, {
	// 		commitment: 'confirmed',
	// 	});
	// 	console.log('tx logs', tx.meta.logMessages);
	// }

	// ammInvariant == k == x * y
	const ammInitialBaseAssetReserve = new BN(200).mul(new BN(1e13));
	const ammInitialQuoteAssetReserve = new BN(200).mul(new BN(1e13));

	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const stableAmmInitialQuoteAssetReserve = new anchor.BN(1 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const stableAmmInitialBaseAssetReserve = new anchor.BN(1 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(1_000_000_000 * 1e6);

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint: web3.Keypair;

	let clearingHouseUser: ClearingHouseUser;
	let traderClearingHouse: Admin;
	let traderClearingHouseUser: ClearingHouseUser;

	let solusdc;
	let solusdc2;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		solusdc2 = await mockOracle(1, -7); // make invalid
		solusdc = await mockOracle(1, -7); // make invalid
		const oracleInfos = [
			{ publicKey: solusdc, source: OracleSource.PYTH },
			{ publicKey: solusdc2, source: OracleSource.PYTH },
		];

		[clearingHouse, clearingHouseUser] = await createNewUser(
			chProgram,
			provider,
			usdcMint,
			usdcAmount,
			oracleInfos,
			provider.wallet
		);
		await clearingHouse.updateOrderAuctionTime(new BN(0));

		// used for trading / taking on baa
		await clearingHouse.initializeMarket(
			solusdc,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(60 * 60)
		);

		// second market -- used for funding ..
		await clearingHouse.initializeMarket(
			solusdc2,
			stableAmmInitialBaseAssetReserve,
			stableAmmInitialQuoteAssetReserve,
			new BN(0)
		);

		[traderClearingHouse, traderClearingHouseUser] = await createNewUser(
			chProgram,
			provider,
			usdcMint,
			usdcAmount,
			oracleInfos,
			undefined
		);
	});

	after(async () => {
		await eventSubscriber.unsubscribe();

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();

		await traderClearingHouse.unsubscribe();
		await traderClearingHouseUser.unsubscribe();

		// await traderClearingHouse2.unsubscribe();
		// await traderClearingHouseUser2.unsubscribe();
	});

	it('provides and removes liquidity', async () => {
		const market = clearingHouse.getMarketAccount(0);
		const prevSqrtK = market.amm.sqrtK;
		const prevbar = market.amm.baseAssetReserve;
		const prevqar = market.amm.quoteAssetReserve;

		console.log('adding liquidity...');
		const _txsig = await clearingHouse.addLiquidity(
			new BN(100 * AMM_RESERVE_PRECISION),
			market.marketIndex
		);

		market = clearingHouse.getMarketAccount(0);
		console.log(
			'sqrtK:',
			prevSqrtK.toString(),
			'->',
			market.amm.sqrtK.toString()
		);
		console.log(
			'baseAssetReserve:',
			prevbar.toString(),
			'->',
			market.amm.baseAssetReserve.toString()
		);
		console.log(
			'quoteAssetReserve:',
			prevqar.toString(),
			'->',
			market.amm.quoteAssetReserve.toString()
		);

		// k increases = more liquidity
		assert(prevSqrtK.lt(market.amm.sqrtK));
		assert(prevqar.lt(market.amm.quoteAssetReserve));
		assert(prevbar.lt(market.amm.baseAssetReserve));

		const lpShares = clearingHouseUser.getUserAccount().positions[0].lpShares;
		console.log('lpShares:', lpShares.toString());
		assert(lpShares.gt(ZERO));

		console.log('removing liquidity...');
		const _txSig = await clearingHouse.removeLiquidity(market.marketIndex);

		market = clearingHouse.getMarketAccount(0);
		const user = clearingHouseUser.getUserAccount();
		const lpTokenAmount = user.positions[0].lpShares;
		console.log('lp token amount:', lpTokenAmount.toString());
		assert(lpTokenAmount.eq(ZERO));

		console.log('asset reserves:');
		console.log(prevSqrtK.toString(), market.amm.sqrtK.toString());
		console.log(prevbar.toString(), market.amm.baseAssetReserve.toString());
		console.log(prevqar.toString(), market.amm.quoteAssetReserve.toString());

		const errThreshold = new BN(500000);
		assert(prevSqrtK.eq(market.amm.sqrtK));
		assert(
			prevbar.sub(market.amm.baseAssetReserve).abs().lte(errThreshold),
			prevbar.sub(market.amm.baseAssetReserve).abs().toString()
		);
		assert(
			prevqar.sub(market.amm.quoteAssetReserve).abs().lte(errThreshold),
			prevqar.sub(market.amm.quoteAssetReserve).abs().toString()
		);
		assert(prevSqrtK.eq(market.amm.sqrtK));
	});

	it('mints too many lp tokens', async () => {
		console.log('adding liquidity...');
		const market = clearingHouse.getMarketAccount(ZERO);
		try {
			await clearingHouse.addLiquidity(market.amm.sqrtK, market.marketIndex);
		} catch (e) {
			assert(e.message.includes('0x1773')); // insufficient collateral
		}
	});

	it('provides lp, users shorts, removes lp, lp has long', async () => {
		console.log('adding liquidity...');

		const market = clearingHouse.getMarketAccount(new BN(0));
		const _sig = await clearingHouse.addLiquidity(
			new BN(100 * 1e13),
			market.marketIndex
		);

		let user = clearingHouseUser.getUserAccount();
		console.log(user.positions[0].lpShares.toString());

		// some user goes long (lp should get a short)
		console.log('user trading...');
		const tradeSize = new BN(40 * 1e13);
		await adjustOraclePostSwap(tradeSize, SwapDirection.ADD, market);
		const _txsig = await traderClearingHouse.openPosition(
			PositionDirection.SHORT,
			tradeSize,
			market.marketIndex
		);

		const position = traderClearingHouse.getUserAccount().positions[0];
		console.log(
			'trader position:',
			position.baseAssetAmount.toString(),
			position.quoteAssetAmount.toString()
		);

		console.log('removing liquidity...');
		const _txSig = await clearingHouse.removeLiquidity(market.marketIndex);
		// viewLogs(txSig);

		user = clearingHouseUser.getUserAccount();
		const lpPosition = user.positions[0];
		const lpTokenAmount = lpPosition.lpShares;

		console.log('lp tokens', lpTokenAmount.toString());
		console.log(
			'baa, qaa',
			lpPosition.baseAssetAmount.toString(),
			lpPosition.quoteAssetAmount.toString(),
			lpPosition.unsettledPnl.toString()
		);

		assert(lpPosition.unsettledPnl.gt(ZERO)); // get paid fees
		assert(lpTokenAmount.eq(new BN(0)));
		assert(user.positions[0].baseAssetAmount.gt(new BN(0))); // lp is short
		assert(!user.positions[0].quoteAssetAmount.eq(new BN(0)));

		console.log('closing trader ...');
		await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('closing lp ...');
		console.log(user.positions[0].baseAssetAmount.div(new BN(1e13)).toString());
		await adjustOraclePostSwap(
			user.positions[0].baseAssetAmount,
			SwapDirection.ADD,
			market
		);
		await clearingHouse.closePosition(new BN(0)); // close lp position

		const user2 = clearingHouseUser.getUserAccount();
		console.log(user2.positions[0].lpShares.toString());
		const position2 = user2.positions[0];
		console.log(
			position2.baseAssetAmount.toString(),
			position2.quoteAssetAmount.toString()
		);

		console.log('done!');
	});

	it('provides lp, users longs, removes lp, lp has short', async () => {
		const market = clearingHouse.getMarketAccount(ZERO);

		console.log('adding liquidity...');
		const _sig = await clearingHouse.addLiquidity(
			new BN(100 * 1e13),
			market.marketIndex
		);

		// some user goes long (lp should get a short)
		console.log('user trading...');
		const tradeSize = new BN(40 * 1e13);
		await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
		const _txsig = await traderClearingHouse.openPosition(
			PositionDirection.LONG,
			tradeSize,
			market.marketIndex
		);

		const position = traderClearingHouse.getUserAccount().positions[0];
		console.log(
			'trader position:',
			position.baseAssetAmount.toString(),
			position.quoteAssetAmount.toString()
		);

		console.log('removing liquidity...');
		const _txSig = await clearingHouse.removeLiquidity(market.marketIndex);

		const user = clearingHouseUser.getUserAccount();
		const lpPosition = user.positions[0];
		const lpTokenAmount = lpPosition.lpShares;

		console.log('lp tokens', lpTokenAmount.toString());
		console.log(
			'baa, qaa, upnl',
			lpPosition.baseAssetAmount.toString(),
			lpPosition.quoteAssetAmount.toString(),
			lpPosition.unsettledPnl.toString()
		);

		assert(lpPosition.unsettledPnl.gt(ZERO)); // get paid fees
		assert(lpTokenAmount.eq(ZERO));
		assert(user.positions[0].baseAssetAmount.lt(ZERO)); // lp is short
		assert(!user.positions[0].quoteAssetAmount.eq(ZERO));

		console.log('closing trader...');
		await adjustOraclePostSwap(tradeSize, SwapDirection.ADD, market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('closing lp ...');
		await adjustOraclePostSwap(
			user.positions[0].baseAssetAmount,
			SwapDirection.REMOVE,
			market
		);
		await clearingHouse.closePosition(new BN(0)); // close lp position

		console.log('done!');
	});

	it('lp gets paid in funding', async () => {
		const market = clearingHouse.getMarketAccount(new BN(1));
		const marketIndex = market.marketIndex;

		console.log('adding liquidity...');
		const _sig = await clearingHouse.addLiquidity(
			new BN(100_000).mul(new BN(1e13)),
			marketIndex
		);

		console.log('user trading...');
		const tradeSize = new BN(100 * 1e13).mul(new BN(30));
		const _txig = await traderClearingHouse.openPosition(
			PositionDirection.LONG,
			tradeSize,
			marketIndex
		);

		console.log('updating funding rates');
		const _txsig = await clearingHouse.updateFundingRate(solusdc2, marketIndex);

		console.log('removing liquidity...');
		try {
			const _txSig = await clearingHouse.removeLiquidity(marketIndex);
		} catch (e) {
			console.log(e);
		}

		const user = clearingHouseUser.getUserAccount();
		const feePayment = new BN(1500000);
		const fundingPayment = new BN(2300000);

		// dont get paid in fees bc the sqrtk is so big that fees dont get given to the lps
		assert(user.positions[1].unsettledPnl.eq(fundingPayment.add(feePayment)));

		const trader = traderClearingHouse.getUserAccount();
		await adjustOraclePostSwap(
			trader.positions[1].baseAssetAmount,
			SwapDirection.ADD,
			market
		);
		await traderClearingHouse.closePosition(market.marketIndex); // close lp position

		console.log('closing lp ...');
		console.log(user.positions[1].baseAssetAmount.toString());
		await adjustOraclePostSwap(
			user.positions[1].baseAssetAmount,
			SwapDirection.REMOVE,
			market
		);
		await clearingHouse.closePosition(market.marketIndex); // close lp position
	});

	it('lp burns a partial position', async () => {
		const market = clearingHouse.getMarketAccount(0);

		console.log('adding liquidity...');
		await clearingHouse.addLiquidity(
			new BN(100 * AMM_RESERVE_PRECISION),
			market.marketIndex
		);

		console.log('user trading...');
		const tradeSize = new BN(40 * 1e13);
		await adjustOraclePostSwap(tradeSize, SwapDirection.ADD, market);
		await traderClearingHouse.openPosition(
			PositionDirection.SHORT,
			tradeSize,
			market.marketIndex
		);

		console.log('removing liquidity...');
		let user = clearingHouse.getUserAccount();
		let position = user.positions[0];

		const fullShares = position.lpShares;
		const halfShares = position.lpShares.div(new BN(2));
		const otherHalfShares = fullShares.sub(halfShares);

		try {
			const _txSig = await clearingHouse.removeLiquidity(
				market.marketIndex,
				halfShares
			);
		} catch (e) {
			console.log(e);
		}
		user = clearingHouse.getUserAccount();
		position = user.positions[0];
		console.log(
			user.positions[0].baseAssetAmount.toString(),
			user.positions[0].quoteAssetAmount.toString()
		);
		console.log(user.positions[0].lpShares.toString());

		const baa = user.positions[0].baseAssetAmount;
		const qaa = user.positions[0].quoteAssetAmount;
		assert(baa.gt(ZERO));
		assert(qaa.gt(ZERO));

		console.log('removing the other half of liquidity');
		await clearingHouse.removeLiquidity(market.marketIndex, otherHalfShares);

		user = clearingHouse.getUserAccount();
		position = user.positions[0];

		console.log(
			position.baseAssetAmount.toString(),
			position.quoteAssetAmount.toString()
		);
		console.log(position.lpShares.toString());

		const newBaa = position.baseAssetAmount;
		const newQaa = position.quoteAssetAmount;
		assert(newBaa.gt(baa));
		assert(newQaa.gt(qaa));

		assert(user.positions[0].lpShares.eq(ZERO));

		console.log('closing trader ...');
		await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('closing lp ...');
		await adjustOraclePostSwap(newBaa, SwapDirection.ADD, market);
		await clearingHouse.closePosition(new BN(0)); // close lp position
	});

	it('settles lp', async () => {
		console.log('adding liquidity...');

		const market = clearingHouse.getMarketAccount(new BN(0));
		const _sig = await clearingHouse.addLiquidity(
			new BN(100 * 1e13),
			market.marketIndex
		);

		let user = clearingHouseUser.getUserAccount();
		console.log(user.positions[0].lpShares.toString());

		// some user goes long (lp should get a short)
		console.log('user trading...');
		const tradeSize = new BN(124 * 1e13);
		await adjustOraclePostSwap(tradeSize, SwapDirection.ADD, market);
		const _txsig = await traderClearingHouse.openPosition(
			PositionDirection.SHORT,
			tradeSize,
			market.marketIndex
		);

		const trader = traderClearingHouse.getUserAccount();
		console.log('trader size', trader.positions[0].baseAssetAmount.toString());
		const lpPosition2 = clearingHouse.getUserAccount().positions[0];
		console.log(
			'LP baa, qaa, upnl',
			lpPosition2.baseAssetAmount.toString(),
			lpPosition2.quoteAssetAmount.toString(),
			lpPosition2.unsettledPnl.toString()
		);

		console.log('settling...');
		// trader settles the lp
		const _txssig = await traderClearingHouse.settleLP(
			await clearingHouse.getUserAccountPublicKey(),
			market.marketIndex
		);

		user = clearingHouse.getUserAccount();
		const position = user.positions[0];
		const lpBaa = position.lpBaseAssetAmount;
		const lpQaa = position.lpQuoteAssetAmount;
		const lpUpnl = position.unsettledPnl;

		console.log(lpBaa.toString(), lpQaa.toString(), lpUpnl.toString());
		assert(lpBaa.gt(ZERO));
		assert(lpQaa.gt(ZERO));

		console.log('removing liquidity...');
		const baa = position.baseAssetAmount;
		const qaa = position.quoteAssetAmount; // dust from prev tests

		const _txSig = await clearingHouse.removeLiquidity(market.marketIndex);

		user = clearingHouseUser.getUserAccount();
		const lpPosition = user.positions[0];
		const lpTokenAmount = lpPosition.lpShares;

		assert(lpTokenAmount.eq(new BN(0)));
		assert(user.positions[0].baseAssetAmount.eq(lpBaa.add(baa)));
		assert(user.positions[0].quoteAssetAmount.eq(lpQaa.add(qaa)));

		console.log('closing trader ...');
		await adjustOraclePostSwap(tradeSize, SwapDirection.REMOVE, market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('closing lp ...');
		await adjustOraclePostSwap(
			user.positions[0].baseAssetAmount,
			SwapDirection.ADD,
			market
		);
		await clearingHouse.closePosition(new BN(0)); // close lp position

		console.log('done!');
	});

	// it('removes liquidity when market position is small', async () => {
	// 	console.log('adding liquidity...');
	// 	await clearingHouse.addLiquidity(usdcAmount, new BN(0));
	//
	// 	console.log('user trading...');
	// 	await traderClearingHouse.openPosition(
	// 		PositionDirection.LONG,
	// 		new BN(1 * 1e6),
	// 		new BN(0)
	// 	);
	//
	// 	console.log('removing liquidity...');
	// 	await clearingHouse.removeLiquidity(new BN(0));
	//
	// 	const user = clearingHouse.getUserAccount();
	// 	const position = user.positions[0];
	//
	// 	// small loss
	// 	assert(position.unsettledPnl.lt(ZERO));
	// 	// no position
	// 	assert(position.baseAssetAmount.eq(ZERO));
	// 	assert(position.quoteAssetAmount.eq(ZERO));
	// });
	//
	// uncomment when settle fcn is ready

	/* it('adds additional liquidity to an already open lp', async () => {
		console.log('adding liquidity...');
		const lp_amount = new BN(300 * 1e6);
		const _txSig = await clearingHouse.addLiquidity(lp_amount, new BN(0));

		console.log(
			'tx logs',
			(await connection.getTransaction(txsig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const init_user = clearingHouseUser.getUserAccount();
		await clearingHouse.addLiquidity(lp_amount, new BN(0));
		const user = clearingHouseUser.getUserAccount();

		const init_tokens = init_user.positions[0].lpTokens;
		const tokens = user.positions[0].lpTokens;
		console.log(init_tokens.toString(), tokens.toString());
		assert(init_tokens.lt(tokens));

		await clearingHouse.removeLiquidity(new BN(0));
	}); */

	/* it('settles an lps position', async () => {
        console.log('adding liquidity...');
        await clearingHouse.addLiquidity(usdcAmount, new BN(0));

        let user = clearingHouse.getUserAccount();
        const baa = user.positions[0].baseAssetAmount;
        const qaa = user.positions[0].quoteAssetAmount;
        const upnl = user.positions[0].unsettledPnl;

		console.log('user trading...');
		await traderClearingHouse.openPosition(
			PositionDirection.SHORT,
			new BN(115 * 1e5),
			new BN(0)
		);

		console.log('settling...');
		await traderClearingHouse.settleLP(
			await clearingHouse.getUserAccountPublicKey(),
			new BN(0)
		);

		user = clearingHouse.getUserAccount();
		const position = user.positions[0];
		const post_baa = position.baseAssetAmount;
		const post_qaa = position.quoteAssetAmount;
		const post_upnl = position.unsettledPnl;

		// they got the market position + upnl
		console.log(baa.toString(), post_baa.toString());
		console.log(qaa.toString(), post_qaa.toString());
		console.log(upnl.toString(), post_upnl.toString());
		assert(!post_baa.eq(baa));
		assert(post_qaa.gt(qaa));
		assert(!post_upnl.eq(upnl));

		// other sht was updated
		const market = clearingHouse.getMarketAccount(new BN(0));
		assert(market.amm.netBaseAssetAmount.eq(position.lastNetBaseAssetAmount));
		assert(
			market.amm.totalFeeMinusDistributions.eq(
				position.lastTotalFeeMinusDistributions
			)
		);

		const _txSig = await clearingHouse.removeLiquidity(new BN(0));

		console.log('done!');
	}); */

	/* it('simulates a settle via sdk', async () => {
		const userPosition2 = clearingHouse.getUserAccount().positions[0];
		console.log(
			userPosition2.baseAssetAmount.toString(),
			userPosition2.quoteAssetAmount.toString(),
			userPosition2.unsettledPnl.toString()
		);

		console.log('add lp ...');
		await clearingHouse.addLiquidity(usdcAmount, new BN(0));

		console.log('user trading...');
		await traderClearingHouse.openPosition(
			PositionDirection.SHORT,
			new BN(115 * 1e5),
			new BN(0)
		);

		const [settledPosition, result] = clearingHouseUser.getSettledLPPosition(
			new BN(0)
		);

		console.log('settling...');
		const _txSig = await traderClearingHouse.settleLP(
			await clearingHouse.getUserAccountPublicKey(),
			new BN(0)
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txsig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const userPosition = clearingHouse.getUserAccount().positions[0];

		console.log(
			userPosition.baseAssetAmount.toString(),
			settledPosition.baseAssetAmount.toString(),

			userPosition.quoteAssetAmount.toString(),
			settledPosition.quoteAssetAmount.toString(),

			userPosition.unsettledPnl.toString(),
			settledPosition.unsettledPnl.toString()
		);
		assert(result == SettleResult.RECIEVED_MARKET_POSITION);
		assert(userPosition.baseAssetAmount.eq(settledPosition.baseAssetAmount));
		assert(userPosition.quoteAssetAmount.eq(settledPosition.quoteAssetAmount));
		assert(userPosition.unsettledPnl.eq(settledPosition.unsettledPnl));
	}); */
});
