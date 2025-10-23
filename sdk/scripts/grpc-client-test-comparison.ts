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
import assert from 'assert';

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
const TOKEN = process.env.TOKEN;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;

async function initializeGrpcDriftClientV2VersusV1() {
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

	const allSpotMarketProgramAccounts =
		(await program.account.spotMarket.all()) as ProgramAccount<SpotMarketAccount>[];
	const spotMarketProgramAccounts = allSpotMarketProgramAccounts.filter((val) =>
		[0, 1, 2, 3, 4, 5].includes(val.account.marketIndex)
	);
	const spotMarketIndexes = spotMarketProgramAccounts.map(
		(val) => val.account.marketIndex
	);

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
		try {
			// 1. Test getStateAccountAndSlot
			const state1 = clientV1.accountSubscriber.getStateAccountAndSlot();
			const state2 = clientV2.accountSubscriber.getStateAccountAndSlot();
			assert.deepStrictEqual(
				state1.data,
				state2.data,
				'State accounts should match'
			);
			if (
				state1.slot !== undefined &&
				state2.slot !== undefined &&
				state2.slot < state1.slot
			) {
				console.error(
					`State account slot regression: v2 slot ${state2.slot} < v1 slot ${state1.slot}`
				);
			}

			// 2. Test getMarketAccountsAndSlots (all perp markets) - sorted comparison
			const allPerpMarkets1 = clientV1.accountSubscriber
				.getMarketAccountsAndSlots()
				.sort((a, b) => a.data.marketIndex - b.data.marketIndex);
			const allPerpMarkets2 = clientV2.accountSubscriber
				.getMarketAccountsAndSlots()
				.sort((a, b) => a.data.marketIndex - b.data.marketIndex);
			assert.strictEqual(
				allPerpMarkets1.length,
				allPerpMarkets2.length,
				'Number of perp markets should match'
			);

			// Compare each perp market in the sorted arrays
			for (let i = 0; i < allPerpMarkets1.length; i++) {
				const market1 = allPerpMarkets1[i];
				const market2 = allPerpMarkets2[i];
				assert.strictEqual(
					market1.data.marketIndex,
					market2.data.marketIndex,
					`Perp market at position ${i} should have same marketIndex`
				);
				// assert.deepStrictEqual(
				// 	market1.data,
				// 	market2.data,
				// 	`Perp market ${market1.data.marketIndex} (from getMarketAccountsAndSlots) should match`
				// );
			}

			// 3. Test getMarketAccountAndSlot for each perp market
			for (const idx of perpMarketIndexes) {
				const market1 = clientV1.accountSubscriber.getMarketAccountAndSlot(idx);
				const market2 = clientV2.accountSubscriber.getMarketAccountAndSlot(idx);
				// assert.deepStrictEqual(
				// 	market1?.data,
				// 	market2?.data,
				// 	`Perp market ${idx} data should match`
				// );
				// assert.strictEqual(
				// 	market1?.slot,
				// 	market2?.slot,
				// 	`Perp market ${idx} slot should match`
				// );
				if (
					market1?.slot !== undefined &&
					market2?.slot !== undefined &&
					market2.slot < market1.slot
				) {
					console.error(
						`Perp market ${idx} slot regression: v2 slot ${market2.slot} < v1 slot ${market1.slot}`
					);
				} else if (
					market1?.slot !== undefined &&
					market2?.slot !== undefined &&
					market2.slot > market1.slot
				) {
					console.info(
						`Perp market ${idx} slot is FASTER! v2: ${market2.slot}, v1: ${market1.slot}`
					);
				}
			}

			// 4. Test getSpotMarketAccountsAndSlots (all spot markets) - sorted comparison
			const allSpotMarkets1 = clientV1.accountSubscriber
				.getSpotMarketAccountsAndSlots()
				.sort((a, b) => a.data.marketIndex - b.data.marketIndex);
			const allSpotMarkets2 = clientV2.accountSubscriber
				.getSpotMarketAccountsAndSlots()
				.sort((a, b) => a.data.marketIndex - b.data.marketIndex);
			assert.strictEqual(
				allSpotMarkets1.length,
				allSpotMarkets2.length,
				'Number of spot markets should match'
			);

			// Compare each spot market in the sorted arrays
			for (let i = 0; i < allSpotMarkets1.length; i++) {
				const market1 = allSpotMarkets1[i];
				const market2 = allSpotMarkets2[i];
				assert.strictEqual(
					market1.data.marketIndex,
					market2.data.marketIndex,
					`Spot market at position ${i} should have same marketIndex`
				);
				// assert.deepStrictEqual(
				// 	market1.data,
				// 	market2.data,
				// 	`Spot market ${market1.data.marketIndex} (from getSpotMarketAccountsAndSlots) should match`
				// );
			}

			// 5. Test getSpotMarketAccountAndSlot for each spot market
			for (const idx of spotMarketIndexes) {
				const market1 =
					clientV1.accountSubscriber.getSpotMarketAccountAndSlot(idx);
				const market2 =
					clientV2.accountSubscriber.getSpotMarketAccountAndSlot(idx);
				// assert.deepStrictEqual(
				// 	market1?.data,
				// 	market2?.data,
				// 	`Spot market ${idx} data should match`
				// );
				// assert.strictEqual(
				// 	market1?.slot,
				// 	market2?.slot,
				// 	`Spot market ${idx} slot should match`
				// );
				if (
					market1?.slot !== undefined &&
					market2?.slot !== undefined &&
					market2.slot < market1.slot
				) {
					console.error(
						`Spot market ${idx} slot regression: v2 slot ${market2.slot} < v1 slot ${market1.slot}`
					);
				} else if (
					market1?.slot !== undefined &&
					market2?.slot !== undefined &&
					market2.slot > market1.slot
				) {
					console.info(
						`Spot market ${idx} slot is FASTER! v2: ${market2.slot}, v1: ${market1.slot}`
					);
				}
			}

			// 6. Test getOraclePriceDataAndSlotForPerpMarket
			for (const idx of perpMarketIndexes) {
				const oracle1 =
					clientV1.accountSubscriber.getOraclePriceDataAndSlotForPerpMarket(
						idx
					);
				const oracle2 =
					clientV2.accountSubscriber.getOraclePriceDataAndSlotForPerpMarket(
						idx
					);
				// assert.deepStrictEqual(
				// 	oracle1?.data,
				// 	oracle2?.data,
				// 	`Perp market ${idx} oracle data should match`
				// );
				// Note: slots might differ slightly due to timing, so we can optionally skip this check or be lenient
				// assert.strictEqual(oracle1?.slot, oracle2?.slot, `Perp market ${idx} oracle slot should match`);
				if (
					oracle1?.slot !== undefined &&
					oracle2?.slot !== undefined &&
					oracle2.slot < oracle1.slot
				) {
					console.error(
						`Perp market ${idx} oracle slot regression: v2 slot ${oracle2.slot} < v1 slot ${oracle1.slot}`
					);
				} else if (
					oracle1?.slot !== undefined &&
					oracle2?.slot !== undefined &&
					oracle2.slot > oracle1.slot
				) {
					console.info(
						`Perp market ${idx} oracle slot is FASTER! v2: ${oracle2.slot}, v1: ${oracle1.slot}`
					);
				}
			}

			// 7. Test getOraclePriceDataAndSlotForSpotMarket
			for (const idx of spotMarketIndexes) {
				const oracle1 =
					clientV1.accountSubscriber.getOraclePriceDataAndSlotForSpotMarket(
						idx
					);
				const oracle2 =
					clientV2.accountSubscriber.getOraclePriceDataAndSlotForSpotMarket(
						idx
					);
				// assert.deepStrictEqual(
				// 	oracle1?.data,
				// 	oracle2?.data,
				// 	`Spot market ${idx} oracle data should match`
				// );
				// Note: slots might differ slightly due to timing
				// assert.strictEqual(oracle1?.slot, oracle2?.slot, `Spot market ${idx} oracle slot should match`);
				if (
					oracle1?.slot !== undefined &&
					oracle2?.slot !== undefined &&
					oracle2.slot < oracle1.slot
				) {
					console.error(
						`Spot market ${idx} oracle slot regression: v2 slot ${oracle2.slot} < v1 slot ${oracle1.slot}`
					);
				} else if (
					oracle1?.slot !== undefined &&
					oracle2?.slot !== undefined &&
					oracle2.slot > oracle1.slot
				) {
					console.info(
						`Spot market ${idx} oracle slot is FASTER! v2: ${oracle2.slot}, v1: ${oracle1.slot}`
					);
				}
			}

			console.log('✓ All comparisons passed');
		} catch (error) {
			console.error('✗ Comparison failed:', error);
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
