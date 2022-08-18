import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	ClearingHouse,
	findComputeUnitConsumption,
	BN,
	OracleSource,
	ZERO,
	EventSubscriber,
	MARK_PRICE_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteAssetBank,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolAssetBank,
	createUserWithUSDCAccount,
} from './testHelpers';
import { isVariant, ONE } from '../sdk';

describe('liquidate borrow', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let referrerClearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	let solOracle: PublicKey;

	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solOracle = await mockOracle(100);

		referrerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [],
			bankIndexes: [new BN(0)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await referrerClearingHouse.initialize(usdcMint.publicKey, true);
		await referrerClearingHouse.subscribe();

		await initializeQuoteAssetBank(referrerClearingHouse, usdcMint.publicKey);

		await referrerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await referrerClearingHouse.unsubscribe();
		await referrerClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize with referrer', async () => {});
});
