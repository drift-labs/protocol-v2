import * as anchor from '@coral-xyz/anchor';
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TestBulkAccountLoader } from "../sdk/src/accounts/testBulkAccountLoader";
import { BankrunContextWrapper } from "../sdk/src/bankrun/bankrunConnection";
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';
import { OracleSource, TestClient } from '../sdk/src';
import { startAnchor } from 'solana-bankrun';


const SB_ON_DEMAND_PID = 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv';
const PULL_FEED_ADDRESS = new PublicKey("EZLBfnznMYKjFmaWYMEdhwnkiQF1WiP9jjTY6M8HpmGE");


describe('switchboard on demand', () => {
  const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;


  before(async () => {
		// use bankrun builtin function to start solana program test
		const context = await startAnchor(
			'',
			[
				{
					name: 'switchboard_on_demand',
					programId: new PublicKey(
						SB_ON_DEMAND_PID
					),
				},
			],
			[
				// load account infos into banks client like this
				{
					address: undefined,
					info: undefined,
				},
			]
		);

		// wrap the context to use it with the test helpers
		bankrunContextWrapper = new BankrunContextWrapper(context);

		// don't use regular bulk account loader, use test
		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		driftClient = new TestClient({
			// call toConnection to avoid annoying type error
			connection: bankrunContextWrapper.connection.toConnection(),
			// make sure to avoid regular `provider.X`, they don't show as errors
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			subAccountIds: [], // make sure to add [] for subaccounts or client will gpa
			oracleInfos: [
				{
					publicKey: PULL_FEED_ADDRESS,
					source: OracleSource.PYTH_PULL,
				},
			],
			// BANKRUN DOES NOT WORK WITH WEBSOCKET
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

  after(async () => {
		await driftClient.unsubscribe();
	});


	it('post update', async () => {
		await driftClient.getPostSwitchboardOnDemandUpdateAtomicIx(PULL_FEED_ADDRESS, 3);
	});
  
});
