import { DriftClient } from '../src/driftClient';
import { grpcDriftClientAccountSubscriberV2 } from '../src/accounts/grpcDriftClientAccountSubscriberV2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DriftClientConfig } from '../src/driftClientConfig';
import {
	decodeName,
	DRIFT_PROGRAM_ID,
	PerpMarketAccount,
	Wallet,
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

async function initializeGrpcDriftClientV2() {
	const connection = new Connection('https://api.mainnet-beta.solana.com');
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

	const perpMarketProgramAccounts =
		(await program.account.perpMarket.all()) as ProgramAccount<PerpMarketAccount>[];
	const solPerpMarket = perpMarketProgramAccounts.find(
		(account) => account.account.marketIndex === 0
	);
	const solOracleInfo = {
		publicKey: solPerpMarket.account.amm.oracle,
		source: solPerpMarket.account.amm.oracleSource,
	};
	const ethPerpMarket = perpMarketProgramAccounts.find(
		(account) => account.account.marketIndex === 2
	);
	const ethOracleInfo = {
		publicKey: ethPerpMarket.account.amm.oracle,
		source: ethPerpMarket.account.amm.oracleSource,
	};
	const btcPerpMarket = perpMarketProgramAccounts.find(
		(account) => account.account.marketIndex === 1
	);
	const btcOracleInfo = {
		publicKey: btcPerpMarket.account.amm.oracle,
		source: btcPerpMarket.account.amm.oracleSource,
	};

	const config: DriftClientConfig = {
		connection,
		wallet,
		programID: new PublicKey(DRIFT_PROGRAM_ID),
		accountSubscription: {
			type: 'grpc',
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
			driftClientAccountSubscriber: grpcDriftClientAccountSubscriberV2,
		},
		perpMarketIndexes: [0, 1, 2],
		spotMarketIndexes: [0, 1, 2],
		oracleInfos: [solOracleInfo, ethOracleInfo, btcOracleInfo],
	};

	const driftClient = new DriftClient(config);

	let perpMarketUpdateCount = 0;
	let spotMarketUpdateCount = 0;
	let oraclePriceUpdateCount = 0;
	let userAccountUpdateCount = 0;

	const updatePromise = new Promise<void>((resolve) => {
		driftClient.accountSubscriber.eventEmitter.on(
			'perpMarketAccountUpdate',
			(data) => {
				console.log('Perp market account update:', decodeName(data.name));
				const perpMarketData = driftClient.getPerpMarketAccount(
					data.marketIndex
				);
				console.log(
					'Perp market data market index:',
					perpMarketData?.marketIndex
				);
				const oracle = driftClient.getOracleDataForPerpMarket(data.marketIndex);
				const mmOracle = driftClient.getMMOracleDataForPerpMarket(
					data.marketIndex
				);
				console.log('Perp oracle price:', oracle.price.toString());
				console.log('Perp MM oracle price:', mmOracle.price.toString());
				perpMarketUpdateCount++;
				if (
					perpMarketUpdateCount >= 10 &&
					spotMarketUpdateCount >= 10 &&
					oraclePriceUpdateCount >= 10 &&
					userAccountUpdateCount >= 2
				) {
					resolve();
				}
			}
		);

		driftClient.accountSubscriber.eventEmitter.on(
			'spotMarketAccountUpdate',
			(data) => {
				console.log('Spot market account update:', decodeName(data.name));
				const spotMarketData = driftClient.getSpotMarketAccount(
					data.marketIndex
				);
				console.log(
					'Spot market data market index:',
					spotMarketData?.marketIndex
				);
				const oracle = driftClient.getOracleDataForSpotMarket(data.marketIndex);
				console.log('Spot oracle price:', oracle.price.toString());
				spotMarketUpdateCount++;
				if (
					perpMarketUpdateCount >= 10 &&
					spotMarketUpdateCount >= 10 &&
					oraclePriceUpdateCount >= 10 &&
					userAccountUpdateCount >= 2
				) {
					resolve();
				}
			}
		);

		driftClient.accountSubscriber.eventEmitter.on(
			'oraclePriceUpdate',
			(data) => {
				console.log('Oracle price update:', data.toBase58());
				oraclePriceUpdateCount++;
				if (
					perpMarketUpdateCount >= 10 &&
					spotMarketUpdateCount >= 10 &&
					oraclePriceUpdateCount >= 10 &&
					userAccountUpdateCount >= 2
				) {
					resolve();
				}
			}
		);

		driftClient.accountSubscriber.eventEmitter.on(
			'userAccountUpdate',
			(data) => {
				console.log('User account update:', decodeName(data.name));
				userAccountUpdateCount++;
				if (
					perpMarketUpdateCount >= 10 &&
					spotMarketUpdateCount >= 10 &&
					oraclePriceUpdateCount >= 10 &&
					userAccountUpdateCount >= 2
				) {
					resolve();
				}
			}
		);
	});

	await driftClient.subscribe();
	console.log('DriftClient initialized and listening for updates.');

	for (const marketIndex of config.perpMarketIndexes) {
		const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);
		const mmOracle = driftClient.getMMOracleDataForPerpMarket(marketIndex);
		console.log('Initial perp oracle price:', oracle.price.toString());
		console.log('Initial perp MM oracle price:', mmOracle.price.toString());
	}

	for (const marketIndex of config.spotMarketIndexes) {
		const oracle = driftClient.getOracleDataForSpotMarket(marketIndex);
		console.log('Initial spot oracle price:', oracle.price.toString());
	}

	const stateAccount = driftClient.getStateAccount();
	console.log('Initial state account:', stateAccount.toString());

	await updatePromise;
	console.log('Received required number of updates.');
}

initializeGrpcDriftClientV2().catch(console.error);
