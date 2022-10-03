import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import {
	getUserAccountPublicKey,
	isVariant,
	QUOTE_SPOT_MARKET_INDEX,
	AdminClient,
	BN,
	EventSubscriber,
	fetchUserAccounts,
} from '../sdk/src';

import {
	createFundedKeyPair,
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { decodeName } from '../sdk/src/userName';
import { assert } from 'chai';
import { MARGIN_PRECISION } from '../sdk';

describe('subaccounts', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const driftProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, driftProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let usdcAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		usdcAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const marketIndexes = [0];
		const spotMarketIndexes = [0];

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			userStats: true,
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize first account', async () => {
		const userId = 0;
		const name = 'CRISP';
		await driftClient.initializeUserAccount(userId, name);

		assert(driftClient.getUserAccount().userId === userId);
		assert(decodeName(driftClient.getUserAccount().name) === name);

		const userStats = driftClient.getUserStats().getAccount();

		assert(userStats.numberOfUsers === 1);
	});

	it('Initialize second account', async () => {
		const userId = 1;
		const name = 'LIL PERP';
		await driftClient.initializeUserAccount(1, name);
		await driftClient.addUser(1);
		await driftClient.switchActiveUser(1);

		assert(driftClient.getUserAccount().userId === userId);
		assert(decodeName(driftClient.getUserAccount().name) === name);

		const userStats = driftClient.getUserStats().getAccount();

		assert(userStats.numberOfUsers === 2);
	});

	it('Fetch all user account', async () => {
		const userAccounts = await fetchUserAccounts(
			connection,
			driftProgram,
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
			driftProgram.programId,
			provider.wallet.publicKey,
			0
		);
		const withdrawRecord = depositRecords[1];
		assert(isVariant(withdrawRecord.direction, 'withdraw'));
		assert(withdrawRecord.to.equals(toUser));
		assert(withdrawRecord.from === null);

		const fromUser = await getUserAccountPublicKey(
			driftProgram.programId,
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
		await driftClient.updateUserName(name, userId);

		await driftClient.fetchAccounts();
		assert(decodeName(driftClient.getUserAccount().name) === name);
	});

	it('Update custom margin ratio', async () => {
		const userId = 0;
		const customMarginRatio = MARGIN_PRECISION.toNumber() * 2;
		await driftClient.updateUserCustomMarginRatio(customMarginRatio, userId);

		await driftClient.fetchAccounts();
		assert(
			driftClient.getUserAccount().customMarginRatio === customMarginRatio
		);
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
});
