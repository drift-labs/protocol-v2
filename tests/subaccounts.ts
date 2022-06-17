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

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
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
	});

	it('Initialize second account', async () => {
		const userId = 1;
		const name = 'LIL PERP';
		await clearingHouse.initializeUserAccount(1, name);
		await clearingHouse.updateUserId(1);

		assert(clearingHouse.getUserAccount().userId === userId);
		assert(decodeName(clearingHouse.getUserAccount().name) === name);
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
			0
		);
		await clearingHouse.updateUserId(0);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));

		await eventSubscriber.awaitTx(txSig);
		const depositRecords = eventSubscriber.getEventsArray('DepositRecord');

		const toUser = await getUserAccountPublicKey(
			chProgram.programId,
			provider.wallet.publicKey,
			0
		);
		const withdrawRecord = depositRecords[1].data;
		assert(isVariant(withdrawRecord.direction, 'withdraw'));
		assert(withdrawRecord.to.equals(toUser));
		assert(withdrawRecord.from === null);

		const fromUser = await getUserAccountPublicKey(
			chProgram.programId,
			provider.wallet.publicKey,
			1
		);
		const depositRecord = depositRecords[0].data;
		assert(isVariant(depositRecord.direction, 'deposit'));
		assert(depositRecord.to === null);
		assert(depositRecord.from.equals(fromUser));
	});
});
