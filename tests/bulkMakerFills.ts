import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	Wallet,
	EventSubscriber,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource,
	DriftClient,
	OracleInfo,
	getTokenAmount,
	getSignedTokenAmount,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';
import {
	BulkAccountLoader,
	MakerInfo,
	PEG_PRECISION,
	PostOnlyParams,
	QUOTE_PRECISION,
	UserStats,
} from '../sdk';
import { parseLogs } from '../sdk/lib/events/parse';
import { IDL } from '../target/types/drift';

const MAKERS_TO_INIT = 10;

const initDriftClient = async (
	bulkAccountLoader: BulkAccountLoader,
	provider: anchor.AnchorProvider,
	program: Program,
	usdcMint: Keypair,
	usdcAmount: BN,
	marketIndexes: Array<number>,
	spotMarketIndexes: Array<number>,
	oracleInfos: Array<OracleInfo>
): Promise<TestClient> => {
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
	const driftClient = new TestClient({
		connection: provider.connection,
		wallet,
		programID: program.programId,
		opts: {
			commitment: 'processed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: marketIndexes,
		spotMarketIndexes: spotMarketIndexes,
		oracleInfos,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await driftClient.subscribe();

	await driftClient.initializeUserAccountAndDepositCollateral(
		usdcAmount,
		userUSDCAccount.publicKey
	);

	const user = new User({
		driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await user.subscribe();

	const userstatskey = driftClient.getUserStatsAccountPublicKey();

	const userStats = new UserStats({
		// @ts-ignore
		driftClient,
		userStatsAccountPublicKey: userstatskey,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await userStats.subscribe();

	return driftClient;
};

async function verifyFillTx(
	chProgram: Program,
	connection: anchor.web3.Connection,
	txSig: string,
	print: boolean = false
) {
	let tries = 0;
	while (true) {
		assert(tries < 10, 'fill tx not found');

		const tx = await connection.getTransaction(txSig, {
			commitment: 'confirmed',
			maxSupportedTransactionVersion: 0,
		});
		if (tx === null) {
			tries++;
			await sleep(100);
			continue;
		}
		if (tx.meta) {
			if (print) {
				console.log(tx.meta.logMessages);
				console.log(
					JSON.stringify(
						parseLogs(chProgram, tx.slot, tx.meta.logMessages),
						null,
						2
					)
				);
			}

			console.log(`CUs consumed: ${tx.meta.computeUnitsConsumed}`);
			console.log(
				`transaction size: ${tx.transaction.message.serialize().length} bytes`
			);
			assert(tx.meta.err === null, `Fill tx errored: ${tx.meta.err}`);
			break;
		} else {
			console.error('tx has no meta???');
			break;
		}
	}
}

describe('bulk maker fill perp orders', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'processed',
		preflightCommitment: 'processed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let testDriftClient: TestClient;
	let takerDriftClient: TestClient;
	const makerDriftClients: Array<TestClient> = [];
	// let makerDriftClientUser: User;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'processed', 1);

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(1e6).mul(QUOTE_PRECISION);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(50.0);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		// initialize markets
		testDriftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'processed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await testDriftClient.initialize(usdcMint.publicKey, true);
		await testDriftClient.subscribe();
		await initializeQuoteSpotMarket(testDriftClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await testDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(32 * PEG_PRECISION.toNumber())
		);

		await testDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		// initialize taker
		takerDriftClient = await initDriftClient(
			bulkAccountLoader,
			provider,
			chProgram,
			usdcMint,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos
		);

		// initialize makers
		for (let i = 0; i < MAKERS_TO_INIT; i++) {
			makerDriftClients.push(
				await initDriftClient(
					bulkAccountLoader,
					provider,
					chProgram,
					usdcMint,
					usdcAmount,
					marketIndexes,
					spotMarketIndexes,
					oracleInfos
				)
			);
		}

		await takerDriftClient.cancelOrders();
		for (const m of makerDriftClients) {
			await m.cancelOrders();
		}
	});

	after(async () => {
		await takerDriftClient.cancelOrders();
		for (const m of makerDriftClients) {
			await m.cancelOrders();
		}

		await testDriftClient.unsubscribe();
		await takerDriftClient.unsubscribe();
		for (const m of makerDriftClients) {
			await m.unsubscribe();
		}
		await eventSubscriber.unsubscribe();
	});

	it('Perp fill 1 taker 1 maker, 1 order each', async () => {
		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;

		await takerDriftClient.placePerpOrder(
			getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				price: new BN(51).mul(PRICE_PRECISION),
				auctionDuration: 1,
				auctionStartPrice: new BN(50).mul(PRICE_PRECISION),
				auctionEndPrice: new BN(51).mul(PRICE_PRECISION),
				postOnly: PostOnlyParams.NONE,
			})
		);
		await takerDriftClient.fetchAccounts();
		const takerOrders = takerDriftClient.getUser().getOpenOrders();
		assert(takerOrders.length === 1, `Taker has ${takerOrders.length} orders`);

		const maker = makerDriftClients[0];
		await maker.placePerpOrder(
			getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				price: new BN(49).mul(PRICE_PRECISION),
				auctionDuration: null,
				postOnly: PostOnlyParams.NONE,
			})
		);
		await maker.fetchAccounts();
		const makerOrders = maker.getUser().getOpenOrders();
		assert(makerOrders.length === 1, `Maker has ${makerOrders.length} orders`);

		await testDriftClient.fetchAccounts();
		const startActiveSlot = testDriftClient.getUserAccount().lastActiveSlot;

		const fillTx = await testDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerOrders[0],
			[
				{
					maker: await maker.getUserAccountPublicKey(),
					makerStats: maker.getUserStatsAccountPublicKey(),
					makerUserAccount: maker.getUserAccount(),
					order: makerOrders[0],
				},
			]
		);

		await verifyFillTx(chProgram, provider.connection, fillTx, true);

		await testDriftClient.fetchAccounts();
		const endActiveSlot = testDriftClient.getUserAccount().lastActiveSlot;
		assert(endActiveSlot > startActiveSlot, `Filler active slot unchanged`);
	});

	it('Perp fill 1 taker (1 order) with 1 maker (5 orders)', async () => {
		const marketIndex = 0;

		await takerDriftClient.placePerpOrder(
			getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount: new BN(10).mul(BASE_PRECISION),
				price: new BN(55).mul(PRICE_PRECISION),
				auctionDuration: 1,
				auctionStartPrice: new BN(49).mul(PRICE_PRECISION),
				auctionEndPrice: new BN(55).mul(PRICE_PRECISION),
				postOnly: PostOnlyParams.NONE,
			})
		);
		await takerDriftClient.fetchAccounts();
		const takerOrders = takerDriftClient.getUser().getOpenOrders();
		assert(takerOrders.length === 1, `Taker has ${takerOrders.length} orders`);

		const maker = makerDriftClients[0];

		for (let i = 1; i <= 5; i++) {
			await maker.placePerpOrder(
				getLimitOrderParams({
					marketIndex,
					direction: PositionDirection.SHORT,
					baseAssetAmount: BASE_PRECISION,
					price: new BN(49).mul(PRICE_PRECISION),
					auctionDuration: null,
					postOnly: PostOnlyParams.NONE,
				})
			);
		}

		await maker.fetchAccounts();
		const makerOrders = maker.getUser().getOpenOrders();
		assert(makerOrders.length === 5, `Maker has ${makerOrders.length} orders`);

		await testDriftClient.fetchAccounts();
		const startActiveSlot = testDriftClient.getUserAccount().lastActiveSlot;

		const fillTx = await testDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerOrders[0],
			[
				{
					maker: await maker.getUserAccountPublicKey(),
					makerStats: maker.getUserStatsAccountPublicKey(),
					makerUserAccount: maker.getUserAccount(),
					order: maker.getOrderByUserId(1),
				},
			]
		);

		await verifyFillTx(chProgram, provider.connection, fillTx, false);

		await testDriftClient.fetchAccounts();
		const endActiveSlot = testDriftClient.getUserAccount().lastActiveSlot;
		assert(endActiveSlot > startActiveSlot, `Filler active slot unchanged`);
	});

	it('Perp fill 1 taker with 10 makers, 1 order each', async () => {
		const marketIndex = 0;
		const numMakers = 10;

		await takerDriftClient.placePerpOrder(
			getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount: new BN(10).mul(BASE_PRECISION),
				price: new BN(55).mul(PRICE_PRECISION),
				auctionDuration: 1,
				auctionStartPrice: new BN(49).mul(PRICE_PRECISION),
				auctionEndPrice: new BN(55).mul(PRICE_PRECISION),
				postOnly: PostOnlyParams.NONE,
			})
		);
		await takerDriftClient.fetchAccounts();
		const takerOrders = takerDriftClient.getUser().getOpenOrders();
		assert(takerOrders.length === 1, `Taker has ${takerOrders.length} orders`);

		for (let i = 0; i < numMakers; i++) {
			const maker = makerDriftClients[i];
			await maker.placePerpOrder(
				getLimitOrderParams({
					marketIndex,
					direction: PositionDirection.SHORT,
					baseAssetAmount: BASE_PRECISION,
					price: new BN(49).mul(PRICE_PRECISION),
					auctionDuration: null,
					postOnly: PostOnlyParams.NONE,
				})
			);
		}
		const makerInfos: MakerInfo[] = [];
		for (let i = 0; i < numMakers; i++) {
			const maker = makerDriftClients[i];
			await maker.fetchAccounts();
			const makerOrders = maker.getUser().getOpenOrders();
			assert(
				makerOrders.length === 1,
				`Maker has ${makerOrders.length} orders`
			);

			makerInfos.push({
				maker: await maker.getUserAccountPublicKey(),
				makerStats: maker.getUserStatsAccountPublicKey(),
				makerUserAccount: maker.getUserAccount(),
				order: makerOrders[0],
			});
		}

		await testDriftClient.fetchAccounts();
		const startActiveSlot = testDriftClient.getUserAccount().lastActiveSlot;

		const fillTx = await testDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerOrders[0],
			makerInfos
		);

		await verifyFillTx(chProgram, provider.connection, fillTx, true);

		await testDriftClient.fetchAccounts();
		const endActiveSlot = testDriftClient.getUserAccount().lastActiveSlot;
		assert(endActiveSlot > startActiveSlot, `Filler active slot unchanged`);
	});
});
