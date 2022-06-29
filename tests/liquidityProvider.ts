import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, ClearingHouseUser, OracleSource, Wallet } from '../sdk';

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
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(30 * 10 ** 8);

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

		const solusdc = await mockOracle(1);
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
		const traderKp = new web3.Keypair();
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
		const txsig = await clearingHouse.addLiquidity(
			new BN(117 * 1e6),
			new BN(0)
		);

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
		await clearingHouse.addLiquidity(new BN(117 * 1e6), new BN(0));

		let user = clearingHouseUser.getUserAccount();
		console.log(user.positions[0].lpTokens.toString());

		// some user goes long (lp should get a short)
		console.log('user trading...');
		await traderClearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(100 * 1e6),
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
	});

	it('provides lp, users shorts, removes lp, lp has long', async () => {
		console.log('adding liquidity...');
		await clearingHouse.addLiquidity(new BN(117 * 1e6), new BN(0));

		let user = clearingHouseUser.getUserAccount();
		console.log(user.positions[1].lpTokens.toString());

		// some user goes long (lp should get a short)
		console.log('user trading...');
		await traderClearingHouse2.openPosition(
			PositionDirection.SHORT,
			new BN(2000 * 1e6),
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
		const lp_position = user.positions[1];
		const lp_token_amount = lp_position.lpTokens;

		console.log(
			lp_position.baseAssetAmount.toString(),
			lp_position.quoteAssetAmount.toString()
		);

		assert(lp_token_amount.eq(new BN(0)));
		assert(lp_position.baseAssetAmount.gt(new BN(0))); // lp is long
		assert(!lp_position.quoteAssetAmount.eq(new BN(0)));
		assert(lp_position.lpTokens.eq(new BN(0))); // tokens are burned
	});
});
