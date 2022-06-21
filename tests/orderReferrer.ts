import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	getLimitOrderParams,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { AMM_RESERVE_PRECISION, OracleSource } from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('order referrer', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;

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

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerClearingHouse: ClearingHouse;
	let fillerUser: ClearingHouseUser;

	const referrerKeyPair = new Keypair();
	let referrerUSDCAccount: Keypair;
	let referrerClearingHouse: ClearingHouse;
	let referrerUser: ClearingHouseUser;

	const marketIndex = new BN(0);
	let solUsd;
	let btcUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);

		const marketIndexes = [new BN(0), new BN(1)];
		const bankIndexes = [new BN(0)];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: btcUsd, source: OracleSource.PYTH },
		];

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000000) // btc-ish price level
		);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await clearingHouseUser.subscribe();

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

		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			fillerKeyPair.publicKey
		);
		fillerClearingHouse = ClearingHouse.from(
			connection,
			new Wallet(fillerKeyPair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);
		await fillerClearingHouse.subscribe();

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = ClearingHouseUser.from(
			fillerClearingHouse,
			fillerKeyPair.publicKey
		);
		await fillerUser.subscribe();

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
			chProgram.programId,
			undefined,
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);
		await referrerClearingHouse.subscribe();

		await referrerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			referrerUSDCAccount.publicKey
		);

		referrerUser = ClearingHouseUser.from(
			referrerClearingHouse,
			referrerKeyPair.publicKey
		);
		await referrerUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerClearingHouse.unsubscribe();
		await fillerUser.unsubscribe();
		await referrerUser.unsubscribe();
		await referrerClearingHouse.unsubscribe();
	});

	it('place then fill', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			true,
			true
		);

		const referrerUserAccountPublicKey =
			await referrerUser.getUserAccountPublicKey();
		await clearingHouse.placeOrder(
			orderParams,
			discountTokenAccount.address,
			referrerUserAccountPublicKey
		);

		const orderIndex = new BN(0);

		await clearingHouse.fetchAccounts();
		const order =
			clearingHouseUser.getUserAccount().orders[orderIndex.toString()];
		assert(order.referrer.equals(referrerUserAccountPublicKey));

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await fillerClearingHouse.settlePNLs(
			[
				{
					settleeUserAccountPublicKey:
						await clearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: clearingHouse.getUserAccount(),
				},
				{
					settleeUserAccountPublicKey:
						await fillerClearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: fillerClearingHouse.getUserAccount(),
				},
			],
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();
		await referrerUser.fetchAccounts();

		const expectedFillerReward = new BN(90);
		assert(
			fillerClearingHouse
				.getQuoteAssetTokenAmount()
				.sub(usdcAmount)
				.eq(expectedFillerReward)
		);

		const referrerUserAccount = referrerUser.getUserAccount();
		const expectedReferrerReward = new BN(50);
		assert(referrerUserAccount.totalReferralReward.eq(expectedReferrerReward));

		const market = clearingHouse.getMarketAccount(marketIndex);
		const expectedFeeToMarket = new BN(760);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(50);
		const expectedRefereeDiscount = new BN(50);
		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));
		assert(userAccount.totalRefereeDiscount.eq(expectedRefereeDiscount));

		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
	});

	it('place_and_fill', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			true,
			true
		);

		const referrerUserAccountPublicKey =
			await referrerUser.getUserAccountPublicKey();
		await clearingHouse.placeAndFillOrder(
			orderParams,
			discountTokenAccount.address,
			referrerUserAccountPublicKey
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await referrerUser.fetchAccounts();

		const referrerUserAccount = referrerUser.getUserAccount();
		const expectedReferrerReward = new BN(100);
		assert(referrerUserAccount.totalReferralReward.eq(expectedReferrerReward));

		const market = clearingHouse.getMarketAccount(marketIndex);
		const expectedFeeToMarket = new BN(1610);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(100);
		const expectedRefereeDiscount = new BN(100);
		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));
		assert(userAccount.totalRefereeDiscount.eq(expectedRefereeDiscount));
	});
});
