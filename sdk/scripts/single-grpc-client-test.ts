import { DriftClient } from '../src/driftClient';
import { grpcDriftClientAccountSubscriberV2 } from '../src/accounts/grpcDriftClientAccountSubscriberV2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DriftClientConfig } from '../src/driftClientConfig';
import {
	DRIFT_PROGRAM_ID,
	PerpMarketAccount,
	SpotMarketAccount,
	Wallet,
	OracleInfo,
} from '../src';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import dotenv from 'dotenv';
import {
	AnchorProvider,
	Idl,
	Program,
	ProgramAccount,
} from '@coral-xyz/anchor';
import driftIDL from '../src/idl/drift.json';

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
const TOKEN = process.env.TOKEN;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

async function initializeSingleGrpcClient() {
	console.log('🚀 Initializing single gRPC Drift Client...');

	const connection = new Connection(RPC_ENDPOINT);
	const wallet = new Wallet(new Keypair());
	dotenv.config({ path: '../' });

	const programId = new PublicKey(DRIFT_PROGRAM_ID);
	const provider = new AnchorProvider(
		connection,
		// @ts-ignore
		wallet,
		{
			commitment: 'processed',
		}
	);

	const program = new Program(driftIDL as Idl, programId, provider);

	// Get perp market accounts
	const allPerpMarketProgramAccounts =
		(await program.account.perpMarket.all()) as ProgramAccount<PerpMarketAccount>[];
	const perpMarketProgramAccounts = allPerpMarketProgramAccounts.filter((val) =>
		[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(
			val.account.marketIndex
		)
	);
	const perpMarketIndexes = perpMarketProgramAccounts.map(
		(val) => val.account.marketIndex
	);

	// Get spot market accounts
	const allSpotMarketProgramAccounts =
		(await program.account.spotMarket.all()) as ProgramAccount<SpotMarketAccount>[];
	const spotMarketProgramAccounts = allSpotMarketProgramAccounts.filter((val) =>
		[0, 1, 2, 3, 4, 5].includes(val.account.marketIndex)
	);
	const spotMarketIndexes = spotMarketProgramAccounts.map(
		(val) => val.account.marketIndex
	);

	// Get oracle infos
	const seen = new Set<string>();
	const oracleInfos: OracleInfo[] = [];
	for (const acct of perpMarketProgramAccounts) {
		const key = `${acct.account.amm.oracle.toBase58()}-${
			Object.keys(acct.account.amm.oracleSource)[0]
		}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({
				publicKey: acct.account.amm.oracle,
				source: acct.account.amm.oracleSource,
			});
		}
	}
	for (const acct of spotMarketProgramAccounts) {
		const key = `${acct.account.oracle.toBase58()}-${
			Object.keys(acct.account.oracleSource)[0]
		}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({
				publicKey: acct.account.oracle,
				source: acct.account.oracleSource,
			});
		}
	}

	console.log(`📊 Markets: ${perpMarketIndexes.length} perp, ${spotMarketIndexes.length} spot`);
	console.log(`🔮 Oracles: ${oracleInfos.length}`);

	const baseAccountSubscription = {
		type: 'grpc' as const,
		grpcConfigs: {
			endpoint: GRPC_ENDPOINT,
			token: TOKEN,
			commitmentLevel: CommitmentLevel.PROCESSED,
			channelOptions: {
				'grpc.keepalive_time_ms': 10_000,
				'grpc.keepalive_timeout_ms': 1_000,
				'grpc.keepalive_permit_without_calls': 1,
			},
		},
	};

	const config: DriftClientConfig = {
		connection,
		wallet,
		programID: new PublicKey(DRIFT_PROGRAM_ID),
		accountSubscription: {
			...baseAccountSubscription,
			driftClientAccountSubscriber: grpcDriftClientAccountSubscriberV2,
		},
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
	};

	const client = new DriftClient(config);

	// Set up event listeners
	const eventCounts = {
		stateAccountUpdate: 0,
		perpMarketAccountUpdate: 0,
		spotMarketAccountUpdate: 0,
		oraclePriceUpdate: 0,
		update: 0,
	};

	console.log('🎧 Setting up event listeners...');

	client.eventEmitter.on('stateAccountUpdate', (data) => {
		eventCounts.stateAccountUpdate++;
		console.log(`📊 State Account Update #${eventCounts.stateAccountUpdate}`);
	});

	client.eventEmitter.on('perpMarketAccountUpdate', (data) => {
		eventCounts.perpMarketAccountUpdate++;
		console.log(`📈 Perp Market Update #${eventCounts.perpMarketAccountUpdate} - Market ${data.marketIndex}`);
	});

	client.eventEmitter.on('spotMarketAccountUpdate', (data) => {
		eventCounts.spotMarketAccountUpdate++;
		console.log(`🏦 Spot Market Update #${eventCounts.spotMarketAccountUpdate} - Market ${data.marketIndex}`);
	});

	client.eventEmitter.on('oraclePriceUpdate', (publicKey, source, data) => {
		eventCounts.oraclePriceUpdate++;
		console.log(`🔮 Oracle Update #${eventCounts.oraclePriceUpdate} - ${publicKey.toBase58()} (${source})`);
	});

	client.accountSubscriber.eventEmitter.on('update', () => {
		eventCounts.update++;
		if (eventCounts.update % 10 === 0) {
			console.log(`🔄 General Update #${eventCounts.update}`);
		}
	});

	// Subscribe
	console.log('🔗 Subscribing to accounts...');
	await client.subscribe();

	console.log('✅ Client subscribed successfully!');
	console.log('📊 Starting to log updates...');

	// Log periodic stats
	const statsInterval = setInterval(() => {
		console.log('\n📈 Event Counts:', eventCounts);
		console.log(`⏱️  Client subscribed: ${client.isSubscribed}`);
		console.log(`🔗 Account subscriber subscribed: ${client.accountSubscriber.isSubscribed}`);
	}, 5000);

	// Cleanup function
	const cleanup = async () => {
		console.log('\n🛑 Cleaning up...');
		clearInterval(statsInterval);
		await client.unsubscribe();
		console.log('✅ Cleanup complete');
		process.exit(0);
	};

	// Handle shutdown signals
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);

	// Auto-exit after 5 minutes for testing
	setTimeout(async () => {
		console.log('\n⏰ Auto-exiting after 5 minutes...');
		await cleanup();
	}, 5 * 60 * 1000);

	return client;
}

initializeSingleGrpcClient().catch(console.error);
