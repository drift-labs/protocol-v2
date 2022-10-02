import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import {
	getUserAccountPublicKey,
	isVariant,
	QUOTE_SPOT_MARKET_INDEX,
	Admin,
	BN,
	EventSubscriber,
	fetchUserAccounts,
} from '../sdk/src';

import {
	createFundedKeyPair,
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { decodeName } from '../sdk/src/userName';
import { assert } from 'chai';
import { MARGIN_PRECISION } from '../sdk';

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

		const marketIndexes = [0];
		const spotMarketIndexes = [0];

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			userStats: true,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));
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

		const userStats = clearingHouse.getUserStats().getAccount();

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

		const userStats = clearingHouse.getUserStats().getAccount();

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
			QUOTE_SPOT_MARKET_INDEX,
			usdcAccount.publicKey
		);
		const txSig = await clearingHouse.transferDeposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
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

	it('Update user name', async () => {
		const userId = 0;
		const name = 'lil perp v2';
		await clearingHouse.updateUserName(name, userId);

		await clearingHouse.fetchAccounts();
		assert(decodeName(clearingHouse.getUserAccount().name) === name);
	});

	it('Update custom margin ratio', async () => {
		const userId = 0;
		const customMarginRatio = MARGIN_PRECISION.toNumber() * 2;
		await clearingHouse.updateUserCustomMarginRatio(customMarginRatio, userId);

		await clearingHouse.fetchAccounts();
		assert(
			clearingHouse.getUserAccount().customMarginRatio === customMarginRatio
		);
	});

	it('Update delegate', async () => {
		const delegateKeyPair = await createFundedKeyPair(connection);
		await clearingHouse.updateUserDelegate(delegateKeyPair.publicKey);

		await clearingHouse.fetchAccounts();
		assert(
			clearingHouse.getUserAccount().delegate.equals(delegateKeyPair.publicKey)
		);

		const delegateUserAccount = (
			await clearingHouse.getUserAccountsForDelegate(delegateKeyPair.publicKey)
		)[0];
		assert(delegateUserAccount.delegate.equals(delegateKeyPair.publicKey));
	});

	it('delete user', async () => {
		await clearingHouse.switchActiveUser(1);

		let deleteFailed = false;
		try {
			const txSig = await clearingHouse.deleteUser(0);
			await printTxLogs(connection, txSig);
		} catch (e) {
			assert(e.toString().includes('UserCantBeDeleted'));
			deleteFailed = true;
		}

		assert(deleteFailed);

		await clearingHouse.deleteUser(1);
	});
});
