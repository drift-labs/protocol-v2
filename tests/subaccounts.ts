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
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { decodeName } from '../sdk/src/userName';
import { assert } from 'chai';
import {
	getTokenAmount,
	LAMPORTS_PRECISION,
	MARGIN_PRECISION,
	SpotBalanceType,
} from '../sdk';
import { PublicKey } from '@solana/web3.js';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('subaccounts', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;
	let usdcAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		usdcAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const marketIndexes = [0, 1];
		const spotMarketIndexes = [0, 1];

		driftClient = new TestClient({
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
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);
		await driftClient.updatePerpAuctionDuration(new BN(0));
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize first account', async () => {
		const donationAmount = LAMPORTS_PRECISION;
		const subAccountId = 0;
		const name = 'CRISP';
		await driftClient.initializeUserAccountAndDepositCollateral(
			LAMPORTS_PRECISION,
			bankrunContextWrapper.provider.wallet.publicKey,
			1,
			subAccountId,
			name,
			undefined,
			undefined,
			donationAmount
		);
		await driftClient.fetchAccounts();
		assert(driftClient.getUserAccount().subAccountId === subAccountId);
		assert(decodeName(driftClient.getUserAccount().name) === name);

		const userStats = driftClient.getUserStats().getAccount();

		assert(userStats.numberOfSubAccounts === 1);
		assert(driftClient.getStateAccount().numberOfAuthorities.eq(new BN(1)));
		assert(driftClient.getStateAccount().numberOfSubAccounts.eq(new BN(1)));

		const solSpotMarket = driftClient.getSpotMarketAccount(1);
		const revenuePool = solSpotMarket.revenuePool;
		const tokenAmount = getTokenAmount(
			revenuePool.scaledBalance,
			solSpotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(tokenAmount.eq(donationAmount));
	});

	it('Initialize second account', async () => {
		const donationAmount = LAMPORTS_PRECISION;
		const subAccountId = 1;
		const name = 'LIL PERP';
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			usdcAccount.publicKey,
			0,
			1,
			name,
			undefined,
			undefined,
			donationAmount
		);
		await driftClient.addUser(1);
		await driftClient.switchActiveUser(1);

		assert(driftClient.getUserAccount().subAccountId === subAccountId);
		assert(decodeName(driftClient.getUserAccount().name) === name);

		const userStats = driftClient.getUserStats().getAccount();

		assert(userStats.numberOfSubAccounts === 2);
		assert(userStats.numberOfSubAccountsCreated === 2);
		assert(driftClient.getStateAccount().numberOfAuthorities.eq(new BN(1)));
		assert(driftClient.getStateAccount().numberOfSubAccounts.eq(new BN(2)));

		const solSpotMarket = driftClient.getSpotMarketAccount(1);
		const revenuePool = solSpotMarket.revenuePool;
		const tokenAmount = getTokenAmount(
			revenuePool.scaledBalance,
			solSpotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(tokenAmount.eq(donationAmount.muln(2)));
	});

	it('Fetch all user account', async () => {
		const userAccounts = await fetchUserAccounts(
			bankrunContextWrapper.connection.toConnection(),
			chProgram,
			bankrunContextWrapper.provider.wallet.publicKey,
			2
		);
		assert(userAccounts.length === 2);
	});

	it('Deposit and transfer between accounts', async () => {
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
			bankrunContextWrapper.provider.wallet.publicKey,
			0
		);
		const withdrawRecord = depositRecords[1];
		assert(isVariant(withdrawRecord.direction, 'withdraw'));
		assert(withdrawRecord.transferUser.equals(toUser));

		const fromUser = await getUserAccountPublicKey(
			chProgram.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
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

		const updates = [{ marginRatio: customMarginRatio, subAccountId }];
		await driftClient.updateUserCustomMarginRatio(updates);

		await driftClient.fetchAccounts();
		assert(driftClient.getUserAccount().maxMarginRatio === customMarginRatio);
	});

	it('Update delegate', async () => {
		const delegateKeyPair = await createFundedKeyPair(bankrunContextWrapper);
		await driftClient.updateUserDelegate(delegateKeyPair.publicKey);

		await driftClient.fetchAccounts();
		assert(
			driftClient.getUserAccount().delegate.equals(delegateKeyPair.publicKey)
		);
	});

	it('delete user', async () => {
		await driftClient.switchActiveUser(1);

		let deleteFailed = false;
		try {
			const txSig = await driftClient.deleteUser(0);
			bankrunContextWrapper.printTxLogs(txSig);
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
