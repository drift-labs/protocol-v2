import { VelocityClient } from '../src/velocityClient';
import { grpcVelocityClientAccountSubscriberV2 } from '../src/accounts/grpcVelocityClientAccountSubscriberV2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { VelocityClientConfig } from '../src/velocityClientConfig';
import {
	VELOCITY_PROGRAM_ID,
	PerpMarketAccount,
	SpotMarketAccount,
	Wallet,
	OracleInfo,
	decodeName,
} from '../src';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import dotenv from 'dotenv';
import {
	AnchorProvider,
	Idl,
	Program,
	ProgramAccount,
} from '@coral-xyz/anchor';
import velocityIDL from '../src/idl/velocity.json';
import { grpcMultiUserAccountSubscriber } from '../src/accounts/grpcMultiUserAccountSubscriber';

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
const TOKEN = process.env.TOKEN;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

async function initializeSingleGrpcClient() {
	console.log('🚀 Initializing single gRPC Velocity Client...');

	const connection = new Connection(RPC_ENDPOINT);
	const wallet = new Wallet(new Keypair());
	dotenv.config({ path: '../' });

	const programId = new PublicKey(VELOCITY_PROGRAM_ID);
	const provider = new AnchorProvider(
		connection,
		// @ts-ignore
		wallet,
		{
			commitment: 'processed',
		}
	);

	const program = new Program(velocityIDL as Idl, programId, provider);

	// Get perp market accounts
	const allPerpMarketProgramAccounts =
		(await program.account.perpMarket.all()) as ProgramAccount<PerpMarketAccount>[];
	const perpMarketProgramAccounts = allPerpMarketProgramAccounts.filter((val) =>
		[46].includes(val.account.marketIndex)
	);
	const perpMarketIndexes = perpMarketProgramAccounts.map(
		(val) => val.account.marketIndex
	);

	// Get spot market accounts
	const allSpotMarketProgramAccounts =
		(await program.account.spotMarket.all()) as ProgramAccount<SpotMarketAccount>[];
	const spotMarketProgramAccounts = allSpotMarketProgramAccounts.filter((val) =>
		[0].includes(val.account.marketIndex)
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

	console.log(
		`📊 Markets: ${perpMarketIndexes.length} perp, ${spotMarketIndexes.length} spot`
	);
	console.log(`🔮 Oracles: ${oracleInfos.length}`);

	const grpcConfigs = {
		endpoint: GRPC_ENDPOINT,
		token: TOKEN,
		commitmentLevel: CommitmentLevel.PROCESSED,
		channelOptions: {
			grpcKeepAliveTimeout: 1_000,
			grpcTcpKeepalive: 10_000,
		},
	};

	const multiUserSubsciber = new grpcMultiUserAccountSubscriber(
		program,
		grpcConfigs
	);

	const baseAccountSubscription = {
		type: 'grpc' as const,
		grpcConfigs,
		grpcMultiUserAccountSubscriber: multiUserSubsciber,
	};

	const config: VelocityClientConfig = {
		connection,
		wallet,
		programID: new PublicKey(VELOCITY_PROGRAM_ID),
		accountSubscription: {
			...baseAccountSubscription,
			velocityClientAccountSubscriber: grpcVelocityClientAccountSubscriberV2,
		},
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
	};

	const client = new VelocityClient(config);

	// Set up event listeners
	const eventCounts = {
		stateAccountUpdate: 0,
		perpMarketAccountUpdate: 0,
		spotMarketAccountUpdate: 0,
		oraclePriceUpdate: 0,
		update: 0,
	};

	console.log('🎧 Setting up event listeners...');

	client.eventEmitter.on('stateAccountUpdate', (_data) => {
		eventCounts.stateAccountUpdate++;
	});

	client.eventEmitter.on('perpMarketAccountUpdate', (_data) => {
		eventCounts.perpMarketAccountUpdate++;
	});

	client.eventEmitter.on('spotMarketAccountUpdate', (_data) => {
		eventCounts.spotMarketAccountUpdate++;
	});

	client.eventEmitter.on('oraclePriceUpdate', (_publicKey, _source, _data) => {
		eventCounts.oraclePriceUpdate++;
	});

	client.accountSubscriber.eventEmitter.on('update', () => {
		eventCounts.update++;
	});

	// Subscribe
	console.log('🔗 Subscribing to accounts...');
	await client.subscribe();

	console.log('✅ Client subscribed successfully!');
	console.log(
		'🚀 Starting high-load testing (50 reads/sec per perp market)...'
	);

	// High-frequency load testing - 50 reads per second per perp market
	const loadTestInterval = setInterval(async () => {
		try {
			// Test getPerpMarketAccount for each perp market (50 times per second per market)
			for (const marketIndex of perpMarketIndexes) {
				const perpMarketAccount = client.getPerpMarketAccount(marketIndex);
				if (!perpMarketAccount) {
					console.log(`Perp market ${marketIndex} not found`);
					continue;
				}
				console.log(
					'perpMarketAccount name: ',
					decodeName(perpMarketAccount.name)
				);
				console.log(
					'perpMarketAccount data: ',
					JSON.stringify({
						marketIndex: perpMarketAccount.marketIndex,
						name: decodeName(perpMarketAccount.name),
						baseAssetReserve: perpMarketAccount.amm.baseAssetReserve.toString(),
						quoteAssetReserve:
							perpMarketAccount.amm.quoteAssetReserve.toString(),
					})
				);
			}

			// Test getMMOracleDataForPerpMarket for each perp market (50 times per second per market)
			for (const marketIndex of perpMarketIndexes) {
				try {
					const oracleData = client.getMMOracleDataForPerpMarket(marketIndex);
					console.log('oracleData price: ', oracleData.price.toString());
					console.log(
						'oracleData: ',
						JSON.stringify({
							price: oracleData.price.toString(),
							confidence: oracleData.confidence?.toString(),
							slot: oracleData.slot?.toString(),
						})
					);
				} catch (error) {
					// Ignore errors for load testing
				}
			}

			for (const marketIndex of perpMarketIndexes) {
				try {
					const { data, slot } =
						client.accountSubscriber.getMarketAccountAndSlot(marketIndex);
					if (!data) {
						console.log(
							`Perp market getMarketAccountAndSlot ${marketIndex} not found`
						);
						continue;
					}
					console.log(
						'marketAccountAndSlot: ',
						JSON.stringify({
							marketIndex: data.marketIndex,
							name: decodeName(data.name),
							slot: slot?.toString(),
							baseAssetReserve: data.amm.baseAssetReserve.toString(),
							quoteAssetReserve: data.amm.quoteAssetReserve.toString(),
						})
					);
				} catch (error) {
					console.error(
						`Error getting market account and slot for market ${marketIndex}:`,
						error
					);
				}
			}
		} catch (error) {
			console.error('Load test error:', error);
		}
	}, 20); // 50 times per second = 1000ms / 50 = 20ms interval

	// Log periodic stats
	const statsInterval = setInterval(() => {
		console.log('\n📈 Event Counts:', eventCounts);
		console.log(`⏱️  Client subscribed: ${client.isSubscribed}`);
		console.log(
			`🔗 Account subscriber subscribed: ${client.accountSubscriber.isSubscribed}`
		);
		console.log(
			`🔥 Load: ${perpMarketIndexes.length * 50 * 2} reads/sec (${
				perpMarketIndexes.length
			} markets × 50 getPerpMarketAccount + 50 getMMOracleDataForPerpMarket)`
		);
	}, 5000);

	// Handle shutdown signals - just exit without cleanup since they never unsubscribe
	process.on('SIGINT', () => {
		console.log('\n🛑 Shutting down...');
		clearInterval(loadTestInterval);
		clearInterval(statsInterval);
		process.exit(0);
	});

	process.on('SIGTERM', () => {
		console.log('\n🛑 Shutting down...');
		clearInterval(loadTestInterval);
		clearInterval(statsInterval);
		process.exit(0);
	});

	return client;
}

initializeSingleGrpcClient().catch(console.error);
