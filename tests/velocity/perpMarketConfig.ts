import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BN,
	PEG_PRECISION,
	PRICE_PRECISION,
	TestClient,
	assert,
	MarketConfigFlag,
} from '../../packages/sdk/src';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockOracleNoProgram,
} from './testHelpers';

describe('perp market config flag', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
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

		velocityClient = new TestClient({
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

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
		const ammInitialQuoteAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
			mantissaSqrtScale
		);

		await velocityClient.initializePerpMarket(
			0,
			await mockOracleNoProgram(bankrunContextWrapper, 100),
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0),
			new BN(100 * PEG_PRECISION.toNumber())
		);
		await velocityClient.initializeAmmCache();
		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
	});

	after(async () => {
		await velocityClient.unsubscribe();
	});

	it('set disable formulaic k update flag', async () => {
		const marketIndex = 0;

		let market = velocityClient.getPerpMarketAccount(marketIndex);
		assert(market.marketConfig === 0);

		await velocityClient.updatePerpMarketConfig(
			marketIndex,
			MarketConfigFlag.DISABLE_FORMULAIC_K_UPDATE
		);

		await velocityClient.fetchAccounts();
		market = velocityClient.getPerpMarketAccount(marketIndex);
		assert(
			(market.marketConfig & MarketConfigFlag.DISABLE_FORMULAIC_K_UPDATE) !== 0
		);
	});

	it('clear disable formulaic k update flag', async () => {
		const marketIndex = 0;

		await velocityClient.updatePerpMarketConfig(marketIndex, 0);

		await velocityClient.fetchAccounts();
		const market = velocityClient.getPerpMarketAccount(marketIndex);
		assert(market.marketConfig === 0);
	});

	it('reject unknown bits in market config', async () => {
		const marketIndex = 0;
		let threw = false;
		try {
			await velocityClient.updatePerpMarketConfig(marketIndex, 0xff);
		} catch (e) {
			threw = true;
		}
		assert(threw, 'should have thrown for invalid bits');
	});
});
