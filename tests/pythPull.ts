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
});
