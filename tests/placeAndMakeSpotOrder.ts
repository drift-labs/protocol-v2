import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
	Admin,
	BN,
	PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	EventSubscriber,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';

describe('place and make spot order', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let makerClearingHouse: Admin;
	let makerClearingHouseUser: ClearingHouseUser;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(100 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(32.821);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		makerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await makerClearingHouse.initialize(usdcMint.publicKey, true);
		await makerClearingHouse.subscribe();
		await initializeQuoteSpotMarket(makerClearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(makerClearingHouse, solUsd);
		await makerClearingHouse.updatePerpAuctionDuration(new BN(0));

		await makerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const oneSol = new BN(LAMPORTS_PER_SOL);
		await makerClearingHouse.deposit(oneSol, 1, provider.wallet.publicKey);

		makerClearingHouseUser = new ClearingHouseUser({
			clearingHouse: makerClearingHouse,
			userAccountPublicKey: await makerClearingHouse.getUserAccountPublicKey(),
		});
		await makerClearingHouseUser.subscribe();
	});

	after(async () => {
		await makerClearingHouse.unsubscribe();
		await makerClearingHouseUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('make', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerClearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
		});
		await takerClearingHouse.subscribe();
		await takerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const takerClearingHouseUser = new ClearingHouseUser({
			clearingHouse: takerClearingHouse,
			userAccountPublicKey: await takerClearingHouse.getUserAccountPublicKey(),
		});
		await takerClearingHouseUser.subscribe();

		const marketIndex = 1;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(40).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: false,
		});
		await takerClearingHouse.placeSpotOrder(takerOrderParams);
		await takerClearingHouseUser.fetchAccounts();
		const order = takerClearingHouseUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(40).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: true,
			immediateOrCancel: true,
		});

		const txSig = await makerClearingHouse.placeAndMakeSpotOrder(
			makerOrderParams,
			{
				taker: await takerClearingHouse.getUserAccountPublicKey(),
				order: takerClearingHouse.getOrderByUserId(1),
				takerUserAccount: takerClearingHouse.getUserAccount(),
				takerStats: takerClearingHouse.getUserStatsAccountPublicKey(),
			}
		);

		await printTxLogs(connection, txSig);

		const makerUSDCAmount = makerClearingHouse.getQuoteAssetTokenAmount();
		const makerSolAmount = makerClearingHouse.getTokenAmount(1);
		assert(makerUSDCAmount.eq(new BN(140008000)));
		assert(makerSolAmount.eq(new BN(0)));

		const takerUSDCAmount = takerClearingHouse.getQuoteAssetTokenAmount();
		const takerSolAmount = takerClearingHouse.getTokenAmount(1);
		assert(takerUSDCAmount.eq(new BN(59960000)));
		assert(takerSolAmount.eq(new BN(1000000000)));

		await takerClearingHouseUser.unsubscribe();
		await takerClearingHouse.unsubscribe();
	});
});
