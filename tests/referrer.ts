import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	OracleSource,
	EventSubscriber,
	ClearingHouse,
	Wallet,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteAssetBank,
	createFundedKeyPair,
	printTxLogs,
} from './testHelpers';

describe('liquidate borrow', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let referrerClearingHouse: Admin;

	let refereeKeyPair: Keypair;
	let referreeClearingHouse: ClearingHouse;

	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let referrerUSDCAccount;

	let solOracle: PublicKey;

	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		referrerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider
		);

		solOracle = await mockOracle(100);

		const marketIndexes = [];
		const bankIndexes = [new BN(0)];
		const oracleInfos = [
			{
				publicKey: solOracle,
				source: OracleSource.PYTH,
			},
		];
		referrerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
			userStats: true,
		});

		await referrerClearingHouse.initialize(usdcMint.publicKey, true);
		await referrerClearingHouse.subscribe();

		await initializeQuoteAssetBank(referrerClearingHouse, usdcMint.publicKey);

		await referrerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			referrerUSDCAccount.publicKey
		);

		refereeKeyPair = await createFundedKeyPair(connection);
		await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			refereeKeyPair.publicKey
		);

		referreeClearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(refereeKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
			userStats: true,
		});
		await referreeClearingHouse.subscribe();
	});

	after(async () => {
		await referrerClearingHouse.unsubscribe();
		await referreeClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize with referrer', async () => {
		const [txSig] = await referreeClearingHouse.initializeUserAccount(
			0,
			'crisp',
			{
				referrer: await referrerClearingHouse.getUserAccountPublicKey(),
				referrerStats: referrerClearingHouse.getUserStatsAccountPublicKey(),
			}
		);

		await printTxLogs(connection, txSig);

		await referreeClearingHouse.fetchAccounts();
		const refereeStats = referreeClearingHouse.getUserStats().getAccount();
		console.log(refereeStats.referrer.toString());
		assert(refereeStats.referrer.equals(provider.wallet.publicKey));

		const referrerStats = referrerClearingHouse.getUserStats().getAccount();
		assert(referrerStats.isReferrer == true);
	});
});
