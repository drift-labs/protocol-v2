import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	TestClient,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	OracleGuardRails,
	LIQUIDATION_PCT_PRECISION,
	convertToNumber,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
} from './testHelpers';
import {
	isVariant,
	PERCENTAGE_PRECISION,
	QUOTE_PRECISION,
	UserStatus,
} from '../sdk';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('liquidate perp pnl for deposit', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorDriftClient: TestClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);
	let liquidatorKeypair: Keypair;

	let _throwaway: PublicKey;

	before(async () => {
		const context = await startAnchor("", [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, bankrunContextWrapper);
		userWSOLAccount = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			new BN(5 * 10 ** 9)
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram,
		);

		await eventSubscriber.subscribe();

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
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
		await initializeSolSpotMarket(driftClient, solOracle);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(10).mul(PERCENTAGE_PRECISION),
				oracleTwap5MinPercentDivergence: new BN(100).mul(PERCENTAGE_PRECISION),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(55), // allow 55x change
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		await driftClient.openPosition(
			PositionDirection.SHORT,
			new BN(10).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		const solAmount = new BN(10 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount, _throwaway, liquidatorKeypair] =
			await createUserWithUSDCAndWSOLAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				solAmount.mul(new BN(2000)),
				usdcAmount,
				[0],
				[0, 1],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				],
				bulkAccountLoader
			);
		await liquidatorDriftClient.subscribe();

		const spotMarketIndex = 1;

		await liquidatorDriftClient.deposit(
			solAmount.mul(new BN(1000)),
			spotMarketIndex,
			liquidatorDriftClientWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await driftClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});
	
	it('liquidate', async () => {
		await setFeedPriceNoProgram(bankrunContextWrapper, 50, solOracle);
		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);
		await driftClient.updateLiquidationDuration(1);

		const txSig0 = await liquidatorDriftClient.liquidatePerp(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

		bankrunContextWrapper.connection.printTxLogs(txSig0);

		try {
			await liquidatorDriftClient.liquidatePerpPnlForDeposit(
				await driftClient.getUserAccountPublicKey(),
				driftClient.getUserAccount(),
				0,
				0,
				usdcAmount.mul(new BN(100))
			);
		} catch (e) {
			console.log('FAILED to perp pnl settle before paying off borrow');
			// console.error(e);
		}

		// pay off borrow first (and withdraw all excess in attempt to full pay)
		await driftClient.deposit(new BN(5.02 * 10 ** 8), 1, userWSOLAccount);
		// await driftClient.withdraw(new BN(1 * 10 ** 8), 1, userWSOLAccount, true);
		await driftClient.fetchAccounts();

		// const u = driftClient.getUserAccount();
		// console.log(u.spotPositions[0]);
		// console.log(u.spotPositions[1]);
		// console.log(u.perpPositions[0]);
		
		const txSig = await liquidatorDriftClient.liquidatePerpPnlForDeposit(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			0,
			usdcAmount.mul(new BN(600))
		);

		const computeUnits = bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		console.log('user status:', driftClient.getUserAccount().status);
		console.log(
			'user collateral:',
			convertToNumber(
				driftClient.getUser().getTotalCollateral(),
				QUOTE_PRECISION
			)
		);

		assert(driftClient.getUserAccount().status === UserStatus.BEING_LIQUIDATED);

		assert(driftClient.getUserAccount().nextLiquidationId === 2);
		assert(
			driftClient.getUserAccount().spotPositions[0].scaledBalance.eq(ZERO)
		);
		assert(
			driftClient.getUserAccount().spotPositions[1].scaledBalance.gt(ZERO)
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(liquidationRecord.liquidationId === 1);
		assert(
			isVariant(liquidationRecord.liquidationType, 'liquidatePerpPnlForDeposit')
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.marketOraclePrice.eq(
				new BN(50).mul(PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidatePerpPnlForDeposit.perpMarketIndex === 0);
		console.log(liquidationRecord.liquidatePerpPnlForDeposit.pnlTransfer);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.pnlTransfer.eq(
				new BN(10000000)
			)
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.assetPrice.eq(
				PRICE_PRECISION
			)
		);
		assert(liquidationRecord.liquidatePerpPnlForDeposit.assetMarketIndex === 0);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.assetTransfer.eq(
				new BN(10000000)
			)
		);
	});
});
