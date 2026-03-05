import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BN,
	PEG_PRECISION,
	PRICE_PRECISION,
	TestClient,
	assert,
	MarketConfigFlag,
} from '../sdk/src';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockOracleNoProgram,
} from './testHelpers';

describe('perp market config flag', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context as any);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

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
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
		const ammInitialQuoteAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
			mantissaSqrtScale
		);

		await driftClient.initializePerpMarket(
			0,
			await mockOracleNoProgram(bankrunContextWrapper, 100),
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0),
			new BN(100 * PEG_PRECISION.toNumber())
		);
		await driftClient.initializeAmmCache();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('set disable formulaic k update flag', async () => {
		const marketIndex = 0;

		let market = driftClient.getPerpMarketAccount(marketIndex);
		assert(market.marketConfig === 0);

		await driftClient.updatePerpMarketConfig(
			marketIndex,
			MarketConfigFlag.DISABLE_FORMULAIC_K_UPDATE
		);

		await driftClient.fetchAccounts();
		market = driftClient.getPerpMarketAccount(marketIndex);
		assert(
			(market.marketConfig & MarketConfigFlag.DISABLE_FORMULAIC_K_UPDATE) !== 0
		);
	});

	it('clear disable formulaic k update flag', async () => {
		const marketIndex = 0;

		await driftClient.updatePerpMarketConfig(marketIndex, 0);

		await driftClient.fetchAccounts();
		const market = driftClient.getPerpMarketAccount(marketIndex);
		assert(market.marketConfig === 0);
	});

	it('reject unknown bits in market config', async () => {
		const marketIndex = 0;

		try {
			await driftClient.updatePerpMarketConfig(marketIndex, 0xff);
			assert(false, 'should have failed');
		} catch (e) {
			assert(e);
		}
	});
});
