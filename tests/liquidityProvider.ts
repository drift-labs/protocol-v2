import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BN,
	ClearingHouseUser,
	OracleSource,
	QUOTE_ASSET_BANK_INDEX,
	QUOTE_PRECISION,
	Wallet,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';
import * as web3 from '@solana/web3.js';

import {
	Admin,
	ClearingHouse,
	EventSubscriber,
	findComputeUnitConsumption,
	MARK_PRICE_PRECISION,
	PositionDirection,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
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

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

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

		let solusdc = await mockOracle(1);
		const oracleInfos = [{ publicKey: solusdc, source: OracleSource.PYTH }];

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.initializeMarket(
			solusdc,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0)
		);

		[, userAccountPublicKey] =
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
		let traderKp = new web3.Keypair();
		const sig = await provider.connection.requestAirdrop(
			traderKp.publicKey,
			10 ** 9
		);
		await provider.connection.confirmTransaction(sig);
		let traderUSDCAccount = await mockUserUSDCAccount(
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

		let traderAccountPk =
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
	});

	// adds lp when
	//      fresh-init market [x]
	//      non-fresh-init market
	it('provides and removes liquidity', async () => {
		var market = clearingHouse.getMarketAccount(0);
		//var market = await chProgram.account.market.fetch(market.pubkey);
		const prevSqrtK = market.amm.sqrtK;
		const prevbar = market.amm.baseAssetReserve;
		const prevqar = market.amm.quoteAssetReserve;

		console.log('adding liquidity...');
		await chProgram.methods
			.addLiquidity(new BN(117 * 1e6), new BN(0))
			.accounts({
				state: await clearingHouse.getStatePublicKey(),
				user: await clearingHouse.getUserAccountPublicKey(),
				authority: clearingHouse.wallet.publicKey,
				oracle: clearingHouse.getMarketAccount(0).amm.oracle,
			})
			.remainingAccounts([
				{
					pubkey: market.pubkey,
					isSigner: false,
					isWritable: true,
				},
			])
			.rpc();

		//var market = await chProgram.account.market.fetch(market.pubkey);
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

		const user0 = await chProgram.account.user.fetch(
			await clearingHouse.getUserAccountPublicKey()
		);
		const lpTokenAmount0 = user0.positions[0].lpTokens;
		console.log('lpTokenAmount0:', lpTokenAmount0.toString());
		assert(lpTokenAmount0.gt(new BN(0)));

		console.log('removing liquidity...');
		const txSig = await chProgram.methods
			.removeLiquidity(new BN(0))
			.accounts({
				state: await clearingHouse.getStatePublicKey(),
				user: await clearingHouse.getUserAccountPublicKey(),
				authority: clearingHouse.wallet.publicKey,
				oracle: clearingHouse.getMarketAccount(0).amm.oracle,
			})
			.remainingAccounts([
				{
					pubkey: market.pubkey,
					isSigner: false,
					isWritable: true,
				},
			])
			.rpc();
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		market = clearingHouse.getMarketAccount(0);
		const user = await chProgram.account.user.fetch(
			await clearingHouse.getUserAccountPublicKey()
		);
		const lp_token_amount = user.positions[0].lpTokens;

		assert(lp_token_amount.eq(new BN(0)));

		// rounding off by one :(
		console.log('asset reserves:');
		console.log(prevSqrtK.toString(), market.amm.sqrtK.toString());
		console.log(prevbar.toString(), market.amm.baseAssetReserve.toString());
		console.log(prevqar.toString(), market.amm.quoteAssetReserve.toString());

		assert(prevSqrtK.eq(market.amm.sqrtK));
		assert(prevbar.sub(market.amm.baseAssetReserve).abs().lt(new BN(10000)));
		assert(prevqar.sub(market.amm.quoteAssetReserve).abs().lt(new BN(10000)));
		//assert(prevSqrtK.eq(market.amm.sqrtK))
	});

	it('provides lp, users trade, removes lp', async () => {
		var market = clearingHouse.getMarketAccount(0);
		const prevSqrtK = market.amm.sqrtK;
		const prevbar = market.amm.baseAssetReserve;
		const prevqar = market.amm.quoteAssetReserve;

		console.log('adding liquidity...');
		await chProgram.methods
			.addLiquidity(new BN(100 * 1e6), new BN(0))
			.accounts({
				state: await clearingHouse.getStatePublicKey(),
				user: await clearingHouse.getUserAccountPublicKey(),
				authority: clearingHouse.wallet.publicKey,
				oracle: clearingHouse.getMarketAccount(0).amm.oracle,
			})
			.remainingAccounts([
				{
					pubkey: market.pubkey,
					isSigner: false,
					isWritable: true,
				},
			])
			.rpc();

		// some user goes long (lp should get a short)
		await traderClearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(100 * 1e6),
			new BN(0)
		);

		console.log('removing liquidity...');
		await chProgram.methods
			.removeLiquidity(new BN(0))
			.accounts({
				state: await clearingHouse.getStatePublicKey(),
				user: await clearingHouse.getUserAccountPublicKey(),
				authority: clearingHouse.wallet.publicKey,
				oracle: clearingHouse.getMarketAccount(0).amm.oracle,
			})
			.remainingAccounts([
				{
					pubkey: market.pubkey,
					isSigner: false,
					isWritable: true,
				},
			])
			.rpc();

		market = clearingHouse.getMarketAccount(0);
		var user = await chProgram.account.user.fetch(
			await clearingHouse.getUserAccountPublicKey()
		);
		var lp_token_amount = user.positions[0].lpTokens;

		assert(lp_token_amount.eq(new BN(0)));
		assert(prevSqrtK.eq(market.amm.sqrtK));

		assert(user.positions[0].baseAssetAmount.lt(new BN(0))); // lp is short )
		assert(!user.positions[0].quoteAssetAmount.eq(new BN(0)));
		assert(user.positions[0].lpTokens.eq(new BN(0))); // tokens are burned
	});
});
