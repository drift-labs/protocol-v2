import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { DriftArchive } from '../target/types/drift_archive';

import {BN, AdminClient, getUserAccountPublicKey} from '../sdk/src';

import {Keypair} from '@solana/web3.js';
import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

import { assert } from 'chai';

describe('drift-archive', () => {
	// Configure the client to use the local cluster.
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});

	anchor.setProvider(provider);

	const adminClient = new AdminClient({
		connection: provider.connection,
		wallet: provider.wallet,
	});

	const program = anchor.workspace.DriftArchive as Program<DriftArchive>;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	const usdcAmount = new BN(1000 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		await adminClient.initialize(usdcMint.publicKey, false);
		await adminClient.subscribe();
		await adminClient.initializeUserAccount();
		await initializeQuoteSpotMarket(adminClient, usdcMint.publicKey);
	});

	it('archive user', async () => {
		const userAccount = await adminClient.getUserAccount();

		const archivedUserAccountPubkey = await getUserAccountPublicKey(program.programId, userAccount.authority, userAccount.subAccountId);

		console.log('here');
		await adminClient.archiveUser(provider.wallet.publicKey, 0);

		const archivedUserAccountInfo = await adminClient.connection.getAccountInfo(archivedUserAccountPubkey);
		const decodedArchivedUserAccount = adminClient.program.account.user.coder.accounts.decodeUnchecked('User', archivedUserAccountInfo.data);

		const stringifiedUserAccount = JSON.stringify(userAccount);
		const stringifiedArchivedUserAccount = JSON.stringify(decodedArchivedUserAccount);

		assert(stringifiedUserAccount === stringifiedArchivedUserAccount, 'archived user account does not match user account');
	});

	it('unarchive user', async () => {
		const userAccountPubkey = await adminClient.getUserAccountPublicKey();

		const authority = adminClient.wallet.publicKey;
		const subAccountId = 0;

		const archivedUserAccountPubkey = await getUserAccountPublicKey(program.programId, authority, subAccountId);

		const archivedUserAccountInfoBefore = await adminClient.connection.getAccountInfo(archivedUserAccountPubkey);
		const decodedArchivedUserAccountBefore = adminClient.program.account.user.coder.accounts.decodeUnchecked('User', archivedUserAccountInfoBefore.data);

		console.log('here');
		await adminClient.unarchiveUser(provider.wallet.publicKey, 0);

		const userAccountAfter = await adminClient.program.account.user.fetch(userAccountPubkey);

		const stringifiedUserAccount = JSON.stringify(userAccountAfter);
		const stringifiedArchivedUserAccount = JSON.stringify(decodedArchivedUserAccountBefore);

		assert(stringifiedUserAccount === stringifiedArchivedUserAccount, 'archived user account does not match user account');

		const archivedUserAccountInfoAfter = await adminClient.connection.getAccountInfo(archivedUserAccountPubkey);
		assert(archivedUserAccountInfoAfter === null, 'archived user exists');
	});

	after(async () => {
		await adminClient.unsubscribe();
	});
});