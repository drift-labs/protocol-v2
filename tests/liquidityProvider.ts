import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BN,
	calculateAmmReservesAfterSwap,
	calculatePrice,
	ClearingHouseUser,
	OracleSource,
	PEG_PRECISION,
	SwapDirection,
	Wallet,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import * as web3 from '@solana/web3.js';

import {
	Admin,
	AMM_RESERVE_PRECISION,
	ClearingHouse,
	EventSubscriber,
	MARK_PRICE_PRECISION,
	PositionDirection,
	QUOTE_PRECISION,
	ZERO,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { setFeedPrice } from '../stress/mockPythUtils';

async function price_post_swap(baa, swap_direction, market) {
	const price = calculatePrice(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
	console.log('price;', price.toNumber() / MARK_PRICE_PRECISION.toNumber());
	// let swap_direction;
	// if (trader_position.baseAssetAmount.gt(new BN(0))) {
	// 	swap_direction = SwapDirection.ADD;
	// } else {
	// 	swap_direction = SwapDirection.REMOVE;
	// }
	const [new_qaa, new_baa] = calculateAmmReservesAfterSwap(
		market.amm,
		'base',
		baa.abs(),
		// trader_position.baseAssetAmount.abs(),
		swap_direction
	);
	const _new_price = calculatePrice(new_baa, new_qaa, market.amm.pegMultiplier);
	const new_price = _new_price.toNumber() / MARK_PRICE_PRECISION.toNumber();
	console.log('post trade price:', new_price);
	await setFeedPrice(anchor.workspace.Pyth, new_price, market.amm.oracle);

	return new_price;
}

async function createNewUser(
	program,
	provider,
	usdcMint,
	usdcAmount,
	oracleInfos,
	wallet
) {
	let wallet_flag = true;
	if (wallet == undefined) {
		const kp = new web3.Keypair();
		const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 ** 9);
		await provider.connection.confirmTransaction(sig);
		wallet = new Wallet(kp);
		wallet_flag = false;
	}

	console.log('wallet:', wallet_flag);
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

	if (wallet_flag) {
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

	async function view_logs(txsig) {
		let tx = await connection.getTransaction(txsig, {
			commitment: 'confirmed',
		});
		console.log('tx logs', tx.meta.logMessages);
	}

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
	let userUSDCAccount: web3.Keypair;

	let clearingHouseUser: ClearingHouseUser;

	let traderClearingHouse: Admin;
	let traderClearingHouseUser: ClearingHouseUser;

	let traderClearingHouseUser2: ClearingHouseUser;
	let traderClearingHouse2: Admin;

	let solusdc;
	let solusdc2;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

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
			oracleInfos
		);
		// [traderClearingHouse2, traderClearingHouseUser2] = await createNewUser(chProgram, provider, usdcMint, usdcAmount, oracleInfos);
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
		let market = clearingHouse.getMarketAccount(0);
		const prevSqrtK = market.amm.sqrtK;
		const prevbar = market.amm.baseAssetReserve;
		const prevqar = market.amm.quoteAssetReserve;

		console.log('adding liquidity...');
		const txsig = await clearingHouse.addLiquidity(
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
		const txSig = await clearingHouse.removeLiquidity(market.marketIndex);

		market = clearingHouse.getMarketAccount(0);
		const user = clearingHouseUser.getUserAccount();
		const lp_token_amount = user.positions[0].lpShares;
		console.log('lp token amount:', lp_token_amount.toString());
		assert(lp_token_amount.eq(ZERO));

		console.log('asset reserves:');
		console.log(prevSqrtK.toString(), market.amm.sqrtK.toString());
		console.log(prevbar.toString(), market.amm.baseAssetReserve.toString());
		console.log(prevqar.toString(), market.amm.quoteAssetReserve.toString());

		const err_threshold = new BN(500000);
		assert(prevSqrtK.eq(market.amm.sqrtK));
		assert(
			prevbar.sub(market.amm.baseAssetReserve).abs().lte(err_threshold),
			prevbar.sub(market.amm.baseAssetReserve).abs().toString()
		);
		assert(
			prevqar.sub(market.amm.quoteAssetReserve).abs().lte(err_threshold),
			prevqar.sub(market.amm.quoteAssetReserve).abs().toString()
		);
		assert(prevSqrtK.eq(market.amm.sqrtK));
	});

	it('mints too many lp tokens', async () => {
		console.log('adding liquidity...');
		let market = clearingHouse.getMarketAccount(ZERO);
		try {
			await clearingHouse.addLiquidity(market.amm.sqrtK, market.marketIndex);
		} catch (e) {
			assert(e.message.includes('0x1773')); // insufficient collateral
		}
	});

	it('provides lp, users shorts, removes lp, lp has long', async () => {
		console.log('adding liquidity...');

		const market = clearingHouse.getMarketAccount(new BN(0));
		const sig = await clearingHouse.addLiquidity(
			new BN(100 * 1e13),
			market.marketIndex
		);

		let user = clearingHouseUser.getUserAccount();
		console.log(user.positions[0].lpShares.toString());

		// some user goes long (lp should get a short)
		console.log('user trading...');
		let tradeSize = new BN(40 * 1e13);
		let newPrice;

		newPrice = await price_post_swap(tradeSize, SwapDirection.ADD, market);
		console.log('post trade price:', newPrice);
		let txsig = await traderClearingHouse.openPosition(
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
		const txSig = await clearingHouse.removeLiquidity(market.marketIndex);
		// view_logs(txSig);

		user = clearingHouseUser.getUserAccount();
		const lp_position = user.positions[0];
		const lp_token_amount = lp_position.lpShares;

		console.log('lp tokens', lp_token_amount.toString());
		console.log(
			'baa, qaa',
			lp_position.baseAssetAmount.toString(),
			lp_position.quoteAssetAmount.toString(),
			lp_position.unsettledPnl.toString()
		);

		assert(lp_position.unsettledPnl.gt(ZERO)); // get paid fees
		assert(lp_token_amount.eq(new BN(0)));
		assert(user.positions[0].baseAssetAmount.gt(new BN(0))); // lp is short
		assert(!user.positions[0].quoteAssetAmount.eq(new BN(0)));

		console.log('closing trader ...');
		await price_post_swap(tradeSize, SwapDirection.REMOVE, market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('closing lp ...');
		console.log(user.positions[0].baseAssetAmount.div(new BN(1e13)).toString());
		await price_post_swap(
			user.positions[0].baseAssetAmount,
			SwapDirection.ADD,
			market
		);
		await clearingHouse.closePosition(new BN(0)); // close lp position

		let user2 = clearingHouseUser.getUserAccount();
		console.log(user2.positions[0].lpShares.toString());
		let position2 = user2.positions[0];
		console.log(
			position2.baseAssetAmount.toString(),
			position2.quoteAssetAmount.toString()
		);

		console.log('done!');
	});

	it('provides lp, users longs, removes lp, lp has short', async () => {
		const market = clearingHouse.getMarketAccount(ZERO);

		console.log('adding liquidity...');
		const sig = await clearingHouse.addLiquidity(
			new BN(100 * 1e13),
			market.marketIndex
		);

		// some user goes long (lp should get a short)
		console.log('user trading...');
		let tradeSize = new BN(40 * 1e13);
		await price_post_swap(tradeSize, SwapDirection.REMOVE, market);
		let txsig = await traderClearingHouse.openPosition(
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
		const txSig = await clearingHouse.removeLiquidity(market.marketIndex);

		let user = clearingHouseUser.getUserAccount();
		const lp_position = user.positions[0];
		const lp_token_amount = lp_position.lpShares;

		console.log('lp tokens', lp_token_amount.toString());
		console.log(
			'baa, qaa, upnl',
			lp_position.baseAssetAmount.toString(),
			lp_position.quoteAssetAmount.toString(),
			lp_position.unsettledPnl.toString()
		);

		assert(lp_position.unsettledPnl.gt(ZERO)); // get paid fees
		assert(lp_token_amount.eq(ZERO));
		assert(user.positions[0].baseAssetAmount.lt(ZERO)); // lp is short
		assert(!user.positions[0].quoteAssetAmount.eq(ZERO));

		console.log('closing trader...');
		await price_post_swap(tradeSize, SwapDirection.ADD, market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('closing lp ...');
		await price_post_swap(
			user.positions[0].baseAssetAmount,
			SwapDirection.REMOVE,
			market
		);
		await clearingHouse.closePosition(new BN(0)); // close lp position

		console.log('done!');
	});

	it('lp gets paid in funding', async () => {
		let market = clearingHouse.getMarketAccount(new BN(1));
		let marketIndex = market.marketIndex;

		console.log('adding liquidity...');
		const sig = await clearingHouse.addLiquidity(
			new BN(100_000).mul(new BN(1e13)),
			marketIndex
		);

		console.log('user trading...');
		let tradeSize = new BN(100 * 1e13).mul(new BN(30));
		await traderClearingHouse.openPosition(
			PositionDirection.LONG,
			tradeSize,
			marketIndex
		);

		console.log('updating funding rates');
		let txsig = await clearingHouse.updateFundingRate(solusdc2, marketIndex);

		console.log('removing liquidity...');
		try {
			const txSig = await clearingHouse.removeLiquidity(marketIndex);
		} catch (e) {
			console.log(e);
		}

		const user = clearingHouseUser.getUserAccount();
		const fee_payment = new BN(1500000);
		const funding_payment = new BN(2300000);

		// dont get paid in fees bc the sqrtk is so big that fees dont get given to the lps
		assert(user.positions[1].unsettledPnl.eq(funding_payment.add(fee_payment)));
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
		const txsig = await clearingHouse.addLiquidity(lp_amount, new BN(0));

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
		const txsig = await traderClearingHouse.settleLP(
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
