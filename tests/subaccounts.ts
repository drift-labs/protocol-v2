import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import {
	getUserAccountPublicKey,
	isVariant,
	QUOTE_ASSET_BANK_INDEX,
	Admin,
	BN,
	EventSubscriber,
	fetchUserAccounts,
	fetchUserStatsAccount,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { decodeName } from '../sdk/src/userName';
import { assert } from 'chai';

describe('subaccounts', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let usdcAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		usdcAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const marketIndexes = [new BN(0)];
		const bankIndexes = [new BN(0)];

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize first account', async () => {
		const userId = 0;
		const name = 'CRISP';
		await clearingHouse.initializeUserAccount(userId, name);

		assert(clearingHouse.getUserAccount().userId === userId);
		assert(decodeName(clearingHouse.getUserAccount().name) === name);

		const userStats = await fetchUserStatsAccount(
			connection,
			clearingHouse.program,
			provider.wallet.publicKey
		);

		assert(userStats.numberOfUsers === 1);
	});

	it('Initialize second account', async () => {
		const userId = 1;
		const name = 'LIL PERP';
		await clearingHouse.initializeUserAccount(1, name);
		await clearingHouse.addUser(1);
		await clearingHouse.switchActiveUser(1);

		assert(clearingHouse.getUserAccount().userId === userId);
		assert(decodeName(clearingHouse.getUserAccount().name) === name);

		const userStats = await fetchUserStatsAccount(
			connection,
			clearingHouse.program,
			provider.wallet.publicKey
		);

		assert(userStats.numberOfUsers === 2);
	});

	it('Fetch all user account', async () => {
		const userAccounts = await fetchUserAccounts(
			connection,
			chProgram,
			provider.wallet.publicKey,
			2
		);
		assert(userAccounts.length === 2);
	});

	it('Deposit and transfer between accounts', async () => {
		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_ASSET_BANK_INDEX,
			usdcAccount.publicKey
		);
		const txSig = await clearingHouse.transferDeposit(
			usdcAmount,
			QUOTE_ASSET_BANK_INDEX,
			1,
			0
		);
		await clearingHouse.switchActiveUser(0);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));

		await eventSubscriber.awaitTx(txSig);
		const depositRecords = eventSubscriber.getEventsArray('DepositRecord');

		const toUser = await getUserAccountPublicKey(
			chProgram.programId,
			provider.wallet.publicKey,
			0
		);
		const withdrawRecord = depositRecords[1];
		assert(isVariant(withdrawRecord.direction, 'withdraw'));
		assert(withdrawRecord.to.equals(toUser));
		assert(withdrawRecord.from === null);

		const fromUser = await getUserAccountPublicKey(
			chProgram.programId,
			provider.wallet.publicKey,
			1
		);
		const depositRecord = depositRecords[0];
		assert(isVariant(depositRecord.direction, 'deposit'));
		assert(depositRecord.to === null);
		assert(depositRecord.from.equals(fromUser));
	});
});
