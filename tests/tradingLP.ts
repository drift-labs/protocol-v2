import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BN, User, OracleSource, Wallet, MARGIN_PRECISION } from '../sdk';

import { Program } from '@coral-xyz/anchor';

import * as web3 from '@solana/web3.js';

import {
	TestClient,
	PRICE_PRECISION,
	PositionDirection,
	ZERO,
	OracleGuardRails,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

async function createNewUser(
	program,
	context: BankrunContextWrapper,
	usdcMint,
	usdcAmount,
	oracleInfos,
	wallet,
	bulkAccountLoader
) {
	let walletFlag = true;
	if (wallet == undefined) {
		const kp = new web3.Keypair();
		await context.fundKeypair(kp, 10 ** 9);
		wallet = new Wallet(kp);
		walletFlag = false;
	}

	console.log('wallet:', walletFlag);
	const usdcAta = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		context,
		wallet.publicKey
	);

	const driftClient = new TestClient({
		connection: context.connection.toConnection(),
		wallet: wallet,
		programID: program.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: [0, 1],
		spotMarketIndexes: [0],
		subAccountIds: [],
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
		// @ts-ignore
		driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	driftClientUser.subscribe();

	return [driftClient, driftClientUser];
}

describe('trading liquidity providing', () => {
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

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint: web3.Keypair;

	let driftClientUser: User;
	let traderDriftClient: TestClient;
	let traderDriftClientUser: User;

	let solusdc;
	let solusdc2;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		solusdc2 = await mockOracleNoProgram(bankrunContextWrapper, 1, -7); // make invalid
		solusdc = await mockOracleNoProgram(bankrunContextWrapper, 1, -7); // make invalid
		const oracleInfos = [
			{ publicKey: solusdc, source: OracleSource.PYTH },
			{ publicKey: solusdc2, source: OracleSource.PYTH },
		];
		[driftClient, driftClientUser] = await createNewUser(
			chProgram,
			bankrunContextWrapper,
			usdcMint,
			usdcAmount,
			oracleInfos,
			bankrunContextWrapper.provider.wallet,
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
		await driftClient.updatePerpMarketMarginRatio(
			0,
			MARGIN_PRECISION.toNumber() / 2,
			MARGIN_PRECISION.toNumber() / 4
		);

		[traderDriftClient, traderDriftClientUser] = await createNewUser(
			chProgram,
			bankrunContextWrapper,
			usdcMint,
			usdcAmount,
			oracleInfos,
			undefined,
			bulkAccountLoader
		);
	});

	after(async () => {
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
