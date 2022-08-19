import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	OracleSource,
	EventSubscriber,
	getInsuranceFundStakeAccountPublicKey,
	InsuranceFundStake,
	ZERO,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteAssetBank,
} from './testHelpers';

describe('insurance fund stake', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	let solOracle: PublicKey;

	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			provider
		);

		solOracle = await mockOracle(100);

		clearingHouse = new Admin({
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

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize if stake', async () => {
		const bankIndex = new BN(0);
		await clearingHouse.initializeInsuranceFundStake(bankIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);
		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.bankIndex.eq(bankIndex));
		assert(ifStakeAccount.authority.equals(provider.wallet.publicKey));
	});

	it('user if stake', async () => {
		const bankIndex = new BN(0);
		try {
			const txSig = await clearingHouse.addInsuranceLiquidity(
				bankIndex,
				usdcAmount,
				userUSDCAccount.publicKey
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const bank0 = clearingHouse.getBankAccount(bankIndex);
		assert(bank0.totalLpShares.gt(ZERO));
		assert(bank0.totalLpShares.eq(usdcAmount));
		assert(bank0.userLpShares.eq(usdcAmount));
	});

	it('user request if unstake', async () => {
		const bankIndex = new BN(0);
		const nShares = usdcAmount.div(new BN(2));
		try {
			const txSig = await clearingHouse.requestRemoveInsuranceLiquidity(
				nShares,
				bankIndex
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const bank0 = clearingHouse.getBankAccount(bankIndex);
		assert(bank0.totalLpShares.gt(ZERO));
		assert(bank0.totalLpShares.eq(usdcAmount));
		assert(bank0.userLpShares.eq(usdcAmount));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
	});
});
