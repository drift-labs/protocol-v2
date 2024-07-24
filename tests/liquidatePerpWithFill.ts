import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	EventSubscriber,
	isVariant,
	LIQUIDATION_PCT_PRECISION,
	OracleGuardRails,
	OracleSource,
	PositionDirection,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	TestClient,
	Wallet,
} from '../sdk/src';
import { assert } from 'chai';

import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import { OrderType, PERCENTAGE_PRECISION, PerpOperation } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('liquidate perp (no open orders)', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	const liquidatorKeyPair = new Keypair();
	let liquidatorUSDCAccount: Keypair;
	let liquidatorDriftClient: TestClient;

	let makerDriftClient: TestClient;
	let makerUSDCAccount: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);
	const makerUsdcAmount = new BN(1000 * 10 ** 6);

	let oracle: PublicKey;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			//@ts-ignore
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION.muln(100),
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION.muln(100),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(11), // allow 11x change
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,

			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(175).mul(BASE_PRECISION).div(new BN(10)), // 17.5 SOL
			0,
			new BN(0)
		);

		bankrunContextWrapper.fundKeypair(liquidatorKeyPair, LAMPORTS_PER_SOL);
		liquidatorUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			liquidatorKeyPair.publicKey
		);
		liquidatorDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(liquidatorKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await liquidatorDriftClient.subscribe();

		await liquidatorDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			liquidatorUSDCAccount.publicKey
		);

		[makerDriftClient, makerUSDCAccount] = await createUserWithUSDCAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			makerUsdcAmount,
			[0],
			[0],
			[
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			bulkAccountLoader
		);

		await makerDriftClient.deposit(makerUsdcAmount, 0, makerUSDCAccount);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPriceNoProgram(bankrunContextWrapper, 0.1, oracle);
		await driftClient.updatePerpMarketPausedOperations(
			0,
			PerpOperation.AMM_FILL
		);

		try {
			const failToPlaceTxSig = await driftClient.placePerpOrder({
				direction: PositionDirection.SHORT,
				baseAssetAmount: BASE_PRECISION,
				price: PRICE_PRECISION.divn(10),
				orderType: OrderType.LIMIT,
				reduceOnly: true,
				marketIndex: 0,
			});
			bankrunContextWrapper.connection.printTxLogs(failToPlaceTxSig);
			throw new Error('Expected placePerpOrder to throw an error');
		} catch (error) {
			if (
				error.message !==
				'Error processing Instruction 1: custom program error: 0x1773'
			) {
				throw new Error(`Unexpected error message: ${error.message}`);
			}
		}

		await makerDriftClient.placePerpOrder({
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(175).mul(BASE_PRECISION),
			price: PRICE_PRECISION.divn(10),
			orderType: OrderType.LIMIT,
			marketIndex: 0,
		});

		const makerInfos = [
			{
				maker: await makerDriftClient.getUserAccountPublicKey(),
				makerStats: makerDriftClient.getUserStatsAccountPublicKey(),
				makerUserAccount: makerDriftClient.getUserAccount(),
			},
		];

		const txSig = await liquidatorDriftClient.liquidatePerpWithFill(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			makerInfos
		);

		bankrunContextWrapper.connection.printTxLogs(txSig);

		for (let i = 0; i < 32; i++) {
			assert(isVariant(driftClient.getUserAccount().orders[i].status, 'init'));
		}

		assert(
			liquidatorDriftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(175))
		);

		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(0))
		);

		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-15769403))
		);

		assert(
			liquidatorDriftClient.getPerpMarketAccount(0).ifLiquidationFee === 10000
		);

		assert(
			makerDriftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(17500000000))
		);

		assert(
			makerDriftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-1749650))
		);

		assert(
			liquidatorDriftClient.getPerpMarketAccount(0).ifLiquidationFee === 10000
		);

		await makerDriftClient.liquidatePerpPnlForDeposit(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			0,
			QUOTE_PRECISION.muln(20)
		);

		await makerDriftClient.resolvePerpBankruptcy(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0
		);
	});
});
