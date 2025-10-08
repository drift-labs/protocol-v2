import { DriftClient } from '../src/driftClient';
import { grpcDriftClientAccountSubscriberV2 } from '../src/accounts/grpcDriftClientAccountSubscriberV2';
import { grpcDriftClientAccountSubscriber } from '../src/accounts/grpcDriftClientAccountSubscriber';
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

async function initializeGrpcDriftClientV2VersusV1() {
	const connection = new Connection('');
	const wallet = new Wallet(new Keypair());
	dotenv.config({ path: '../' });

	const programId = new PublicKey(DRIFT_PROGRAM_ID);
	const provider = new AnchorProvider(
		connection,
		// @ts-ignore
		wallet,
		{
			commitment: 'confirmed',
		}
	);

	const program = new Program(driftIDL as Idl, programId, provider);

	const perpMarketIndexes = [4];
	const spotMarketIndexes = [32];

	const perpMarketProgramAccounts = (
		await program.account.perpMarket.all()
	).filter((a) =>
		perpMarketIndexes.includes(a.account.marketIndex as number)
	) as ProgramAccount<PerpMarketAccount>[];
	const spotMarketProgramAccounts = (
		await program.account.spotMarket.all()
	).filter((a) =>
		spotMarketIndexes.includes(a.account.marketIndex as number)
	) as ProgramAccount<SpotMarketAccount>[];

	// const perpMarketIndexes = perpMarketProgramAccounts.map(
	// 	(a) => a.account.marketIndex
	// );
	// const spotMarketIndexes = spotMarketProgramAccounts.map(
	// 	(a) => a.account.marketIndex
	// );
	// const oracleInfos = [
	// 	{
	// 		publicKey: new PublicKey('BERaNi6cpEresbq6HC1EQGaB1H1UjvEo4NGnmYSSJof4'),
	// 		source: OracleSource.PYTH_LAZER,
	// 	},
	// 	{
	// 		publicKey: new PublicKey('BERaNi6cpEresbq6HC1EQGaB1H1UjvEo4NGnmYSSJof4'),
	// 		source: OracleSource.PYTH_LAZER_1M,
	// 	},
	// ];

	const seen = new Set<string>();
	const oracleInfos: OracleInfo[] = [];
	for (const acct of perpMarketProgramAccounts) {
		const key = `${acct.account.amm.oracle.toBase58()}-${Object.keys(
			acct.account.amm.oracleSource ?? {}
		)?.[0]}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({
				publicKey: acct.account.amm.oracle,
				source: acct.account.amm.oracleSource,
			});
		}
	}
	for (const acct of spotMarketProgramAccounts) {
		const key = `${acct.account.oracle.toBase58()}-${Object.keys(
			acct.account.oracleSource ?? {}
		)?.[0]}`;
		if (!seen.has(key)) {
			seen.add(key);
			oracleInfos.push({
				publicKey: acct.account.oracle,
				source: acct.account.oracleSource,
			});
		}
	}

	const baseAccountSubscription = {
		type: 'grpc' as const,
		grpcConfigs: {
			endpoint: GRPC_ENDPOINT,
			token: TOKEN,
			commitmentLevel: 'confirmed' as unknown as CommitmentLevel,
			channelOptions: {
				'grpc.keepalive_time_ms': 10_000,
				'grpc.keepalive_timeout_ms': 1_000,
				'grpc.keepalive_permit_without_calls': 1,
			},
		},
	};

	const configV2: DriftClientConfig = {
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

	const configV1: DriftClientConfig = {
		connection,
		wallet,
		programID: new PublicKey(DRIFT_PROGRAM_ID),
		accountSubscription: {
			...baseAccountSubscription,
			driftClientAccountSubscriber: grpcDriftClientAccountSubscriber,
		},
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
	};

	const clientV2 = new DriftClient(configV2);
	const clientV1 = new DriftClient(configV1);

	await Promise.all([clientV1.subscribe(), clientV2.subscribe()]);
	const compare = () => {
		for (const idx of perpMarketIndexes) {
			const p1 = clientV1.getOracleDataForPerpMarket(idx).price;
			const p2 = clientV2.getOracleDataForPerpMarket(idx).price;
			console.log(
				`perp mkt ${idx} | v1 ${p1.toString()} | v2 ${p2.toString()}`
			);
		}
		for (const idx of spotMarketIndexes) {
			const s1 = clientV1.getOracleDataForSpotMarket(idx).price;
			const s2 = clientV2.getOracleDataForSpotMarket(idx).price;
			console.log(
				`spot mkt ${idx} | v1 ${s1.toString()} | v2 ${s2.toString()}`
			);
		}
	};

	compare();
	const interval = setInterval(compare, 1000);

	const cleanup = async () => {
		clearInterval(interval);
		await Promise.all([clientV1.unsubscribe(), clientV2.unsubscribe()]);
		process.exit(0);
	};

	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

initializeGrpcDriftClientV2VersusV1().catch(console.error);
