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
	ClearingHouse,
	EventSubscriber,
	MARK_PRICE_PRECISION,
	PositionDirection,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { setFeedPrice } from '../stress/mockPythUtils';

async function price_post_swap(trader_position, market) {
	const price = calculatePrice(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
	console.log('price;', price.toNumber() / MARK_PRICE_PRECISION.toNumber());
	let swap_direction;
	if (trader_position.baseAssetAmount.gt(new BN(0))) {
		swap_direction = SwapDirection.ADD;
	} else {
		swap_direction = SwapDirection.REMOVE;
	}
	const [new_qaa, new_baa] = calculateAmmReservesAfterSwap(
		market.amm,
		'base',
		trader_position.baseAssetAmount.abs(),
		swap_direction
	);
	const _new_price = calculatePrice(new_baa, new_qaa, market.amm.pegMultiplier);
	const new_price = _new_price.toNumber() / MARK_PRICE_PRECISION.toNumber();
	console.log('post trade price:', new_price);
	await setFeedPrice(anchor.workspace.Pyth, new_price, market.amm.oracle);
}

describe('liquidity providing', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint: web3.Keypair;
	let userUSDCAccount: web3.Keypair;

	// ammInvariant == k == x * y
	//const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	//const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
	//mantissaSqrtScale
	//);
	//const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
	//mantissaSqrtScale
	//);
	const ammInitialBaseAssetReserve = new BN(200).mul(new BN(1e13));
	const ammInitialQuoteAssetReserve = new BN(200).mul(new BN(1e13));

	const usdcAmount = new BN(30 * 10 ** 13).mul(new BN(10));

	let traderKp: web3.Keypair;
	let traderClearingHouse: Admin;
	let traderUser: ClearingHouseUser;
	let traderClearingHouse2: Admin;
	let traderUser2: ClearingHouseUser;
	let clearingHouseUser: ClearingHouseUser;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0), new BN(1), new BN(2), new BN(3), new BN(4)],
			[new BN(0)]
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const solusdc = await mockOracle(1, -7); // make invalid
		const oracleInfos = [{ publicKey: solusdc, source: OracleSource.PYTH }];

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.initializeMarket(
			solusdc,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0)
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		clearingHouseUser.subscribe();
		// setup a new user to trade against lp
		const traderKp2 = new web3.Keypair();
		const sig2 = await provider.connection.requestAirdrop(
			traderKp2.publicKey,
			10 ** 9
		);
		await provider.connection.confirmTransaction(sig2);
		const traderUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			traderKp2.publicKey
		);

		traderClearingHouse2 = ClearingHouse.from(
			provider.connection,
			new Wallet(traderKp2),
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0), new BN(1), new BN(2), new BN(3), new BN(4)],
			[new BN(0)],
			oracleInfos
		);
		await traderClearingHouse2.subscribe();

		await traderClearingHouse2.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			traderUSDCAccount2.publicKey
		);

		traderUser2 = ClearingHouseUser.from(
			traderClearingHouse2,
			traderKp2.publicKey
		);
		await traderUser2.subscribe();

		// setup a new user to trade against lp
		traderKp = new web3.Keypair();
		const sig = await provider.connection.requestAirdrop(
			traderKp.publicKey,
			10 ** 9
		);
		await provider.connection.confirmTransaction(sig);
		const traderUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			traderKp.publicKey
		);

		traderClearingHouse = ClearingHouse.from(
			provider.connection,
			new Wallet(traderKp),
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0), new BN(1), new BN(2), new BN(3), new BN(4)],
			[new BN(0)],
			oracleInfos
		);
		await traderClearingHouse.subscribe();

		await traderClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			traderUSDCAccount.publicKey
		);

		traderUser = ClearingHouseUser.from(
			traderClearingHouse,
			traderKp.publicKey
		);
		await traderUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await traderClearingHouse.unsubscribe();
		await traderUser.unsubscribe();
		await traderClearingHouse2.unsubscribe();
		await traderUser2.unsubscribe();
	});

	it('provides and removes liquidity', async () => {
		let market = clearingHouse.getMarketAccount(0);
		const prevSqrtK = market.amm.sqrtK;
		const prevbar = market.amm.baseAssetReserve;
		const prevqar = market.amm.quoteAssetReserve;

		console.log('adding liquidity...');

		//let peg = market.amm.pegMultiplier.div(PEG_PRECISION).toNumber();
		//let sqrt_k = market.amm.sqrtK.div(new BN(1e13)).toNumber();
		//let full_amm = new BN(sqrt_k * peg * 2).mul(new BN(1e6));
		//let _lp_amount = full_amm.div(new BN(8));

		const txsig = await clearingHouse.addLiquidity(usdcAmount, new BN(0));

		console.log(
			'tx logs',
			(await connection.getTransaction(txsig, { commitment: 'confirmed' })).meta
				.logMessages
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

		assert(prevSqrtK.lt(market.amm.sqrtK)); // k increases = more liquidity
		assert(prevqar.lt(market.amm.quoteAssetReserve));
		assert(prevbar.lt(market.amm.baseAssetReserve));

		const user0 = clearingHouseUser.getUserAccount();
		const lpTokenAmount0 = user0.positions[0].lpTokens;
		console.log('lpTokenAmount0:', lpTokenAmount0.toString());
		assert(lpTokenAmount0.gt(new BN(0)));

		console.log('removing liquidity...');
		const txSig = await clearingHouse.removeLiquidity(new BN(0));
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		market = clearingHouse.getMarketAccount(0);
		const user = clearingHouseUser.getUserAccount();
		const lp_token_amount = user.positions[0].lpTokens;
		console.log('lp token amount:', lp_token_amount.toString());
		assert(lp_token_amount.eq(new BN(0)));

		// rounding off by one :(
		console.log('asset reserves:');
		console.log(prevSqrtK.toString(), market.amm.sqrtK.toString());
		console.log(prevbar.toString(), market.amm.baseAssetReserve.toString());
		console.log(prevqar.toString(), market.amm.quoteAssetReserve.toString());

		const err_threshold = new BN(500000);
		assert(prevSqrtK.eq(market.amm.sqrtK));
		assert(
			prevbar.sub(market.amm.baseAssetReserve).abs().lt(err_threshold),
			prevbar.sub(market.amm.baseAssetReserve).abs().toString()
		);
		assert(
			prevqar.sub(market.amm.quoteAssetReserve).abs().lt(err_threshold),
			prevqar.sub(market.amm.quoteAssetReserve).abs().toString()
		);
		assert(prevSqrtK.eq(market.amm.sqrtK));
	});

	it('provides lp, users longs, removes lp, lp has short', async () => {
		console.log('adding liquidity...');
		//let ix = await clearingHouse.getAddLiquidityIx(new BN(117 * 1e6), new BN(0));
		//let tx = new web3.Transaction().add(ix)
		//let res = await provider.simulate(tx);
		//console.log(res)

		const sig = await clearingHouse.addLiquidity(usdcAmount, new BN(0));
		console.log(
			'tx logs',
			(await connection.getTransaction(sig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		let user = clearingHouseUser.getUserAccount();
		console.log(user.positions[0].lpTokens.toString());

		// some user goes long (lp should get a short)
		console.log('user trading...');
		await traderClearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(13 * 1e6),
			new BN(0)
		);

		console.log('removing liquidity...');
		const txSig = await clearingHouse.removeLiquidity(new BN(0));

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		user = clearingHouseUser.getUserAccount();
		const lp_position = user.positions[0];
		const lp_token_amount = lp_position.lpTokens;

		assert(lp_token_amount.eq(new BN(0)));
		assert(user.positions[0].baseAssetAmount.lt(new BN(0))); // lp is short )
		assert(!user.positions[0].quoteAssetAmount.eq(new BN(0)));
		assert(user.positions[0].lpTokens.eq(new BN(0))); // tokens are burned
		//console.log(user)

		console.log('closing trader...');
		let market = clearingHouse.getMarketAccount(new BN(0));

		const trader = traderClearingHouse.getUserAccount();
		console.log(
			trader.positions[0].baseAssetAmount.div(new BN(1e13)).toString()
		);
		const trader_position = trader.positions[0];

		console.log('closing trader...');
		await price_post_swap(trader_position, market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('closing lp ...');
		console.log(user.positions[0].baseAssetAmount.div(new BN(1e13)).toString());

		market = clearingHouse.getMarketAccount(new BN(0));
		await price_post_swap(user.positions[0], market);
		await clearingHouse.closePosition(new BN(0)); // close lp position

		//// TODO: this guy cant close for some reason (errors out)
		//let sig = await traderClearingHouse2.closePosition(new BN(0));
		console.log('done!');
	});

	it('provides lp, users shorts, removes lp, lp has long', async () => {
		console.log('adding liquidity...');
		const txsig = await clearingHouse.addLiquidity(usdcAmount, new BN(0));
		console.log(
			'tx logs',
			(await connection.getTransaction(txsig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		let user = clearingHouseUser.getUserAccount();
		console.log(user.positions[0].lpTokens.toString());

		// some user goes long (lp should get a short)
		console.log('user trading...');
		await traderClearingHouse.openPosition(
			PositionDirection.SHORT,
			new BN(115 * 1e5),
			new BN(0)
		);

		console.log('removing liquidity...');
		const txSig = await clearingHouse.removeLiquidity(new BN(0));

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		user = clearingHouseUser.getUserAccount();
		const lp_position = user.positions[0];
		const lp_token_amount = lp_position.lpTokens;

		console.log(
			lp_position.lpTokens.toString(),
			lp_position.baseAssetAmount.toString(),
			lp_position.quoteAssetAmount.toString()
		);

		assert(lp_token_amount.eq(new BN(0)));
		assert(lp_position.baseAssetAmount.gt(new BN(0))); // lp is long
		assert(!lp_position.quoteAssetAmount.eq(new BN(0)));
		assert(lp_position.lpTokens.eq(new BN(0))); // tokens are burned

		console.log('closing lp...');
		let market = clearingHouse.getMarketAccount(new BN(0));
		await price_post_swap(user.positions[0], market);
		await clearingHouse.closePosition(new BN(0)); // close lp position

		console.log('closing trader...');
		const trader_user = traderClearingHouse.getUserAccount();
		market = clearingHouse.getMarketAccount(new BN(0));
		console.log(trader_user.positions[0]);
		await price_post_swap(trader_user.positions[0], market);
		await traderClearingHouse.closePosition(new BN(0));

		console.log('done!');
	});

	//it('provides lp, users shorts, settles lp for pnl', async () => {
	//console.log('adding liquidity...');
	//console.log(
	//clearingHouse.getUserAccount().positions[0]
	//)
	//const txSig = await clearingHouse.addLiquidity(usdcAmount, new BN(0));
	//console.log(
	//'tx logs',
	//(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
	//.logMessages
	//);

	//let user = clearingHouseUser.getUserAccount();
	//console.log(user.positions[0].lpTokens.toString());

	//// some user goes long (lp should get a short)
	//console.log('user trading...');
	//await traderClearingHouse2.openPosition(
	//PositionDirection.LONG,
	//new BN(13 * 1e6),
	//new BN(0)
	//);

	//console.log('settling lp...');
	//await clearingHouse.settleLP(
	//await clearingHouse.getUserAccountPublicKey(),
	//new BN(0)
	//)

	//user = clearingHouseUser.getUserAccount();
	//const lp_position = user.positions[0];
	//const lp_token_amount = lp_position.lpTokens;

	//console.log(
	//lp_position.baseAssetAmount.toString(),
	//lp_position.quoteAssetAmount.toString()
	//);

	//assert(lp_token_amount.eq(new BN(0)));
	//assert(lp_position.baseAssetAmount.gt(new BN(0))); // lp is long
	//assert(!lp_position.quoteAssetAmount.eq(new BN(0)));
	//assert(lp_position.lpTokens.eq(new BN(0))); // tokens are burned

	//await traderClearingHouse2.closePosition(new BN(0))
	//});
});
