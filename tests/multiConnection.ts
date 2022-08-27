import * as anchor from '@project-serum/anchor';

import { assert } from 'chai';
import { Program } from '@project-serum/anchor';

import { Buffer } from 'buffer';
import {
	Connection,
	Commitment,
	PublicKey,
	Keypair,
	RpcResponseAndContext,
	AccountInfo,
} from '@solana/web3.js';

import {
	Admin,
	BN,
	BulkAccountLoader,
	ClearingHouse,
	EventSubscriber,
	getMarketOrderParams,
	MultiConnection,
	isVariant,
	BASE_PRECISION,
	PositionDirection,
	OracleSource,
	Wallet,
	MARK_PRICE_PRECISION,
	convertToNumber,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printOpenOrders,
} from './testHelpers';

class mockConnection extends Connection {
	private connection: Connection;
	private enabled = true;
	public callCount = 0;

	constructor(connection: Connection) {
		super(connection.rpcEndpoint);
		this.connection = connection;
	}

	async getMultipleAccountsInfoAndContext(
		publicKeys: PublicKey[],
		commitment?: Commitment
	): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>> {
		if (this.enabled) {
			this.callCount++;
			return this.connection.getMultipleAccountsInfoAndContext(
				publicKeys,
				commitment
			);
		} else {
			return Promise.resolve(null);
		}
	}

	enable() {
		this.enabled = true;
	}

	disable() {
		this.enabled = false;
	}
}

describe('multiConnection', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let adminClearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	const usdcAmount = new BN(1000000 * 10 ** 6);

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		adminClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
		});
		await adminClearingHouse.initialize(usdcMint.publicKey, true);
		await adminClearingHouse.subscribe();

		await initializeQuoteAssetBank(adminClearingHouse, usdcMint.publicKey);
		await adminClearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		await adminClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await adminClearingHouse.fetchAccounts();
	});

	after(async () => {
		await adminClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Can still update user accounts', async () => {
		const firstConnection = new mockConnection(provider.connection);
		const secondConnection = new Connection('http://second-connection.com');
		const myMultiConn = new MultiConnection([
			firstConnection,
			secondConnection,
		]);
		const bulkAccountLoader = new BulkAccountLoader(
			myMultiConn,
			'confirmed',
			1000
		);
		// const config = initialize({ env: 'devnet' });

		const userKeypair = new Keypair();

		const clearingHouse = new ClearingHouse({
			connection: firstConnection,
			wallet: new Wallet(userKeypair),
			programID: adminClearingHouse.program.programId,
			env: 'devnet',
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await clearingHouse.subscribe();

		provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await clearingHouse.subscribe();
		await clearingHouse.getUser().subscribe();

		await new Promise((resolve) => setTimeout(resolve, 1000));

		console.log('Open orders:');
		printOpenOrders(clearingHouse.getUserAccount());

		// place an order
		const orderParams = getMarketOrderParams({
			marketIndex: new BN(0),
			direction: PositionDirection.LONG,
			baseAssetAmount: clearingHouse.getMarketAccount(new BN(0)).amm
				.baseAssetAmountStepSize,
		});
		console.log('Placing order with params:');
		console.log(`  mkt index: ${orderParams.marketIndex}`);
		console.log(`  direction: ${Object.keys(orderParams.direction)[0]}`);
		console.log(
			`  baseAmount: ${convertToNumber(
				orderParams.baseAssetAmount,
				BASE_PRECISION
			)}`
		);
		const txSig = await clearingHouse.placeOrder(orderParams);
		console.log(txSig);

		await clearingHouse.fetchAccounts();
		await clearingHouse.getUser().fetchAccounts();

		console.log('Open orders:');
		printOpenOrders(clearingHouse.getUserAccount());
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// check the fetching works
		let foundOpenOrder = false;
		for (const o of clearingHouse.getUserAccount().orders) {
			if (isVariant(o.status, 'init')) {
				continue;
			}
			if (!o.marketIndex.eq(orderParams.marketIndex)) {
				continue;
			}
			if (!o.direction === orderParams.direction) {
				continue;
			}
			if (!o.baseAssetAmount.eq(orderParams.baseAssetAmount)) {
				continue;
			}
			foundOpenOrder = true;
			break;
		}
		assert(foundOpenOrder, 'Open order not found');

		assert(
			myMultiConn.rpcEndpoint === firstConnection.rpcEndpoint,
			'First connection not in use'
		);
		assert(firstConnection.callCount > 0, 'No calls made on first connection');

		await new Promise((resolve) => setTimeout(resolve, 1000));

		await clearingHouse.unsubscribe();
		await clearingHouse.getUser().unsubscribe();

		return;
	});

	it('Can switch over RPC on timeout', async () => {
		const firstConnection = new mockConnection(provider.connection);
		const secondConnection = new Connection('http://second-connection.com');
		const myMultiConn = new MultiConnection([
			firstConnection,
			secondConnection,
		]);
		const bulkAccountLoader = new BulkAccountLoader(
			myMultiConn,
			'confirmed',
			1000
		);
		// const config = initialize({ env: 'devnet' });

		const userKeypair = new Keypair();

		const clearingHouse = new ClearingHouse({
			connection: firstConnection,
			wallet: new Wallet(userKeypair),
			programID: adminClearingHouse.program.programId,
			env: 'devnet',
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await clearingHouse.subscribe();

		provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await clearingHouse.subscribe();
		await clearingHouse.getUser().subscribe();

		await new Promise((resolve) => setTimeout(resolve, 3000));

		assert(
			myMultiConn.rpcEndpoint === firstConnection.rpcEndpoint,
			'Multi endpoint not using first connection'
		);
		assert(firstConnection.callCount > 0, 'No calls made on first connection');

		// cause rpcendpoint to fail
		firstConnection.disable();
		await new Promise((resolve) => setTimeout(resolve, 1000));

		assert(
			myMultiConn.rpcEndpoint === secondConnection.rpcEndpoint,
			'Multi endpoint not using second connection'
		);

		await clearingHouse.unsubscribe();
		await clearingHouse.getUser().unsubscribe();

		return;
	});
});
