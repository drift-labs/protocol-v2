import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('fees', () => {
	const provider = anchor.Provider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let referrerClearingHouse: ClearingHouse;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let discountMint: Token;
	let discountTokenAccount: AccountInfo;

	const referrerKeyPair = new Keypair();
	let referrerUSDCAccount: Keypair;
	let referrerUserAccountPublicKey: PublicKey;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

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

		discountMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			6,
			TOKEN_PROGRAM_ID
		);

		await clearingHouse.updateDiscountMint(discountMint.publicKey);

		discountTokenAccount = await discountMint.getOrCreateAssociatedAccountInfo(
			provider.wallet.publicKey
		);

		provider.connection.requestAirdrop(referrerKeyPair.publicKey, 10 ** 9);
		referrerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			referrerKeyPair.publicKey
		);
		referrerClearingHouse = ClearingHouse.from(
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
		await referrerClearingHouse.unsubscribe();
	});

	it('Trade no rebate', async () => {
		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			discountTokenAccount.address
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9990000)));
		assert(user.totalFeePaid.eq(new BN(10000)));
		assert(user.totalTokenDiscount.eq(new BN(0)));
		assert(user.totalRefereeDiscount.eq(new BN(0)));
	});

	it('Trade fourth tier rebate', async () => {
		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			discountTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9981000)));
		assert(user.totalFeePaid.eq(new BN(19000)));
		assert(user.totalTokenDiscount.eq(new BN(500)));
		assert(user.totalRefereeDiscount.eq(new BN(500)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(500)));
	});

	it('Trade third tier rebate', async () => {
		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			10000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			discountTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9972500)));
		assert(user.totalFeePaid.eq(new BN(27500)));
		assert(user.totalTokenDiscount.eq(new BN(1500)));
		assert(user.totalRefereeDiscount.eq(new BN(1000)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(1000)));
	});

	it('Trade second tier rebate', async () => {
		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			100000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0),
			discountTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9964500)));
		assert(user.totalFeePaid.eq(new BN(35500)));
		assert(user.totalTokenDiscount.eq(new BN(3000)));
		assert(user.totalRefereeDiscount.eq(new BN(1500)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(1500)));
	});

	it('Trade first tier rebate', async () => {
		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000000 * 10 ** 6
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount.mul(new BN(9)).div(new BN(10)),
			marketIndex,
			new BN(0),
			discountTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9957750)));
		assert(user.totalFeePaid.eq(new BN(42250)));
		assert(user.totalTokenDiscount.eq(new BN(4800)));
		assert(user.totalRefereeDiscount.eq(new BN(1950)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(1950)));
	});

	it('Close position', async () => {
		const marketIndex = new BN(0);
		await clearingHouse.closePosition(
			marketIndex,
			discountTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9921000)));
		assert(user.totalFeePaid.eq(new BN(79000)));
		assert(user.totalTokenDiscount.eq(new BN(14600)));
		assert(user.totalRefereeDiscount.eq(new BN(4400)));

		const referrer: any = await clearingHouse.program.account.user.fetch(
			referrerUserAccountPublicKey
		);

		assert(referrer.totalReferralReward.eq(new BN(4400)));
	});
});
