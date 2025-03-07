import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	getMarketOrderParams,
	OracleGuardRails,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { BASE_PRECISION, OracleSource, PERCENTAGE_PRECISION } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

function getOpenInterest(driftClient: TestClient, marketIndex: number) {
	const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
	return BN.max(
		perpMarket.amm.baseAssetAmountLong,
		perpMarket.amm.baseAssetAmountShort.abs()
	);
}

describe('trigger orders', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let driftClient: TestClient;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let solUsd;

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.muln(2),
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [
			{
				publicKey: solUsd,
				source: OracleSource.PYTH,
			},
		];

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION.mul(new BN(10)),
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION.mul(new BN(10)),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(55), // allow 55x change
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey,
			0,
			1
		);
	});

	beforeEach(async () => {
		await driftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('transfer long position', async () => {
		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		try {
			await driftClient.transferPerpPosition(
				1,
				0,
				marketIndex,
				baseAssetAmount
			);
			assert.fail('should throw error');
		} catch (e) {
			// should throw error
		}

		const oiBefore = getOpenInterest(driftClient, marketIndex);

		await driftClient.transferPerpPosition(0, 1, marketIndex, baseAssetAmount);

		const firstUserBaseAssetAmount = driftClient
			.getUser(0)
			.getPerpPosition(marketIndex).baseAssetAmount;
		const secondUserBaseAssetAmount = driftClient
			.getUser(1)
			.getPerpPosition(marketIndex).baseAssetAmount;

		assert.equal(firstUserBaseAssetAmount.toString(), '0');
		assert.equal(
			secondUserBaseAssetAmount.toString(),
			baseAssetAmount.toString()
		);

		const oiAfter = getOpenInterest(driftClient, marketIndex);
		assert.equal(oiAfter.toString(), oiBefore.toString());
	});

	it('transfer short position', async () => {
		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.muln(-1);
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: baseAssetAmount.abs(),
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		try {
			await driftClient.transferPerpPosition(
				1,
				0,
				marketIndex,
				baseAssetAmount
			);
			assert.fail('should throw error');
		} catch (e) {
			// should throw error
		}

		await driftClient.transferPerpPosition(0, 1, marketIndex, baseAssetAmount);

		await driftClient.fetchAccounts();

		const firstUserBaseAssetAmount = driftClient
			.getUser(0)
			.getPerpPosition(marketIndex).baseAssetAmount;

		assert.equal(firstUserBaseAssetAmount.toString(), '0');
		assert.equal(
			driftClient.getUser(1).getPerpPosition(marketIndex),
			undefined
		);

		const oiAfter = getOpenInterest(driftClient, marketIndex);
		assert.equal(oiAfter.toString(), '0');
	});
});
