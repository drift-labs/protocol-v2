import * as anchor from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	getLimitOrderParams,
	OracleSource,
	TestClient,
	PRICE_PRECISION,
	PositionDirection,
} from '../../packages/sdk/src';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import { isVariant } from '../../packages/sdk';

describe('cancel all orders', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

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

		const oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		velocityClient = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await velocityClient.initializePerpMarket(
			0,
			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await velocityClient.unsubscribe();
	});

	it('cancel all orders', async () => {
		for (let i = 0; i < 32; i++) {
			await velocityClient.placePerpOrder(
				getLimitOrderParams({
					baseAssetAmount: BASE_PRECISION,
					marketIndex: 0,
					direction: PositionDirection.LONG,
					price: PRICE_PRECISION,
				})
			);
		}

		await velocityClient.cancelOrders(null, null, null);

		// await printTxLogs(connection, txSig);

		for (let i = 0; i < 32; i++) {
			assert(
				!isVariant(velocityClient.getUserAccount().orders[i].status, 'open')
			);
		}
	});
});
