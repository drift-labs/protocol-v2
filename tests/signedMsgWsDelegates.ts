import * as anchor from '@coral-xyz/anchor';

import { Program } from '@coral-xyz/anchor';

import {
	AccountInfo,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
} from '@solana/web3.js';

import {
	TestClient,
	OracleSource,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	PTYH_LAZER_PROGRAM_ID,
	getSignedMsgWsDelegatesAccountPublicKey,
} from '../sdk/src';

import { mockOracleNoProgram } from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { PYTH_STORAGE_DATA } from './pythLazerData';

dotenv.config();

const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

describe('place and make signedMsg order', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solUsd: PublicKey;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		const context = await startAnchor(
			'',
			[],
			[
				{
					address: PYTH_LAZER_STORAGE_ACCOUNT_KEY,
					info: PYTH_STORAGE_ACCOUNT_INFO,
				},
			]
		);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 224.3);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		makerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerDriftClient.subscribe();
	});

	after(async () => {
		await makerDriftClient.unsubscribe();
	});

	it('maker can create ws delegate', async () => {
		const newPubkey = new Keypair().publicKey;
		await makerDriftClient.initializeSignedMsgWsDelegatesAccount(
			makerDriftClient.wallet.publicKey,
			[newPubkey]
		);

		const delegateAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getSignedMsgWsDelegatesAccountPublicKey(
					makerDriftClient.program.programId,
					makerDriftClient.wallet.publicKey
				)
			);

		const pubkeys = deserializePublicKeys(delegateAccountInfo.data.slice(8));
		console.log(pubkeys);
	});
});

function deserializePublicKeys(buffer: Buffer): PublicKey[] {
	const numKeys = buffer.readUInt32LE(0);
	const keys: PublicKey[] = [];
	let offset = 4;
	for (let i = 0; i < numKeys; i++) {
		const keyBytes = buffer.slice(offset, offset + 32);
		keys.push(new PublicKey(keyBytes));
		offset += 32;
	}
	return keys;
}
