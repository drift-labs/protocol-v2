import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import { AMM_MANTISSA, ClearingHouse, PositionDirection } from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from '../utils/mockAccounts';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('fees', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let driftMint: Token;
	let driftTokenAccount: AccountInfo;

	const referrerKeyPair = new Keypair();
	let referrerUSDCAccount: Keypair;
	let referrerUserAccountPublicKey: PublicKey;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = new ClearingHouse(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		driftMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			6,
			TOKEN_PROGRAM_ID
		);

		await clearingHouse.updateDriftMint(driftMint.publicKey);

		driftTokenAccount = await driftMint.getOrCreateAssociatedAccountInfo(
			provider.wallet.publicKey
		);

		provider.connection.requestAirdrop(referrerKeyPair.publicKey, 10 ** 9);
		referrerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			referrerKeyPair.publicKey
		);
		const referrerClearingHouse = new ClearingHouse(
			connection,
			new Wallet(referrerKeyPair),
			chProgram.programId
		);
		await referrerClearingHouse.subscribe();

		[, referrerUserAccountPublicKey] =
			await referrerClearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				referrerUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Trade no rebate', async () => {
		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			driftTokenAccount.address
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9999500)));
		assert(user.totalFeePaid.eq(new BN(500)));
		assert(user.totalDriftTokenRebate.eq(new BN(0)));
		assert(user.totalRefereeRebate.eq(new BN(0)));
	});

	it('Trade fourth tier rebate', async () => {
		await driftMint.mintTo(
			driftTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			driftTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9999075)));
		assert(user.totalFeePaid.eq(new BN(925)));
		assert(user.totalDriftTokenRebate.eq(new BN(25)));
		assert(user.totalRefereeRebate.eq(new BN(25)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(25)));
	});

	it('Trade third tier rebate', async () => {
		await driftMint.mintTo(
			driftTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			10000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			driftTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9998675)));
		assert(user.totalFeePaid.eq(new BN(1325)));
		assert(user.totalDriftTokenRebate.eq(new BN(75)));
		assert(user.totalRefereeRebate.eq(new BN(50)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(50)));
	});

	it('Trade second tier rebate', async () => {
		await driftMint.mintTo(
			driftTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			100000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			driftTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9998300)));
		assert(user.totalFeePaid.eq(new BN(1700)));
		assert(user.totalDriftTokenRebate.eq(new BN(150)));
		assert(user.totalRefereeRebate.eq(new BN(75)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(75)));
	});

	it('Trade first tier rebate', async () => {
		await driftMint.mintTo(
			driftTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			userAccountPublicKey,
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			driftTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9997950)));
		assert(user.totalFeePaid.eq(new BN(2050)));
		assert(user.totalDriftTokenRebate.eq(new BN(250)));
		assert(user.totalRefereeRebate.eq(new BN(100)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(100)));
	});

	it('Close position', async () => {
		const marketIndex = new BN(0);
		await clearingHouse.closePosition(
			userAccountPublicKey,
			marketIndex,
			driftTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9996200)));
		assert(user.totalFeePaid.eq(new BN(3800)));
		assert(user.totalDriftTokenRebate.eq(new BN(750)));
		assert(user.totalRefereeRebate.eq(new BN(225)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(225)));
	});
});
