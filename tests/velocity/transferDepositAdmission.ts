import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { assert } from 'chai';

import {
	BN,
	EventSubscriber,
	MarketStatus,
	OracleInfo,
	OracleSource,
	QUOTE_PRECISION,
	SpotBalanceType,
	TestClient,
	ZERO,
	getTokenAmount,
	isVariant,
} from '../../packages/sdk/src';

import {
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

// Regression tests for the same-market `transfer_deposit` admission gaps:
//   * the recipient credit must obey direct-deposit admission (active spot-market
//     status for positive deposit balances + the aggregate `max_token_deposits` cap);
//   * the source debit must obey direct-withdraw's reduce-only cap so an internal
//     transfer can't open or grow a borrow in a reduce-only market.
describe('transfer deposit admission', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;
	let usdcMint;
	let usdcAccount: PublicKey;
	let wSolAccount: PublicKey;

	const QUOTE_MARKET_INDEX = 0;
	const SOL_MARKET_INDEX = 1;

	const FROM_SUB = 1;
	const TO_SUB = 0;

	const usdcCollateral = new BN(1_000).mul(QUOTE_PRECISION); // 1000 USDC
	const transferAmount = new BN(10).mul(QUOTE_PRECISION); // 10 USDC
	const solDeposit = new BN(5).mul(new BN(10 ** 9)); // 5 SOL (liquidity for borrow)
	const solBorrow = new BN(10 ** 8); // 0.1 SOL borrow

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
			chProgram
		);
		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		usdcAccount = (
			await mockUserUSDCAccount(
				usdcMint,
				usdcCollateral.muln(10),
				bankrunContextWrapper
			)
		).publicKey;
		wSolAccount = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			solDeposit.muln(2)
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		const spotMarketIndexes = [QUOTE_MARKET_INDEX, SOL_MARKET_INDEX];
		const oracleInfos: OracleInfo[] = [
			{ publicKey: solOracle, source: OracleSource.PYTH_LAZER },
		];

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes,
			subAccountIds: [],
			userStats: true,
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(velocityClient, solOracle);

		// to_user (sub 0): seed USDC + SOL (the SOL deposit provides borrow liquidity).
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcCollateral,
			usdcAccount,
			QUOTE_MARKET_INDEX,
			TO_SUB
		);
		await velocityClient.deposit(
			solDeposit,
			SOL_MARKET_INDEX,
			wSolAccount,
			TO_SUB
		);

		// from_user (sub 1): seed USDC collateral so it can later borrow SOL.
		await velocityClient.initializeUserAccount(FROM_SUB);
		await velocityClient.addUser(FROM_SUB);
		await velocityClient.deposit(
			usdcCollateral,
			QUOTE_MARKET_INDEX,
			usdcAccount,
			FROM_SUB
		);

		await velocityClient.updateUserMarginTradingEnabled([
			{ marginTradingEnabled: true, subAccountId: TO_SUB },
			{ marginTradingEnabled: true, subAccountId: FROM_SUB },
		]);

		await velocityClient.fetchAccounts();
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('rejects a recipient deposit while the spot market is not active', async () => {
		await velocityClient.updateSpotMarketStatus(
			QUOTE_MARKET_INDEX,
			MarketStatus.SETTLEMENT
		);

		let failed = false;
		try {
			await velocityClient.transferDeposit(
				transferAmount,
				QUOTE_MARKET_INDEX,
				FROM_SUB,
				TO_SUB
			);
		} catch (e) {
			// MarketActionPaused
			assert(e.toString().includes('0x1802'));
			failed = true;
		}
		assert(failed, 'transfer into a non-active market should fail');

		// Restore the market and confirm the same transfer now succeeds.
		await velocityClient.updateSpotMarketStatus(
			QUOTE_MARKET_INDEX,
			MarketStatus.ACTIVE
		);
		await velocityClient.transferDeposit(
			transferAmount,
			QUOTE_MARKET_INDEX,
			FROM_SUB,
			TO_SUB
		);
	});

	it('enforces the aggregate deposit cap on the recipient credit', async () => {
		await velocityClient.fetchAccounts();
		const spotMarket = velocityClient.getSpotMarketAccount(QUOTE_MARKET_INDEX);
		const deposits = getTokenAmount(
			spotMarket.depositBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		// Cap the market just below its current deposits: the transfer path must now
		// run direct-deposit's `validate_max_token_deposits_and_borrows` and reject.
		await velocityClient.updateSpotMarketMaxTokenDeposits(
			QUOTE_MARKET_INDEX,
			deposits.subn(1)
		);

		let failed = false;
		try {
			await velocityClient.transferDeposit(
				transferAmount,
				QUOTE_MARKET_INDEX,
				FROM_SUB,
				TO_SUB
			);
		} catch (e) {
			// MaxDeposit
			assert(e.toString().includes('0x1796'));
			failed = true;
		}
		assert(failed, 'transfer past the deposit cap should fail');

		// Lift the cap (0 == unlimited) and confirm the transfer succeeds again.
		await velocityClient.updateSpotMarketMaxTokenDeposits(
			QUOTE_MARKET_INDEX,
			ZERO
		);
		await velocityClient.transferDeposit(
			transferAmount,
			QUOTE_MARKET_INDEX,
			FROM_SUB,
			TO_SUB
		);
	});

	it('caps the source debit so a reduce-only transfer cannot grow a borrow', async () => {
		// Give from_user (sub 1) a SOL borrow.
		await velocityClient.withdraw(
			solBorrow,
			SOL_MARKET_INDEX,
			wSolAccount,
			false,
			FROM_SUB
		);

		await velocityClient.fetchAccounts();
		const fromUser = velocityClient.getUserAccount(FROM_SUB);
		const solPosition = fromUser.spotPositions.find(
			(p) => p.marketIndex === SOL_MARKET_INDEX && !p.scaledBalance.eq(ZERO)
		);
		assert(solPosition !== undefined);
		assert(isVariant(solPosition.balanceType, 'borrow'));

		await velocityClient.updateSpotMarketStatus(
			SOL_MARKET_INDEX,
			MarketStatus.REDUCE_ONLY
		);

		// Transferring SOL out of the borrower would deepen the borrow; the reduce-only
		// cap must reject it instead of letting the internal transfer grow the borrow.
		let failed = false;
		try {
			await velocityClient.transferDeposit(
				solBorrow,
				SOL_MARKET_INDEX,
				FROM_SUB,
				TO_SUB
			);
		} catch (e) {
			// ReduceOnlyWithdrawIncreasedRisk
			assert(e.toString().includes('0x1809'));
			failed = true;
		}
		assert(failed, 'reduce-only transfer that grows a borrow should fail');

		await velocityClient.updateSpotMarketStatus(
			SOL_MARKET_INDEX,
			MarketStatus.ACTIVE
		);
	});
});
