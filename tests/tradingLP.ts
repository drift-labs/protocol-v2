import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, DriftUser, OracleSource, Wallet } from '../sdk';

import { Program } from '@project-serum/anchor';

import * as web3 from '@solana/web3.js';

import {
	AdminClient,
	EventSubscriber,
	PRICE_PRECISION,
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

	const driftClient = new AdminClient({
		connection: provider.connection,
		wallet: wallet,
		programID: program.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeUserId: 0,
		marketIndexes: [0, 1],
		bankIndexes: [0],
		oracleInfos,
	});
	await driftClient.subscribe();

	if (walletFlag) {
		await driftClient.initialize(usdcMint.publicKey, true);
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	}

	await driftClient.initializeUserAccountAndDepositCollateral(
		usdcAmount,
		usdcAta.publicKey
	);

	const driftUser = new DriftUser({
		driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
	});
	driftUser.subscribe();

	return [driftClient, driftUser];
}

describe('liquidity providing', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const driftProgram = anchor.workspace.Drift as Program;

	// ammInvariant == k == x * y
	const ammInitialBaseAssetReserve = new BN(300).mul(new BN(1e13));
	const ammInitialQuoteAssetReserve = new BN(300).mul(new BN(1e13));

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const stableAmmInitialQuoteAssetReserve = new anchor.BN(1 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const stableAmmInitialBaseAssetReserve = new anchor.BN(1 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(1_000_000_000 * 1e6);

	let driftClient: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, driftProgram);
	eventSubscriber.subscribe();

	let usdcMint: web3.Keypair;

	let driftUser: DriftUser;
	let traderDriftClient: AdminClient;
	let traderDriftUser: DriftUser;

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
		[driftClient, driftUser] = await createNewUser(
			driftProgram,
			provider,
			usdcMint,
			usdcAmount,
			oracleInfos,
			provider.wallet
		);
		// used for trading / taking on baa
		await driftClient.initializeMarket(
			solusdc,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(60 * 60)
		);
		await driftClient.updateLpCooldownTime(ZERO, new BN(0));
		await driftClient.updateMaxBaseAssetAmountRatio(new BN(0), 1);
		await driftClient.updateMarketBaseAssetAmountStepSize(new BN(0), new BN(1));

		// second market -- used for funding ..
		await driftClient.initializeMarket(
			solusdc2,
			stableAmmInitialBaseAssetReserve,
			stableAmmInitialQuoteAssetReserve,
			new BN(0)
		);
		await driftClient.updateLpCooldownTime(new BN(1), new BN(0));
		await driftClient.updatePerpAuctionDuration(new BN(0));

		[traderDriftClient, traderDriftUser] = await createNewUser(
			driftProgram,
			provider,
			usdcMint,
			usdcAmount,
			oracleInfos,
			undefined
		);
	});

	after(async () => {
		await eventSubscriber.unsubscribe();

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();

		await traderDriftClient.unsubscribe();
		await traderDriftUser.unsubscribe();
	});

	it('lp trades with short', async () => {
		let market = driftClient.getPerpMarketAccount(ZERO);

		console.log('adding liquidity...');
		const _sig = await driftClient.addLiquidity(
			new BN(100 * 1e13),
			market.marketIndex
		);

		// some user goes long (lp should get a short)
		console.log('user trading...');
		const tradeSize = new BN(40 * 1e13);
		const _txsig = await traderDriftClient.openPosition(
			PositionDirection.LONG,
			tradeSize,
			market.marketIndex
		);

		const position = traderDriftClient.getUserAccount().perp_positions[0];
		console.log(
			'trader position:',
			position.baseAssetAmount.toString(),
			position.quoteAssetAmount.toString()
		);
		assert(position.baseAssetAmount.gt(ZERO));

		// settle says the lp would take on a short
		const lpPosition = driftUser.getSettledLPPosition(ZERO)[0];
		console.log(
			'sdk settled lp position:',
			lpPosition.baseAssetAmount.toString(),
			lpPosition.quoteAssetAmount.toString()
		);
		assert(lpPosition.baseAssetAmount.lt(ZERO));
		assert(lpPosition.quoteAssetAmount.gt(ZERO));

		// lp trades a big long
		await driftClient.openPosition(
			PositionDirection.LONG,
			tradeSize,
			market.marketIndex
		);

		// lp now has a long
		const newLpPosition = driftUser.getUserAccount().perp_positions[0];
		console.log(
			'lp position:',
			newLpPosition.baseAssetAmount.toString(),
			newLpPosition.quoteAssetAmount.toString()
		);
		assert(newLpPosition.baseAssetAmount.gt(ZERO));
		assert(newLpPosition.quoteAssetAmount.lt(ZERO));
		// is still an lp
		assert(newLpPosition.lpShares.gt(ZERO));
		market = driftClient.getPerpMarketAccount(ZERO);

		console.log('done!');
	});
});
