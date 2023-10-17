import * as anchor from '@coral-xyz/anchor';

import { Program } from '@coral-xyz/anchor';

import {
	getUserAccountPublicKey,
	isVariant,
	QUOTE_SPOT_MARKET_INDEX,
	TestClient,
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
import { BulkAccountLoader, MARGIN_PRECISION } from '../sdk';

describe('subaccounts', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let usdcAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		usdcAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const marketIndexes = [0];
		const spotMarketIndexes = [0];

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize();
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize first account', async () => {
		const subAccountId = 0;
		const name = 'CRISP';
		await driftClient.initializeUserAccount(subAccountId, name);
		await driftClient.fetchAccounts();
		assert(driftClient.getUserAccount().subAccountId === subAccountId);
		assert(decodeName(driftClient.getUserAccount().name) === name);

		const userStats = driftClient.getUserStats().getAccount();

		assert(userStats.numberOfSubAccounts === 1);
		assert(driftClient.getStateAccount().numberOfAuthorities.eq(new BN(1)));
		assert(driftClient.getStateAccount().numberOfSubAccounts.eq(new BN(1)));
	});

	it('Initialize second account', async () => {
		const subAccountId = 1;
		const name = 'LIL PERP';
		await driftClient.initializeUserAccount(1, name);
		await driftClient.addUser(1);
		await driftClient.switchActiveUser(1);

		assert(driftClient.getUserAccount().subAccountId === subAccountId);
		assert(decodeName(driftClient.getUserAccount().name) === name);

		const userStats = driftClient.getUserStats().getAccount();

		assert(userStats.numberOfSubAccounts === 2);
		assert(userStats.numberOfSubAccountsCreated === 2);
		assert(driftClient.getStateAccount().numberOfAuthorities.eq(new BN(1)));
		assert(driftClient.getStateAccount().numberOfSubAccounts.eq(new BN(2)));
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
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			usdcAccount.publicKey
		);
		const txSig = await driftClient.transferDeposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			1,
			0
		);
		await driftClient.switchActiveUser(0);

		assert(driftClient.getQuoteAssetTokenAmount().eq(usdcAmount));

		await eventSubscriber.awaitTx(txSig);
		const depositRecords = eventSubscriber.getEventsArray('DepositRecord');

		const toUser = await getUserAccountPublicKey(
			chProgram.programId,
			provider.wallet.publicKey,
			0
		);
		const withdrawRecord = depositRecords[1];
		assert(isVariant(withdrawRecord.direction, 'withdraw'));
		assert(withdrawRecord.transferUser.equals(toUser));

		const fromUser = await getUserAccountPublicKey(
			chProgram.programId,
			provider.wallet.publicKey,
			1
		);
		const depositRecord = depositRecords[0];
		assert(isVariant(depositRecord.direction, 'deposit'));
		assert(depositRecord.transferUser.equals(fromUser));
	});

	it('Update user name', async () => {
		const subAccountId = 0;
		const name = 'lil perp v2';
		await driftClient.updateUserName(name, subAccountId);

		await driftClient.fetchAccounts();
		assert(decodeName(driftClient.getUserAccount().name) === name);
	});

	it('Update custom margin ratio', async () => {
		const subAccountId = 0;
		const customMarginRatio = MARGIN_PRECISION.toNumber() * 2;
		await driftClient.updateUserCustomMarginRatio(
			customMarginRatio,
			subAccountId
		);

		await driftClient.fetchAccounts();
		assert(driftClient.getUserAccount().maxMarginRatio === customMarginRatio);
	});

	it('Update delegate', async () => {
		const delegateKeyPair = await createFundedKeyPair(connection);
		await driftClient.updateUserDelegate(delegateKeyPair.publicKey);

		await driftClient.fetchAccounts();
		assert(
			driftClient.getUserAccount().delegate.equals(delegateKeyPair.publicKey)
		);

		const delegateUserAccount = (
			await driftClient.getUserAccountsForDelegate(delegateKeyPair.publicKey)
		)[0];
		assert(delegateUserAccount.delegate.equals(delegateKeyPair.publicKey));
	});

	it('delete user', async () => {
		await driftClient.switchActiveUser(1);

		let deleteFailed = false;
		try {
			const txSig = await driftClient.deleteUser(0);
			await printTxLogs(connection, txSig);
		} catch (e) {
			deleteFailed = true;
		}

		assert(deleteFailed);

		await driftClient.deleteUser(1);

		assert(driftClient.getStateAccount().numberOfAuthorities.eq(new BN(1)));
		assert(driftClient.getStateAccount().numberOfSubAccounts.eq(new BN(1)));
	});

	it('fail to reinitialize subaccount 0', async () => {
		const subAccountId = 1;
		const name = 'LIL PERP';

		let initializeFailed = false;
		try {
			await driftClient.initializeUserAccount(subAccountId, name);
		} catch (e) {
			assert(e.toString().includes('0x1846'));
			initializeFailed = true;
		}

		assert(initializeFailed);
	});
});
