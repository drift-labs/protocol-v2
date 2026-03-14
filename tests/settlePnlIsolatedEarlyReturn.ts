import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BN, OracleSource, ZERO } from '../sdk';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import { TestClient, EventSubscriber } from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracleNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('settle pnl isolated early return', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	let solUsd;

	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);

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
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
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

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		await driftClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);

		await driftClient.initializeUserAccount();

		userAccountPublicKey = await driftClient.getUserAccountPublicKey();

		await driftClient.depositIntoIsolatedPerpPosition(
			usdcAmount,
			0,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('settlePnl clears isolated deposit via early-return path', async () => {
		await driftClient.fetchAccounts();

		assert(
			driftClient.getIsolatedPerpPositionTokenAmount(0).eq(usdcAmount),
			'isolated position should have deposit'
		);
		assert(
			driftClient.getQuoteAssetTokenAmount().eq(ZERO),
			'quote spot should be 0 before settle'
		);

		const settlePnlRecordCountBefore =
			eventSubscriber.getEventsArray('SettlePnlRecord').length;

		const txSig = await driftClient.settlePNL(
			userAccountPublicKey,
			driftClient.getUserAccount(),
			0
		);

		await eventSubscriber.awaitTx(txSig);

		await driftClient.fetchAccounts();

		assert(
			eventSubscriber.getEventsArray('SettlePnlRecord').length ===
				settlePnlRecordCountBefore,
			'early return path should not emit SettlePnlRecord'
		);

		assert(
			driftClient.getIsolatedPerpPositionTokenAmount(0).eq(ZERO),
			'isolated position should be cleared'
		);

		assert(
			driftClient.getQuoteAssetTokenAmount().eq(usdcAmount),
			'cleared amount should appear in quote spot'
		);
	});

	it('settlePnl rejects when isolated already 0 (no position found)', async () => {
		try {
			await driftClient.settlePNL(
				userAccountPublicKey,
				driftClient.getUserAccount(),
				0
			);
			assert(false, 'should have thrown');
		} catch (e) {
			assert(
				e.message.includes('0x177a'),
				`expected UserHasNoPositionInMarket (0x177a), got: ${e.message}`
			);
		}

		await driftClient.fetchAccounts();

		assert(
			driftClient.getIsolatedPerpPositionTokenAmount(0).eq(ZERO),
			'isolated should remain 0'
		);

		assert(
			driftClient.getQuoteAssetTokenAmount().eq(usdcAmount),
			'quote balance unchanged'
		);
	});
});
