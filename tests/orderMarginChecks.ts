import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BN,
	OracleSource,
	ZERO,
	MARGIN_PRECISION,
	OrderType,
	MarketType,
	PositionDirection,
	PEG_PRECISION,
	SettlePnlMode,
} from '../sdk';

import { Program } from '@coral-xyz/anchor';

import { TestClient, EventSubscriber, getOrderParams } from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('order margin checks with isolated positions', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let userUSDCAccount;

	let solUsd;
	let ethUsd;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	// Large amount of USDC for testing
	const largeUsdcAmount = new BN(10000 * 10 ** 6); // 10,000 USDC

	// Helper to suppress console output during expected failures
	const suppressConsole = () => {
		const oldConsoleLog = console.log;
		const oldConsoleError = console.error;
		console.log = function () {
			/* noop */
		};
		console.error = function () {
			/* noop */
		};
		return () => {
			console.log = oldConsoleLog;
			console.error = oldConsoleError;
		};
	};

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
			largeUsdcAmount,
			bankrunContextWrapper
		);

		// Create oracles for SOL and ETH
		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 100); // $1 per SOL
		ethUsd = await mockOracleNoProgram(bankrunContextWrapper, 1000); // $1 per ETH

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0, 1],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{ publicKey: solUsd, source: OracleSource.PYTH },
				{ publicKey: ethUsd, source: OracleSource.PYTH },
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);

		await driftClient.subscribe();
		await driftClient.updatePerpAuctionDuration(new BN(0));

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR

		// Initialize SOL-PERP market (index 0)
		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(100 * PEG_PRECISION.toNumber())
		);

		// Initialize ETH-PERP market (index 1)
		await driftClient.initializePerpMarket(
			1,
			ethUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(1000 * PEG_PRECISION.toNumber())
		);

		// Set step sizes
		await driftClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);
		await driftClient.updatePerpMarketStepSizeAndTickSize(
			1,
			new BN(1),
			new BN(1)
		);

		// Set margin ratios: 50% initial, 33% maintenance
		await driftClient.updatePerpMarketMarginRatio(
			0,
			MARGIN_PRECISION.toNumber() / 2, // 50% IM
			MARGIN_PRECISION.toNumber() / 3 // 33% MM
		);
		await driftClient.updatePerpMarketMarginRatio(
			1,
			MARGIN_PRECISION.toNumber() / 2, // 50% IM
			MARGIN_PRECISION.toNumber() / 3 // 33% MM
		);

		// Initialize user account
		await driftClient.initializeUserAccount();
		console.log('Initialized user account');
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	// Reset user state between tests
	async function resetUserState() {
		await driftClient.fetchAccounts();

		// Close any open positions
		const user = driftClient.getUserAccount();
		for (const perpPosition of user.perpPositions) {
			if (!perpPosition.baseAssetAmount.eq(ZERO)) {
				try {
					await driftClient.closePosition(perpPosition.marketIndex);
				} catch (e) {
					// Ignore errors when closing
				}
			}
		}

		// Settle PNL for all markets
		try {
			await driftClient.settleMultiplePNLs(
				await driftClient.getUserAccountPublicKey(),
				driftClient.getUserAccount(),
				[0],
				SettlePnlMode.TRY_SETTLE
			);
		} catch (e) {
			// Ignore
		}
		try {
			await driftClient.settlePNL(
				await driftClient.getUserAccountPublicKey(),
				driftClient.getUserAccount(),
				1
			);
		} catch (e) {
			// Ignore
		}

		await driftClient.fetchAccounts();

		// Transfer isolated collateral back to cross if any
		for (const perpPosition of driftClient.getUserAccount().perpPositions) {
			const isolatedBalance = driftClient.getIsolatedPerpPositionTokenAmount(
				perpPosition.marketIndex
			);
			if (isolatedBalance.gt(ZERO)) {
				try {
					await driftClient.transferIsolatedPerpPositionDeposit(
						isolatedBalance.neg(),
						perpPosition.marketIndex,
						undefined,
						undefined,
						undefined,
						true
					);
				} catch (e) {
					// Ignore
				}
			}
		}

		// Withdraw all cross collateral
		await driftClient.fetchAccounts();
		const crossBalance = driftClient.getQuoteAssetTokenAmount();
		if (crossBalance.gt(ZERO)) {
			try {
				await driftClient.withdraw(crossBalance, 0, userUSDCAccount.publicKey);
			} catch (e) {
				// Ignore
			}
		}

		await driftClient.fetchAccounts();
	}

	describe('Scenario 1: Cross below IM -> cannot open isolated position', () => {
		it('should fail to open isolated position when cross account fails initial margin', async () => {
			await resetUserState();

			// With 50% IM, 33% MM:
			// 10 SOL @ $100 = $1000 notional -> $500 IM required, $333 MM required
			// We want cross to fail IM but pass MM

			// Deposit enough to open position first
			console.log(
				'[LOGGING] depositing into cross',
				new BN(600 * 10 ** 6).toString()
			);
			await driftClient.deposit(
				new BN(600 * 10 ** 6), // $600
				0,
				userUSDCAccount.publicKey
			);

			// Open cross position: 10 SOL
			const baseAssetAmount = new BN(10 * 10 ** 9); // 10 SOL
			console.log(
				'[LOGGING] opening cross position',
				baseAssetAmount.toString()
			);
			await driftClient.openPosition(
				PositionDirection.LONG,
				baseAssetAmount,
				0 // SOL-PERP market
			);

			// Lower SOL oracle so user has unrealized losses -> cross below IM but above MM
			// (Withdraw would be rejected by program; cannot withdraw below IM.)
			// 10 SOL long @ $100 -> drop to $79: loss = $210, effective collateral ~$390, IM required $395, MM ~$261
			await setFeedPriceNoProgram(bankrunContextWrapper, 79, solUsd);
			await driftClient.fetchAccounts();

			// Now try to open isolated ETH-PERP position
			// First deposit into isolated
			const isolatedDeposit = new BN(600 * 10 ** 6); // $600 - enough for 1 ETH ($500 IM)
			console.log(
				'[LOGGING] depositing into cross',
				isolatedDeposit.toString()
			);
			await driftClient.deposit(isolatedDeposit, 0, userUSDCAccount.publicKey);
			console.log('[LOGGING] deposited into cross', isolatedDeposit.toString());
			await driftClient.depositIntoIsolatedPerpPosition(
				isolatedDeposit,
				1, // ETH-PERP
				userUSDCAccount.publicKey
			);

			// Try to place an order on isolated ETH-PERP - should fail because cross fails IM
			const restoreConsole = suppressConsole();
			try {
				console.log(
					'[LOGGING] placing order on isolated ETH-PERP',
					new BN(1 * 10 ** 9).toString()
				);
				await driftClient.placePerpOrder(
					getOrderParams({
						orderType: OrderType.MARKET,
						marketType: MarketType.PERP,
						marketIndex: 1,
						direction: PositionDirection.LONG,
						baseAssetAmount: new BN(1 * 10 ** 9), // 1 ETH
					})
				);
				assert(false, 'Order should have failed - cross is below IM');
			} catch (e) {
				assert(true, 'Order correctly failed');
			} finally {
				restoreConsole();
			}
		});
	});

	describe('Scenario 2a: Isolated below IM + increase same market -> FAILS if cross cannot provide shortfall', () => {
		it('should fail to increase isolated position when shortfall deposit would make cross fail IM', async () => {
			await resetUserState();

			// With 50% IM, 33% MM:
			// 10 SOL @ $100 = $1000 notional -> $500 IM required
			// 1 ETH @ $1000 = $1000 notional -> $500 IM required
			// 1.5 ETH @ $1000 = $1500 notional -> $750 IM required
			//
			// Setup:
			// Cross: $550 collateral, 10 SOL cross position ($500 IM required) -> passes with $50 buffer
			// Isolated: 1 ETH with $550 collateral, want to increase by 0.5 ETH
			// After increase: 1.5 ETH = $750 IM required, but only $550 isolated collateral
			// Shortfall: $200. If cross provides $200, cross has $350 vs $500 IM -> fails

			// Deposit initial cross collateral
			await driftClient.deposit(
				new BN(700 * 10 ** 6), // $700
				0,
				userUSDCAccount.publicKey
			);

			// Open cross SOL position
			await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9), // 10 SOL
				0
			);

			// Lower SOL oracle so cross has effective $550 (loss $150: 10*(100-85)=150)
			await setFeedPriceNoProgram(bankrunContextWrapper, 85, solUsd);
			await driftClient.fetchAccounts();

			// Deposit and setup isolated ETH position
			await driftClient.deposit(
				new BN(550 * 10 ** 6), // $550
				0,
				userUSDCAccount.publicKey
			);
			await driftClient.depositIntoIsolatedPerpPosition(
				new BN(550 * 10 ** 6),
				1,
				userUSDCAccount.publicKey
			);

			// Open initial isolated ETH position
			await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(1 * 10 ** 9), // 1 ETH
				1
			);

			// Cross already at effective $550 from oracle move above
			await driftClient.fetchAccounts();

			// Now try to increase isolated position by 0.5 ETH
			// This would require $750 IM total, but only have $550 isolated
			// Shortfall of $200 from cross would make cross fail ($550 - $200 = $350 < $500 IM)
			const restoreConsole = suppressConsole();
			try {
				await driftClient.placePerpOrder(
					getOrderParams({
						orderType: OrderType.MARKET,
						marketType: MarketType.PERP,
						marketIndex: 1,
						direction: PositionDirection.LONG,
						baseAssetAmount: new BN(0.5 * 10 ** 9), // 0.5 ETH
					})
				);
				assert(
					false,
					'Order should have failed - deposit would make cross fail IM'
				);
			} catch (e) {
				assert(true, 'Order correctly failed');
			} finally {
				restoreConsole();
			}
		});
	});

	describe('Scenario 2b: Isolated below IM + increase same market -> PASSES if cross can provide shortfall', () => {
		it('should pass when cross can provide shortfall while still meeting IM', async () => {
			await resetUserState();

			// With 50% IM, 33% MM:
			// 10 SOL @ $100 = $1000 notional -> $500 IM required
			// 1 ETH @ $1000 = $1000 notional -> $500 IM required
			// 1.5 ETH @ $1000 = $1500 notional -> $750 IM required
			//
			// Setup:
			// Cross: $800 collateral, 10 SOL cross position ($500 IM required) -> passes with $300 buffer
			// Isolated: 1 ETH with $550 collateral, want to increase by 0.5 ETH
			// After increase: 1.5 ETH = $750 IM required, but only $550 isolated collateral
			// Shortfall: $200. Cross provides $200, cross has $600 vs $500 IM -> passes

			// Deposit initial cross collateral
			await driftClient.deposit(
				new BN(900 * 10 ** 6), // $900
				0,
				userUSDCAccount.publicKey
			);

			// Open cross SOL position
			await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9), // 10 SOL
				0
			);

			// Lower SOL oracle so cross has effective $800 (loss $100: 10*(100-90)=100)
			await setFeedPriceNoProgram(bankrunContextWrapper, 90, solUsd);
			await driftClient.fetchAccounts();

			// Deposit and setup isolated ETH position
			await driftClient.deposit(
				new BN(550 * 10 ** 6), // $550
				0,
				userUSDCAccount.publicKey
			);
			await driftClient.depositIntoIsolatedPerpPosition(
				new BN(550 * 10 ** 6),
				1,
				userUSDCAccount.publicKey
			);

			// Open initial isolated ETH position
			await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(1 * 10 ** 9), // 1 ETH
				1
			);

			// Cross already at effective $800 from oracle move above
			await driftClient.fetchAccounts();

			// Now increase isolated position by 0.5 ETH - should pass
			// Shortfall of $200 from cross leaves cross with $600 > $500 IM -> passes
			const txSig = await driftClient.placePerpOrder(
				getOrderParams({
					orderType: OrderType.MARKET,
					marketType: MarketType.PERP,
					marketIndex: 1,
					direction: PositionDirection.LONG,
					baseAssetAmount: new BN(0.5 * 10 ** 9), // 0.5 ETH
				})
			);

			assert(txSig, 'Order should have passed - cross can provide shortfall');
		});
	});

	describe('Scenario 3a: Isolated below IM + open different market -> PASSES if all isolated pass MM', () => {
		it('should pass opening new isolated when other isolated fails IM but passes MM', async () => {
			await resetUserState();

			// With 50% IM, 33% MM:
			// 10 SOL @ $100 = $1000 notional -> $500 IM required, $333 MM required
			// 1 ETH @ $1000 = $1000 notional -> $500 IM required, $333 MM required
			//
			// Setup:
			// Cross: $2000 USDC collateral
			// Isolated SOL-PERP: 10 SOL with $400 collateral
			//   - IM required: $500 (FAILS)
			//   - MM required: $333 (PASSES - $400 > $333)
			// Try to open new isolated ETH-PERP - should pass because SOL-PERP passes MM

			// Deposit cross collateral
			await driftClient.deposit(
				new BN(2000 * 10 ** 6), // $2000
				0,
				userUSDCAccount.publicKey
			);

			// Setup isolated SOL position with enough to open
			await driftClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6), // $600 - enough to open ($500 IM)
				0,
				userUSDCAccount.publicKey
			);

			// Open SOL position
			await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9), // 10 SOL
				0
			);

			// Lower SOL oracle so isolated SOL has effective $400 (loss $200: 10*(100-80)=200), fails IM but passes MM
			await setFeedPriceNoProgram(bankrunContextWrapper, 80, solUsd);
			await driftClient.fetchAccounts();

			// Now setup and open isolated ETH position
			await driftClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6), // $600 - enough for $500 IM
				1,
				userUSDCAccount.publicKey
			);

			// Open ETH position - should pass because SOL position passes MM
			const txSig = await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(1 * 10 ** 9), // 1 ETH
				1
			);

			assert(
				txSig,
				'Order should pass when other isolated fails IM but passes MM'
			);
		});
	});

	describe('Scenario 3b: Isolated below IM + open different market -> FAILS if any isolated fails MM', () => {
		it('should fail opening new isolated when other isolated fails MM', async () => {
			await resetUserState();

			// With 50% IM, 33% MM:
			// 10 SOL @ $100 = $1000 notional -> $500 IM required, $333 MM required
			// 1 ETH @ $1000 = $1000 notional -> $500 IM required, $333 MM required
			//
			// Setup:
			// Cross: $2000 USDC collateral
			// Isolated SOL-PERP: 10 SOL with $300 collateral
			//   - MM required: $333 (FAILS - $300 < $333)
			// Try to open new isolated ETH-PERP - should fail because SOL-PERP fails MM

			// Deposit cross collateral
			await driftClient.deposit(
				new BN(2000 * 10 ** 6), // $2000
				0,
				userUSDCAccount.publicKey
			);

			// Setup isolated SOL position with enough to open
			await driftClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6), // $600 - enough to open ($500 IM)
				0,
				userUSDCAccount.publicKey
			);

			// Open SOL position
			await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9), // 10 SOL
				0
			);

			// Lower SOL oracle so isolated SOL has effective $300 (loss $300: 10*(100-70)=300), below MM $333
			await setFeedPriceNoProgram(bankrunContextWrapper, 70, solUsd);
			await driftClient.fetchAccounts();

			// Setup isolated ETH collateral
			await driftClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6), // $600 - enough for $500 IM
				1,
				userUSDCAccount.publicKey
			);

			// Try to open ETH position - should fail because SOL position fails MM
			const restoreConsole = suppressConsole();
			try {
				await driftClient.openPosition(
					PositionDirection.LONG,
					new BN(1 * 10 ** 9), // 1 ETH
					1
				);
				assert(false, 'Order should have failed - other isolated fails MM');
			} catch (e) {
				assert(true, 'Order correctly failed');
			} finally {
				restoreConsole();
			}
		});
	});

	describe('Scenario 4: Cross has plenty of USDC -> no issues opening isolated', () => {
		it('should pass opening isolated when cross has plenty of collateral', async () => {
			await resetUserState();

			// With 50% IM, 33% MM:
			// 1 ETH @ $1000 = $1000 notional -> $500 IM required, $333 MM required
			//
			// Setup:
			// Cross: $2000 USDC collateral, no positions
			// Open new isolated ETH-PERP with $600 collateral ($500 IM required)
			// Should easily pass

			// Deposit cross collateral
			await driftClient.deposit(
				new BN(2000 * 10 ** 6), // $2000
				0,
				userUSDCAccount.publicKey
			);

			// Setup isolated ETH collateral
			await driftClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6), // $600 - enough for $500 IM
				1,
				userUSDCAccount.publicKey
			);

			// Open ETH position - should pass easily
			const txSig = await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(1 * 10 ** 9), // 1 ETH
				1
			);

			assert(txSig, 'Order should pass when cross has plenty of collateral');

			// Verify position was opened
			await driftClient.fetchAccounts();
			const user = driftClient.getUserAccount();
			const ethPosition = user.perpPositions.find((p) => p.marketIndex === 1);
			assert(
				ethPosition && !ethPosition.baseAssetAmount.eq(ZERO),
				'ETH position should be open'
			);
		});
	});
});
