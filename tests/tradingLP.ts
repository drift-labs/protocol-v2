import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, ClearingHouseUser, OracleSource, Wallet } from '../sdk';

import { Program } from '@project-serum/anchor';

import * as web3 from '@solana/web3.js';

import {
	Admin,
	EventSubscriber,
	MARK_PRICE_PRECISION,
	PositionDirection,
	ZERO,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

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
		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
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

	// ammInvariant == k == x * y
	const ammInitialBaseAssetReserve = new BN(300).mul(new BN(1e13));
	const ammInitialQuoteAssetReserve = new BN(300).mul(new BN(1e13));

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
		// used for trading / taking on baa
		await clearingHouse.initializeMarket(
			solusdc,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(60 * 60)
		);
		await clearingHouse.updateLpCooldownTime(ZERO, new BN(0));
		await clearingHouse.updateMaxBaseAssetAmountRatio(new BN(0), 1);
		await clearingHouse.updateMarketBaseAssetAmountStepSize(
			new BN(0),
			new BN(1)
		);

		// second market -- used for funding ..
		await clearingHouse.initializeMarket(
			solusdc2,
			stableAmmInitialBaseAssetReserve,
			stableAmmInitialQuoteAssetReserve,
			new BN(0)
		);
		await clearingHouse.updateLpCooldownTime(new BN(1), new BN(0));
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

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
	});

	it('lp trades with short', async () => {
		let market = clearingHouse.getPerpMarketAccount(ZERO);

		console.log('adding liquidity...');
		const _sig = await clearingHouse.addLiquidity(
			new BN(100 * 1e13),
			market.marketIndex
		);

		// some user goes long (lp should get a short)
		console.log('user trading...');
		const tradeSize = new BN(40 * 1e13);
		const _txsig = await traderClearingHouse.openPosition(
			PositionDirection.LONG,
			tradeSize,
			market.marketIndex
		);

		const position = traderClearingHouse.getUserAccount().perp_positions[0];
		console.log(
			'trader position:',
			position.baseAssetAmount.toString(),
			position.quoteAssetAmount.toString()
		);
		assert(position.baseAssetAmount.gt(ZERO));

		// settle says the lp would take on a short
		const lpPosition = clearingHouseUser.getSettledLPPosition(ZERO)[0];
		console.log(
			'sdk settled lp position:',
			lpPosition.baseAssetAmount.toString(),
			lpPosition.quoteAssetAmount.toString()
		);
		assert(lpPosition.baseAssetAmount.lt(ZERO));
		assert(lpPosition.quoteAssetAmount.gt(ZERO));

		// lp trades a big long
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			tradeSize,
			market.marketIndex
		);

		// lp now has a long
		const newLpPosition = clearingHouseUser.getUserAccount().perp_positions[0];
		console.log(
			'lp position:',
			newLpPosition.baseAssetAmount.toString(),
			newLpPosition.quoteAssetAmount.toString()
		);
		assert(newLpPosition.baseAssetAmount.gt(ZERO));
		assert(newLpPosition.quoteAssetAmount.lt(ZERO));
		// is still an lp
		assert(newLpPosition.lpShares.gt(ZERO));
		market = clearingHouse.getPerpMarketAccount(ZERO);

		console.log('done!');
	});
});
