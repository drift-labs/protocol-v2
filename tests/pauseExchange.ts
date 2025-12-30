import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BN, QUOTE_SPOT_MARKET_INDEX } from '../sdk/src';

import {
	ExchangeStatus,
	OracleSource,
	PRICE_PRECISION,
	PositionDirection,
	TestClient,
} from '../sdk/src';

import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { DriftProgram } from '../sdk/src/config';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('Pause exchange', () => {
	const chProgram = anchor.workspace.Drift as DriftProgram;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(100 * 10 ** 6);

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
			usdcAmount,
			bankrunContextWrapper
		);

		const solOracle = await mockOracleNoProgram(bankrunContextWrapper, 1);
		const periodicity = new BN(60 * 60); // 1 HOUR

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
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;
		const incrementalUSDCNotionalAmount = usdcAmount.mul(new BN(5));
		await driftClient.openPosition(
			PositionDirection.LONG,
			incrementalUSDCNotionalAmount,
			marketIndex
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('Pause exchange', async () => {
		await driftClient.updateExchangeStatus(ExchangeStatus.PAUSED);
		const state = driftClient.getStateAccount();
		assert(state.exchangeStatus === ExchangeStatus.PAUSED);
	});

	it('Block open position', async () => {
		try {
			await driftClient.openPosition(PositionDirection.LONG, usdcAmount, 0);
		} catch (e) {
			console.log(e);
			assert(e.message.includes('0x1788')); //Error Number: 6024. Error Message: Exchange is paused.
			return;
		}
		console.assert(false);
	});

	it('Block close position', async () => {
		try {
			await driftClient.closePosition(0);
		} catch (e) {
			console.log(e.msg);

			assert(e.message.includes('0x1788'));
			return;
		}
		console.assert(false);
	});

	it('Block withdrawal', async () => {
		try {
			await driftClient.withdraw(
				usdcAmount,
				QUOTE_SPOT_MARKET_INDEX,
				userUSDCAccount.publicKey
			);
		} catch (e) {
			console.log(e.message);
			assert(e.message.includes('0x1788'));
			return;
		}
		console.assert(false);
	});
});
