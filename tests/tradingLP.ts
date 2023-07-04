import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BN, User, OracleSource, Wallet, BulkAccountLoader } from '../sdk';

import { Program } from '@coral-xyz/anchor';

import * as web3 from '@solana/web3.js';

import {
	TestClient,
	EventSubscriber,
	PRICE_PRECISION,
	PositionDirection,
	ZERO,
	OracleGuardRails,
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
		perpMarketIndexes: [0, 1],
		spotMarketIndexes: [0],
		oracleInfos,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
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

describe('trading liquidity providing', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

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
		await driftClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);
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
			useForLiquidations: true,
		};
		await driftClient.updateOracleGuardRails(oracleGuardRails);

		// second market -- used for funding ..
		await driftClient.initializePerpMarket(
			1,
			solusdc2,
			stableAmmInitialBaseAssetReserve,
			stableAmmInitialQuoteAssetReserve,
			new BN(0)
		);
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
	});

	after(async () => {
		await eventSubscriber.unsubscribe();

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();

		await traderDriftClient.unsubscribe();
		await traderDriftClientUser.unsubscribe();
	});

	it('lp trades with short', async () => {
		let market = driftClient.getPerpMarketAccount(0);

		console.log('adding liquidity...');
		const _sig = await driftClient.addPerpLpShares(
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

		await traderDriftClient.fetchAccounts();
		const position = traderDriftClient.getUserAccount().perpPositions[0];
		console.log(
			'trader position:',
			position.baseAssetAmount.toString(),
			position.quoteAssetAmount.toString()
		);
		assert(position.baseAssetAmount.gt(ZERO));

		// settle says the lp would take on a short
		const lpPosition = driftClientUser.getPerpPositionWithLPSettle(0)[0];
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
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// lp now has a long
		const newLpPosition = driftClientUser.getUserAccount().perpPositions[0];
		console.log(
			'lp position:',
			newLpPosition.baseAssetAmount.toString(),
			newLpPosition.quoteAssetAmount.toString()
		);
		assert(newLpPosition.baseAssetAmount.gt(ZERO));
		assert(newLpPosition.quoteAssetAmount.lt(ZERO));
		// is still an lp
		assert(newLpPosition.lpShares.gt(ZERO));
		market = driftClient.getPerpMarketAccount(0);

		console.log('done!');
	});
});
