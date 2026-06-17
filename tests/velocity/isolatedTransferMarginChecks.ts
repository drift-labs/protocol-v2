import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BN,
	OracleSource,
	ZERO,
	MARGIN_PRECISION,
	PositionDirection,
	PEG_PRECISION,
	SettlePnlMode,
} from '../../packages/sdk';

import { Program } from '@coral-xyz/anchor';

import { TestClient, EventSubscriber } from '../../packages/sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('isolated transfer margin checks', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let userUSDCAccount;

	let solUsd;
	let ethUsd;
	let btcUsd;

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

		// Create oracles for SOL, ETH and BTC
		solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			100,
			-7,
			undefined,
			10000
		); // $100 per SOL
		ethUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			1000,
			-7,
			undefined,
			10000
		); // $1000 per ETH
		btcUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			100000,
			-7,
			undefined,
			10000
		); // $100000 per BTC

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0, 1, 2],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{ publicKey: solUsd, source: OracleSource.PYTH_LAZER },
				{ publicKey: ethUsd, source: OracleSource.PYTH_LAZER },
				{ publicKey: btcUsd, source: OracleSource.PYTH_LAZER },
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);

		await velocityClient.subscribe();
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR

		// Initialize SOL-PERP market (index 0)
		await velocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(100 * PEG_PRECISION.toNumber())
		);

		// Initialize ETH-PERP market (index 1)
		await velocityClient.initializePerpMarket(
			1,
			ethUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(1000 * PEG_PRECISION.toNumber())
		);

		// Initialize BTC-PERP market (index 2)
		await velocityClient.initializePerpMarket(
			2,
			btcUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(100000 * PEG_PRECISION.toNumber())
		);

		// Set step sizes
		await velocityClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);
		await velocityClient.updatePerpMarketStepSizeAndTickSize(
			1,
			new BN(1),
			new BN(1)
		);
		await velocityClient.updatePerpMarketStepSizeAndTickSize(
			2,
			new BN(1),
			new BN(1)
		);

		// Set margin ratios: 50% initial, 33% maintenance
		await velocityClient.updatePerpMarketMarginRatio(
			0,
			MARGIN_PRECISION.toNumber() / 2, // 50% IM
			MARGIN_PRECISION.toNumber() / 3 // 33% MM
		);
		await velocityClient.updatePerpMarketMarginRatio(
			1,
			MARGIN_PRECISION.toNumber() / 2, // 50% IM
			MARGIN_PRECISION.toNumber() / 3 // 33% MM
		);
		await velocityClient.updatePerpMarketMarginRatio(
			2,
			MARGIN_PRECISION.toNumber() / 2, // 50% IM
			MARGIN_PRECISION.toNumber() / 3 // 33% MM
		);

		// Initialize user account
		await velocityClient.initializeUserAccount();
		console.log('Initialized user account');
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	// Reset user state between tests
	// Rules: cross must pass IM after transfer, no other isolated may fail MM
	async function resetUserState() {
		// Restore oracle feeds to default prices so tests start with deterministic state
		await setFeedPriceNoProgram(bankrunContextWrapper, 100, solUsd, 10000);
		await setFeedPriceNoProgram(bankrunContextWrapper, 1000, ethUsd, 10000);
		await setFeedPriceNoProgram(bankrunContextWrapper, 100000, btcUsd, 10000);

		await velocityClient.fetchAccounts();

		// Close any open positions
		const user = velocityClient.getUserAccount();
		for (const perpPosition of user.perpPositions) {
			if (!perpPosition.baseAssetAmount.eq(ZERO)) {
				try {
					await velocityClient.closePosition(perpPosition.marketIndex);
				} catch (e) {
					// Ignore
				} finally {
					await velocityClient.fetchAccounts();
				}
			}
		}

		// Settle PNL for all markets
		try {
			await velocityClient.settleMultiplePNLs(
				await velocityClient.getUserAccountPublicKey(),
				velocityClient.getUserAccount(),
				[0],
				SettlePnlMode.TRY_SETTLE
			);
		} catch (e) {
			// Ignore
		}
		try {
			await velocityClient.settlePNL(
				await velocityClient.getUserAccountPublicKey(),
				velocityClient.getUserAccount(),
				1
			);
		} catch (e) {
			// Ignore
		}
		try {
			await velocityClient.settlePNL(
				await velocityClient.getUserAccountPublicKey(),
				velocityClient.getUserAccount(),
				2
			);
		} catch (e) {
			// Ignore
		}

		await velocityClient.fetchAccounts();

		// Transfer isolated collateral back to cross if any
		for (const perpPosition of velocityClient.getUserAccount().perpPositions) {
			const isolatedBalance = velocityClient.getIsolatedPerpPositionTokenAmount(
				perpPosition.marketIndex
			);
			if (isolatedBalance.gt(ZERO)) {
				try {
					await velocityClient.transferIsolatedPerpPositionDeposit(
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
		await velocityClient.fetchAccounts();
		const crossBalance = velocityClient.getQuoteAssetTokenAmount();
		if (crossBalance.gt(ZERO)) {
			try {
				await velocityClient.withdraw(
					crossBalance,
					0,
					userUSDCAccount.publicKey
				);
			} catch (e) {
				// Ignore
			}
		}

		await velocityClient.fetchAccounts();
	}

	describe('Scenario 1: Cross passes IM before and after transfer, no other isolateds', () => {
		it('should pass transfer when cross has plenty before and after', async () => {
			await resetUserState();

			// Cross: $1000 USDC, no positions -> $0 IM required
			// Transfer $200 to isolated ETH (empty slot). After: cross $800, isolated ETH $200.
			// Cross still $0 IM -> PASS

			await velocityClient.deposit(
				new BN(1000 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);

			const txSig = await velocityClient.transferIsolatedPerpPositionDeposit(
				new BN(200 * 10 ** 6),
				1,
				undefined,
				undefined,
				undefined,
				true
			);

			assert(txSig, 'Transfer should have passed');
			await velocityClient.fetchAccounts();
			assert(
				velocityClient
					.getIsolatedPerpPositionTokenAmount(1)
					.eq(new BN(200 * 10 ** 6)),
				'Isolated ETH should have 200'
			);
			assert(
				velocityClient.getQuoteAssetTokenAmount().eq(new BN(800 * 10 ** 6)),
				'Cross should have 800'
			);
		});
	});

	describe('Scenario 2: Cross passes IM before but fails after transfer, no other isolateds', () => {
		it('should fail transfer when cross would fail IM after', async () => {
			await resetUserState();

			// Cross: $700, 10 SOL long @ $100 -> $500 IM required
			// Transfer $250 to isolated ETH. After: cross $450 < $500 IM -> FAIL

			await velocityClient.deposit(
				new BN(700 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);

			const restoreConsole = suppressConsole();
			try {
				await velocityClient.transferIsolatedPerpPositionDeposit(
					new BN(250 * 10 ** 6),
					1,
					undefined,
					undefined,
					undefined,
					true
				);
				assert(false, 'Transfer should have failed - cross would fail IM');
			} catch (e) {
				if (e.message.includes('0x1773')) {
					assert(true, 'Transfer correctly failed');
				} else {
					throw e;
				}
			} finally {
				restoreConsole();
			}
			await velocityClient.fetchAccounts();
			assert(
				velocityClient.getQuoteAssetTokenAmount().eq(new BN(700 * 10 ** 6)),
				'Cross should be unchanged'
			);
		});
	});

	describe('Scenario 3: Cross fails IM, no other isolateds', () => {
		it('should fail transfer when cross already fails IM', async () => {
			await resetUserState();

			// Cross: $600, 10 SOL long @ $100 -> $500 IM required
			// SOL price moves to $70, cross has $300 effective collateral, IM is 10 x 70 x .5 = $350
			// Transfer $100 to isolated. Should fail (cross already below IM)

			await velocityClient.deposit(
				new BN(600 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);
			// 10 SOL @ 100->70: loss 200, effective 300 collateral, need 350 IM
			await setFeedPriceNoProgram(bankrunContextWrapper, 70, solUsd, 10000);
			await velocityClient.fetchAccounts();

			const restoreConsole = suppressConsole();
			try {
				await velocityClient.transferIsolatedPerpPositionDeposit(
					new BN(100 * 10 ** 6),
					1,
					undefined,
					undefined,
					undefined,
					true
				);
				assert(false, 'Transfer should have failed - cross fails IM');
			} catch (e) {
				if (e.message.includes('0x1773')) {
					assert(true, 'Transfer correctly failed');
				} else {
					throw e;
				}
			} finally {
				restoreConsole();
			}
		});
	});

	describe('Scenario 4: Cross fails MM, no other isolateds', () => {
		it('should fail transfer when cross fails MM', async () => {
			await resetUserState();

			// Cross: $300 effective, 10 SOL long -> $333 MM required, cross fails MM
			// 10 SOL @ 100->70: loss 300, effective 300, MM 333
			await velocityClient.deposit(
				new BN(600 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);
			await setFeedPriceNoProgram(bankrunContextWrapper, 70, solUsd, 10000);
			await velocityClient.fetchAccounts();

			const restoreConsole = suppressConsole();
			try {
				await velocityClient.transferIsolatedPerpPositionDeposit(
					new BN(50 * 10 ** 6),
					1,
					undefined,
					undefined,
					undefined,
					true
				);
				assert(false, 'Transfer should have failed - cross fails MM');
			} catch (e) {
				if (e.message.includes('0x1773')) {
					assert(true, 'Transfer correctly failed');
				} else {
					throw e;
				}
			} finally {
				restoreConsole();
			}
		});
	});

	describe('Scenario 5: Cross passes IM before and after, other isolated fails MM', () => {
		it('should fail transfer when other isolated fails MM', async () => {
			await resetUserState();

			// Cross: $2000, no cross positions. Other isolated: SOL 10 long with $600 collateral,
			// SOL at 50 -> effective $100 < $333 MM. Transfer $200 to isolated ETH.
			// Cross after $600, no IM. But other isolated fails MM -> FAIL

			await velocityClient.deposit(
				new BN(2000 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.transferIsolatedPerpPositionDeposit(
				new BN(600 * 10 ** 6),
				0
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);
			// SOL at 50: 10*(100-50)=500 loss, 600-500=100 < 333 MM
			await setFeedPriceNoProgram(bankrunContextWrapper, 50, solUsd, 10000);
			await velocityClient.fetchAccounts();

			// Cross has 1400, isolated SOL has 100 effective (fails MM)
			const restoreConsole = suppressConsole();
			try {
				await velocityClient.transferIsolatedPerpPositionDeposit(
					new BN(200 * 10 ** 6),
					1,
					undefined,
					undefined,
					undefined,
					true
				);
				assert(false, 'Transfer should have failed - other isolated fails MM');
			} catch (e) {
				if (e.message.includes('0x1773')) {
					assert(true, 'Transfer correctly failed');
				} else {
					throw e;
				}
			} finally {
				restoreConsole();
			}
		});
	});

	describe('Scenario 6: Cross passes IM before and after, other isolated passes MM', () => {
		it('should pass transfer when other isolated passes MM', async () => {
			await resetUserState();

			// Cross: $800, no cross positions. Other isolated: SOL 10 long with $400 collateral,
			// SOL at 80 -> effective $400 > $333 MM. Transfer $200 to isolated ETH.
			// Cross after $600. Other isolated passes MM -> PASS

			await velocityClient.deposit(
				new BN(2000 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);
			// SOL at 80: 10*(100-80)=200 loss, 600-200=400 > 333 MM
			await setFeedPriceNoProgram(bankrunContextWrapper, 80, solUsd, 10000);
			await velocityClient.fetchAccounts();

			const txSig = await velocityClient.transferIsolatedPerpPositionDeposit(
				new BN(200 * 10 ** 6),
				1,
				undefined,
				undefined,
				undefined,
				true
			);

			assert(txSig, 'Transfer should have passed');
			await velocityClient.fetchAccounts();
			assert(
				velocityClient
					.getIsolatedPerpPositionTokenAmount(1)
					.eq(new BN(200 * 10 ** 6)),
				'Isolated ETH should have 200'
			);
		});
	});

	describe('Scenario 7: Cross passes IM before but fails after, other isolated fails MM', () => {
		it('should fail when both cross would fail IM after and other isolated fails MM', async () => {
			await resetUserState();

			// Cross: $700, 10 SOL long ($500 IM). Other isolated: ETH 1 long with $600,
			// ETH at 700 -> effective $300 < $333 MM. Transfer $250.
			// Cross after $450 < $500 IM. Other isolated fails MM. FAIL

			await velocityClient.deposit(
				new BN(700 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);
			await velocityClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6),
				1,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(1 * 10 ** 9),
				1
			);
			// Cross: 700, 10 SOL @ 100. Sol at 100, cross IM 500, cross ok.
			// ETH at 700: 1*(1000-700)=300 loss, 600-300=300 < 333 MM
			await setFeedPriceNoProgram(bankrunContextWrapper, 700, ethUsd, 10000);
			await velocityClient.fetchAccounts();

			// const restoreConsole = suppressConsole();
			try {
				await velocityClient.transferIsolatedPerpPositionDeposit(
					new BN(250 * 10 ** 6),
					2,
					undefined,
					undefined,
					undefined,
					true
				);
				assert(false, 'Transfer should have failed');
			} catch (e) {
				if (e.message.includes('0x1773')) {
					assert(true, 'Transfer correctly failed');
				} else {
					throw e;
				}
			} finally {
				// restoreConsole();
			}
		});
	});

	describe('Scenario 8: Cross passes IM before but fails after, other isolated passes MM', () => {
		it('should fail when cross would fail IM after even if other isolated passes MM', async () => {
			await resetUserState();

			// Cross: $700, 10 SOL long ($500 IM). Other isolated: ETH 1 long with $600,
			// ETH at 800 -> $200 loss, effective collateral $400 > $333 MM. Transfer $250.
			// Cross after transfer is $450 < $500 IM -> FAIL (other isolated is fine)

			await velocityClient.deposit(
				new BN(700 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);
			await velocityClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6),
				1,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(1 * 10 ** 9),
				1
			);
			// ETH at 800: 1*(1000-800)=200 loss, 600-200=400 > 333 MM - passes
			await setFeedPriceNoProgram(bankrunContextWrapper, 800, ethUsd, 10000);
			await velocityClient.fetchAccounts();

			const restoreConsole = suppressConsole();
			try {
				await velocityClient.transferIsolatedPerpPositionDeposit(
					new BN(250 * 10 ** 6),
					1,
					undefined,
					undefined,
					undefined,
					true
				);
				assert(false, 'Transfer should have failed - cross would fail IM');
			} catch (e) {
				if (e.message.includes('0x1773')) {
					assert(true, 'Transfer correctly failed');
				} else {
					throw e;
				}
			} finally {
				restoreConsole();
			}
		});
	});

	describe('Multi-isolated: one passes MM one fails blocks transfer', () => {
		it('should fail when any of multiple other isolated fails MM', async () => {
			await resetUserState();

			// Cross: $2000. Isolated SOL: 10 long, $400 collateral at 80 -> passes MM.
			// Isolated ETH: 1 long, $300 collateral at 600 -> fails MM ($333).
			// Transfer $100 to... we need a third market. We only have SOL and ETH.
			// So: SOL isolated passes, ETH isolated fails. Transfer cross->ETH isolated (adding to failing one)
			// actually that would improve ETH. Let me reconsider.
			// Transfer cross->SOL isolated (adding to passing one) while ETH fails MM -> FAIL
			await velocityClient.deposit(
				new BN(2000 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6),
				0,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(10 * 10 ** 9),
				0
			);
			await velocityClient.depositIntoIsolatedPerpPosition(
				new BN(600 * 10 ** 6),
				1,
				userUSDCAccount.publicKey
			);
			await velocityClient.openPosition(
				PositionDirection.LONG,
				new BN(1 * 10 ** 9),
				1
			);
			// SOL at 80: passes MM. ETH at 600: fails MM
			await setFeedPriceNoProgram(bankrunContextWrapper, 80, solUsd, 10000);
			await setFeedPriceNoProgram(bankrunContextWrapper, 600, ethUsd, 10000);
			await velocityClient.fetchAccounts();

			const restoreConsole = suppressConsole();
			try {
				await velocityClient.transferIsolatedPerpPositionDeposit(
					new BN(100 * 10 ** 6),
					0,
					undefined,
					undefined,
					undefined,
					true
				);
				assert(false, 'Transfer should fail - ETH isolated fails MM');
			} catch (e) {
				if (e.message.includes('0x1773')) {
					assert(true, 'Transfer correctly failed');
				} else {
					throw e;
				}
			} finally {
				restoreConsole();
			}
		});
	});
});
