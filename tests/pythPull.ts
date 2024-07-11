import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	OracleSource,
	TestClient,
	getPythPullOraclePublicKey,
} from '../sdk/src';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import { AccountInfo, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { DEFAULT_WORMHOLE_PROGRAM_ID } from '@pythnetwork/pyth-solana-receiver';
import { WORMHOLE_DATA } from './pythPullOracleData';
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';

// set up account infos to load into banks client
const GUARDIAN_SET_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: DEFAULT_WORMHOLE_PROGRAM_ID,
	rentEpoch: 0,
	data: Buffer.from(WORMHOLE_DATA, 'base64'),
};

const GUARDIAN_SET_KEY = new PublicKey(
	'5gxPdahvSzcKySxXxPuRXZZ9s6h8hZ88XDVKavWpaQGn'
);

describe('pyth pull oracles', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;

	const feedId =
		'0x2f2d17abbc1e781bd87b4a5d52c8b2856886f5c482fa3593cebf6795040ab0b6';
	let feedAddress: PublicKey;
	const feedId2 =
		'0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221';

	before(async () => {
		// use bankrun builtin function to start solana program test
		const context = await startAnchor(
			'',
			[
				{
					name: 'pyth_solana_receiver',
					programId: new PublicKey(
						'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha'
					),
				},
			],
			[
				// load account infos into banks client like this
				{
					address: GUARDIAN_SET_KEY,
					info: GUARDIAN_SET_ACCOUNT_INFO,
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

		const feedIdBuffer = Uint8Array.from(Buffer.from(feedId, 'hex'));
		feedAddress = getPythPullOraclePublicKey(chProgram.programId, feedIdBuffer);

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
					publicKey: feedAddress,
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

	it('init feed', async () => {
		const txsig = await driftClient.initializePythPullOracle(feedId);

		console.log(txsig);
	});

	it('post atomic', async () => {
		const vaa =
			'UE5BVQEAAAADuAEAAAAEDQBCMgHU9FQcIQcDeFlahVuIjFTV3Ga+h+mLNrjNtGudAVhCNf7nJQPI7+N+x5o9B52zFhydj5NfeiDVGyTTcgmBAQKIAWC+ENn58snD+mQy/n62kpDJKXgnRQsa34HzoqqGihWeG5E2ZuFsf3CRv8vAqi7OLnHvAUr0Iyh+ZqOC63HhAQOYwX+xZDyah05YVSJ8WRpcvGb5/ILnQBtaE+hLBhsQtQqzN+dnGPva5uHiU9HV4MheEacJgris2qbSQKXQI2QPAAS5TlKWIBEf61jOB4nUwywXTD8s4S71SnuMNzDb7EmgLzVn56Xi2+BHluI3mH70DLrdFeKtdN7/VWa8rHX/exAnAQai3i3ofNfIkakObv7GP0DVN6tqCetbt57oP5Ioer0Fo3rfNPTZfpeqixhu6Yg0TdjCTavB3S3pQD4r1BeFccagAQvsV3AkXvUWwspj30bGc+/yZKTaSwRkFsAdgGXGCVS/J0V40eGhqvx+EIuZlQnnWthtA83PELrOQ56WU7UivnFSAAwMd3AjpNMGEnrnsvupYSX6GUq5q8zff85LYJikJ3miQxLfc77QepaTmubOI/iTAtUbocy1cS7h7paqXR9NMf2AAA1sKdfW8d1tFsr0zJoEwBjCSMWnRIpiT/tOa4sKPnzF1zN6G0F1sEauCFMuIqKpgHUN0BZEiytiSEK8Xu4yVuuVAQ6s27zlTsMMy+Ku0pfFiVefhhJwdI8IdWLHIG0NaIJjHVYbVPA26kwBkpz2AMlcYM+bs5bELlAcStv5PKC5U2+nAA/TcNr+b77ui5+OBoIrnqL4k+5Q0ZNm58KQml+aDBwzuiCNm1um+RdZLbsYAtERItJ3o/2DV5mxK453KupXNrB8ARD/27EL0Csf7fWQlZKIDZPebny5jdW8LSLPqG0yU0/xCVaXjnyA7CktfW1N2aUP6SaRU7yk/z9iKoFv5tE+Ti+EARHZHKSGL3Q9e6dshpquRBo0kGQ0mihXeUuEEXFbrrS8UjnjcWoS/liligFYFyN9jE/JDBamEeXV9ZHl9tHYYQKgABLhScEt52h+pdTAeHH/kECTj5IeTRqcklzgD3dmVNymdGE4eXcjmvFxh7hXLSbSx/EpILAyzHRaKfe03N/1oFpNAGZ90fcAAAAAABrhAfrtrFhR4yubI7X5QRqMK6xKrj7U3XuBHdGnLqSqcQAAAAAD6d6rAUFVV1YAAAAAAAj0UkIAACcQILdMyJ7aEHG/UrkKF0N32va/y3ABAFUALy0Xq7weeBvYe0pdUsiyhWiG9cSC+jWTzr9nlQQKsLYAAAAAAHjmhQAAAAAAAHZV////+AAAAABmfdH3AAAAAGZ90fcAAAAAAHkdDQAAAAAAAI4BCp6vPuZHQJAkw6QVYM8r5LckP6y7M0O90/+uxk99a+3XUEcOu2o4iF2pu2Pfy+g3/hULrluX11aWCwkhjQIT8U3BApQtpkDlT0sGXKZCcaGmyuFVsVxcgoH6zxzEZ35ibCXKjFZgnfbSCyzF299o4VxAWBd0WA8XXTX6QpfKc3y8xgQ1tPn6OO2466XWD6ywYkZe7a2n52XCC6Vq0iG+cCY2G9eoZEPULNWAcamTIu6Xzbm+zTcv6ULsnbjhPAQ/8kcbpmYQPKRY';
		await driftClient.postPythPullOracleUpdateAtomic(vaa, feedId);
	});

	it('post multi atomic', async () => {
		const vaa2 =
			'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';
		await driftClient.postMultiPythPullOracleUpdatesAtomic(vaa2, [
			feedId,
			feedId2,
		]);
	});
});
