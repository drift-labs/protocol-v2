import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { AccountInfo, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';
import { OracleSource, TestClient } from '../sdk/src';
import { startAnchor } from 'solana-bankrun';
import {
	ORACLE_ADDRESS_1,
	ORACLE_ADDRESS_1_DATA,
	ORACLE_ADDRESS_2,
	ORACLE_ADDRESS_2_DATA,
	ORACLE_ADDRESS_3,
	ORACLE_ADDRESS_3_DATA,
	ORACLE_ADDRESS_4,
	ORACLE_ADDRESS_4_DATA,
	ORACLE_ADDRESS_5,
	ORACLE_ADDRESS_5_DATA,
	ORACLE_ADDRESS_6,
	ORACLE_ADDRESS_6_DATA,
	ORACLE_ADDRESS_7,
	ORACLE_ADDRESS_7_DATA,
	PULL_FEED_ACCOUNT_DATA,
	PULL_FEED_ADDRESS,
	QUEUE_ACCOUNT_DATA,
	QUEUE_ADDRESS,
} from './switchboardOnDemandData';

const SB_ON_DEMAND_PID = 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv';

const PULL_FEED_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(SB_ON_DEMAND_PID),
	rentEpoch: 0,
	data: Buffer.from(PULL_FEED_ACCOUNT_DATA, 'base64'),
};

const QUEUE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(SB_ON_DEMAND_PID),
	rentEpoch: 0,
	data: Buffer.from(QUEUE_ACCOUNT_DATA, 'base64'),
};

const getOracleAccountInfo = (accountData: string): AccountInfo<Buffer> => {
	return {
		executable: false,
		lamports: LAMPORTS_PER_SOL,
		owner: new PublicKey(SB_ON_DEMAND_PID),
		rentEpoch: 0,
		data: Buffer.from(accountData, 'base64'),
	};
};

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
					programId: new PublicKey(SB_ON_DEMAND_PID),
				},
			],
			[
				// load account infos into banks client like this
				{
					address: PULL_FEED_ADDRESS,
					info: PULL_FEED_ACCOUNT_INFO,
				},
				{
					address: QUEUE_ADDRESS,
					info: QUEUE_ACCOUNT_INFO,
				},
				{
					address: ORACLE_ADDRESS_1,
					info: getOracleAccountInfo(ORACLE_ADDRESS_1_DATA),
				},
				{
					address: ORACLE_ADDRESS_2,
					info: getOracleAccountInfo(ORACLE_ADDRESS_2_DATA),
				},
				{
					address: ORACLE_ADDRESS_3,
					info: getOracleAccountInfo(ORACLE_ADDRESS_3_DATA),
				},
				{
					address: ORACLE_ADDRESS_4,
					info: getOracleAccountInfo(ORACLE_ADDRESS_4_DATA),
				},
				{
					address: ORACLE_ADDRESS_5,
					info: getOracleAccountInfo(ORACLE_ADDRESS_5_DATA),
				},
				{
					address: ORACLE_ADDRESS_6,
					info: getOracleAccountInfo(ORACLE_ADDRESS_6_DATA),
				},
				{
					address: ORACLE_ADDRESS_7,
					info: getOracleAccountInfo(ORACLE_ADDRESS_7_DATA),
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
					source: OracleSource.SWITCHBOARD_ON_DEMAND,
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
		await driftClient.getPostSwitchboardOnDemandUpdateAtomicIx(
			PULL_FEED_ADDRESS,
			3
		);
	});
});
