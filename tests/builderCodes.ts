import * as anchor from '@coral-xyz/anchor';

import { Program, Wallet } from '@coral-xyz/anchor';

import {
	AccountInfo,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
} from '@solana/web3.js';

import {
	TestClient,
	OracleSource,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	PTYH_LAZER_PROGRAM_ID,
	assert,
	getRevenueShareAccountPublicKey,
	getRevenueShareEscrowAccountPublicKey,
	RevenueShareAccount,
	RevenueShareEscrow,
	BASE_PRECISION,
	BN,
	PRICE_PRECISION,
	getMarketOrderParams,
	PositionDirection,
	PostOnlyParams,
	MarketType,
	OrderParams,
	SignedMsgOrderParamsWithBuilderMessage,
	calculateBaseAssetAmountToFillUpToLimitPrice,
	PEG_PRECISION,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { PYTH_STORAGE_DATA } from './pythLazerData';
import { nanoid } from 'nanoid';

dotenv.config();

const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

describe('builder codes', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let builderClient: TestClient;

	let usdcMint: Keypair;
	let userUSDCAccount: PublicKey = null;
	let userKeypair: Keypair = null;
	let userClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solUsd: PublicKey;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	const usdcAmount = new BN(10000 * 10 ** 6);

	before(async () => {
		const context = await startAnchor(
			'',
			[],
			[
				{
					address: PYTH_LAZER_STORAGE_ACCOUNT_KEY,
					info: PYTH_STORAGE_ACCOUNT_INFO,
				},
			]
		);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 224.3);
		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		builderClient = new TestClient({
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
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await builderClient.initialize(usdcMint.publicKey, true);
		await builderClient.subscribe();

		await initializeQuoteSpotMarket(builderClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await builderClient.initializePerpMarket(
			0,
			solUsd,
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			new BN(10 * 10 ** 13).mul(new BN(Math.sqrt(PRICE_PRECISION.toNumber()))),
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);

		[userClient, userUSDCAccount, userKeypair] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await userClient.deposit(
			usdcAmount,
			0,
			userUSDCAccount,
			undefined,
			false,
			undefined,
			true
		);
	});

	after(async () => {
		await builderClient.unsubscribe();
		await userClient.unsubscribe();
	});

	it('builder can create revenue share', async () => {
		const numPositions = 16;
		await builderClient.initializeRevenueShare(
			builderClient.wallet.publicKey,
			numPositions
		);

		const revenueShareAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);

		const revenueShare: RevenueShareAccount =
			builderClient.program.account.revenueShare.coder.accounts.decodeUnchecked(
				'RevenueShare',
				revenueShareAccountInfo.data
			);
		assert(
			revenueShare.authority.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);
		assert(revenueShare.totalBuilderRewards.toNumber() === 0);
		assert(revenueShare.totalReferrerRewards.toNumber() === 0);
		assert(revenueShare.positions.length === numPositions);
	});

	it('builder can resize increase revenue share acc', async () => {
		const newPos = 80;
		await builderClient.resizeRevenueShare(
			builderClient.wallet.publicKey,
			newPos
		);

		const revenueShareAccountInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				getRevenueShareAccountPublicKey(
					builderClient.program.programId,
					builderClient.wallet.publicKey
				)
			);

		const revenueShare: RevenueShareAccount =
			builderClient.program.coder.accounts.decodeUnchecked(
				'RevenueShare',
				revenueShareAccountInfo.data
			);
		assert(
			revenueShare.authority.toBase58() ===
				builderClient.wallet.publicKey.toBase58()
		);
		assert(revenueShare.totalBuilderRewards.toNumber() === 0);
		assert(revenueShare.totalReferrerRewards.toNumber() === 0);
		assert(revenueShare.positions.length === newPos);
	});

	it('user can initialize a RevenueShareEscrow', async () => {
		const numOrders = 10;

		// Test the instruction creation
		const ix = await userClient.getInitializeRevenueShareEscrowIx(
			userClient.wallet.publicKey,
			numOrders
		);

		assert(ix !== null, 'Instruction should be created');
		assert(ix.programId.toBase58() === userClient.program.programId.toBase58());

		// Test the full transaction
		await userClient.initializeRevenueShareEscrow(
			userClient.wallet.publicKey,
			numOrders
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		assert(accountInfo !== null, 'RevenueShareEscrow account should exist');
		assert(
			accountInfo.owner.toBase58() === userClient.program.programId.toBase58()
		);

		const revShareEscrow: RevenueShareEscrow =
			builderClient.program.coder.accounts.decodeUnchecked(
				'RevenueShareEscrow',
				accountInfo.data
			);
		assert(
			revShareEscrow.authority.toBase58() ===
				userClient.wallet.publicKey.toBase58()
		);
		assert(revShareEscrow.referrer.toBase58() === PublicKey.default.toBase58());
		assert(revShareEscrow.orders.length === numOrders);
		assert(revShareEscrow.approvedBuilders.length === 0);
	});

	it('user can resize RevenueShareEscrow account', async () => {
		const newNumOrders = 20;

		// Test the instruction creation
		const ix = await userClient.getResizeRevenueShareEscrowOrdersIx(
			userClient.wallet.publicKey,
			newNumOrders
		);

		assert(ix !== null, 'Instruction should be created');
		assert(ix.programId.toBase58() === userClient.program.programId.toBase58());

		// Test the full transaction
		await userClient.resizeRevenueShareEscrowOrders(
			userClient.wallet.publicKey,
			newNumOrders
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		assert(
			accountInfo !== null,
			'RevenueShareEscrow account should exist after resize'
		);
		assert(
			accountInfo.owner.toBase58() === userClient.program.programId.toBase58()
		);

		const revShareEscrow: RevenueShareEscrow =
			builderClient.program.coder.accounts.decodeUnchecked(
				'RevenueShareEscrow',
				accountInfo.data
			);
		assert(
			revShareEscrow.authority.toBase58() ===
				userClient.wallet.publicKey.toBase58()
		);
		assert(revShareEscrow.referrer.toBase58() === PublicKey.default.toBase58());
		assert(revShareEscrow.orders.length === newNumOrders);
	});

	it('user can add/update/remove approved builder from RevenueShareEscrow', async () => {
		const builder = builderClient.wallet;
		const maxFeeBps = 150; // 1.5%

		// First add a builder
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			true // add
		);

		// Verify the builder was added
		let accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		let revShareEscrow: RevenueShareEscrow =
			userClient.program.coder.accounts.decodeUnchecked(
				'RevenueShareEscrow',
				accountInfo.data
			);
		const addedBuilder = revShareEscrow.approvedBuilders.find(
			(b) => b.authority.toBase58() === builder.publicKey.toBase58()
		);
		assert(
			addedBuilder !== undefined,
			'Builder should be in approved builders list before removal'
		);
		assert(
			revShareEscrow.approvedBuilders.length === 1,
			'Approved builders list should contain 1 builder'
		);
		assert(
			addedBuilder.maxFeeBps === maxFeeBps,
			'Builder should have correct max fee bps before removal'
		);

		// update the user fee
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps * 5,
			true // update existing builder
		);

		// Verify the builder was updated
		accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		revShareEscrow = userClient.program.coder.accounts.decodeUnchecked(
			'RevenueShareEscrow',
			accountInfo.data
		);
		const updatedBuilder = revShareEscrow.approvedBuilders.find(
			(b) => b.authority.toBase58() === builder.publicKey.toBase58()
		);
		assert(
			updatedBuilder !== undefined,
			'Builder should be in approved builders list after update'
		);
		assert(
			updatedBuilder.maxFeeBps === maxFeeBps * 5,
			'Builder should have correct max fee bps after update'
		);

		// Now remove the builder
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			false // remove
		);

		// Verify the builder was removed
		accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);

		revShareEscrow = userClient.program.coder.accounts.decodeUnchecked(
			'RevenueShareEscrow',
			accountInfo.data
		);
		const removedBuilder = revShareEscrow.approvedBuilders.find(
			(b) => b.authority.toBase58() === builder.publicKey.toBase58()
		);
		assert(
			removedBuilder.maxFeeBps === 0,
			'Builder should have 0 max fee bps after removal'
		);
	});

	it('user can place swift order with builder and no delegate', async () => {
		// await userClient.deposit(usdcAmount, 0, userUSDCAccount.publicKey);

		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// approve builder again
		const builder = builderClient.wallet;
		const maxFeeBps = 150; // 1.5%
		await userClient.changeApprovedBuilder(
			userClient.wallet.publicKey,
			builder.publicKey,
			maxFeeBps,
			true // update existing builder
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(224).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(223).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(224).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));

		// Should fail if we try first without encoding properly

		let userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 0);

		const takerOrderParamsMessage: SignedMsgOrderParamsWithBuilderMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
			builderIdx: 0,
			builderFee: 5,
		};

		const signedOrderParams = userClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage,
			false,
			true
		);

		const txSig = await builderClient.placeSignedMsgTakerOrder(
			signedOrderParams,
			marketIndex,
			{
				taker: await userClient.getUserAccountPublicKey(),
				takerUserAccount: userClient.getUserAccount(),
				takerStats: userClient.getUserStatsAccountPublicKey(),
				signingAuthority: userClient.wallet.publicKey,
			},
			undefined,
			2
		);

		await userClient.fetchAccounts();

		userOrders = userClient.getUser().getOpenOrders();
		assert(userOrders.length === 1);

		// Verify the builder was removed
		let accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			getRevenueShareEscrowAccountPublicKey(
				userClient.program.programId,
				userClient.wallet.publicKey
			)
		);
		let revShareEscrow = userClient.program.coder.accounts.decodeUnchecked(
			'RevenueShareEscrow',
			accountInfo.data
		);
		console.log(revShareEscrow);
	});
});
