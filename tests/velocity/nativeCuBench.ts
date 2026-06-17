import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert } from 'chai';
import { startAnchor } from 'solana-bankrun';
import { BN, loadKeypair, TestClient, Wallet } from '../../packages/sdk/src';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { VelocityCore } from '../../packages/sdk/src/core/VelocityCore';
import { findComputeUnitConsumption } from '../../packages/sdk/src/util/computeUnits';

type ComputeUnitMeasurement = {
	cu: number;
};

type BenchmarkResult = {
	instruction: string;
	path: string;
	measurement: ComputeUnitMeasurement;
};

function assertOptionalMax(
	label: string,
	measurement: ComputeUnitMeasurement,
	envName: string
): void {
	const rawLimit = process.env[envName];
	if (rawLimit === undefined) {
		return;
	}

	const limit = Number(rawLimit);
	assert(
		measurement.cu <= limit,
		`${label} CU ${measurement.cu} exceeded ${envName}=${limit}`
	);
}

function pad(value: string | number, width: number): string {
	return String(value).padEnd(width, ' ');
}

function printComputeUnitTable(
	title: string,
	results: BenchmarkResult[]
): void {
	const columns = [
		['instruction', 35],
		['path', 27],
		['cu', 9],
	] as const;

	const renderRow = (values: Array<string | number>): string =>
		values.map((value, index) => pad(value, columns[index][1])).join(' ');

	const width =
		columns.reduce((sum, [, columnWidth]) => sum + columnWidth, 0) +
		columns.length -
		1;

	console.log('');
	console.log(title);
	console.log('-'.repeat(width));
	console.log(renderRow(columns.map(([label]) => label)));
	console.log('-'.repeat(width));

	for (const result of results) {
		console.log(
			renderRow([result.instruction, result.path, result.measurement.cu])
		);
	}
	console.log('-'.repeat(width));
	console.log('');
}

describe('compute units', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bankrunContextWrapper: BankrunContextWrapper;
	let velocityClient: TestClient;
	let originalConsoleLog: typeof console.log;

	let acceptedMmOraclePrice = new BN(100_000_000);
	let acceptedMmOracleSequenceId = new BN(1_000_000);
	let ammSpreadAdjustment = 0;

	before(async () => {
		originalConsoleLog = console.log;
		console.log = (...args: Parameters<typeof console.log>) => {
			if (String(args[0]).startsWith('Pausing to find oracle ')) {
				return;
			}
			originalConsoleLog(...args);
		};

		const context = await startAnchor('', [], []);
		bankrunContextWrapper = new BankrunContextWrapper(context as any);
		const defaultIdl = VelocityCore.defaultIdl();
		(VelocityCore as any).defaultIdl = () => ({
			...defaultIdl,
			address: chProgram.programId.toString(),
		});

		const bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			0
		);

		const usdcMint = await mockUSDCMint(bankrunContextWrapper);
		const wallet = new Wallet(loadKeypair(process.env.ANCHOR_WALLET));
		await bankrunContextWrapper.fundKeypair(wallet, 10 ** 9);

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await mockUserUSDCAccount(
			usdcMint,
			new BN(10 * 10 ** 6),
			bankrunContextWrapper,
			velocityClient.wallet.publicKey
		);

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccount(0);
		await velocityClient.fetchAccounts();
		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));
		await velocityClient.fetchAccounts();

		const solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);
		await velocityClient.initializePerpMarket(
			0,
			solUsd,
			new BN(1000),
			new BN(1000),
			new BN(60 * 60)
		);
		await velocityClient.initializeAmmCache();
		await velocityClient.updateFeatureBitFlagsMMOracle(true);

		await velocityClient.updateMmOracleNative(
			0,
			acceptedMmOraclePrice,
			acceptedMmOracleSequenceId
		);
	});

	after(async () => {
		if (velocityClient?.isSubscribed) {
			await velocityClient.unsubscribe();
		}
		if (originalConsoleLog) {
			console.log = originalConsoleLog;
		}
	});

	async function advancePastMmOracleRateLimit(): Promise<void> {
		await bankrunContextWrapper.connection.updateSlotAndClock();
	}

	async function getNativeInstructionComputeUnits(
		txSig: string
	): Promise<number> {
		const computeUnits = await findComputeUnitConsumption(
			chProgram.programId,
			bankrunContextWrapper.connection.toConnection(),
			txSig
		);
		assert.strictEqual(
			computeUnits.length,
			1,
			`expected one Velocity CU log, got ${computeUnits.length}`
		);
		return Number(computeUnits[0]);
	}

	async function sendAcceptedMmOracleUpdate(): Promise<string> {
		await advancePastMmOracleRateLimit();
		const nextPrice = acceptedMmOraclePrice.addn(1);
		const nextSequenceId = acceptedMmOracleSequenceId.addn(1);
		const txSig = await velocityClient.updateMmOracleNative(
			0,
			nextPrice,
			nextSequenceId
		);
		acceptedMmOraclePrice = nextPrice;
		acceptedMmOracleSequenceId = nextSequenceId;
		return txSig;
	}

	async function runBench(
		instruction: string,
		path: string,
		fn: () => Promise<number>
	): Promise<BenchmarkResult> {
		return {
			instruction,
			path,
			measurement: { cu: await fn() },
		};
	}

	it('native admin fast paths', async () => {
		const mmSuccess = await runBench(
			'update_mm_oracle_native',
			'success write',
			async () => {
				const txSig = await sendAcceptedMmOracleUpdate();
				return await getNativeInstructionComputeUnits(txSig);
			}
		);

		const mmStaleSequence = await runBench(
			'update_mm_oracle_native',
			'stale sequence noop',
			async () => {
				const txSig = await velocityClient.updateMmOracleNative(
					0,
					acceptedMmOraclePrice.addn(1),
					acceptedMmOracleSequenceId
				);
				return await getNativeInstructionComputeUnits(txSig);
			}
		);

		const mmMinSlotGap = await runBench(
			'update_mm_oracle_native',
			'min slot gap noop',
			async () => {
				await sendAcceptedMmOracleUpdate();
				const txSig = await velocityClient.updateMmOracleNative(
					0,
					acceptedMmOraclePrice.addn(1),
					acceptedMmOracleSequenceId.addn(1)
				);
				return await getNativeInstructionComputeUnits(txSig);
			}
		);

		const mmStepCap = await runBench(
			'update_mm_oracle_native',
			'step cap noop',
			async () => {
				await advancePastMmOracleRateLimit();
				const txSig = await velocityClient.updateMmOracleNative(
					0,
					acceptedMmOraclePrice.muln(105).divn(100),
					acceptedMmOracleSequenceId.addn(1)
				);
				return await getNativeInstructionComputeUnits(txSig);
			}
		);

		const ammSpread = await runBench(
			'update_amm_spread_adjustment_native',
			'success write',
			async () => {
				ammSpreadAdjustment = (ammSpreadAdjustment + 1) % 100;
				const txSig = await velocityClient.updateAmmSpreadAdjustmentNative(
					0,
					ammSpreadAdjustment
				);
				return await getNativeInstructionComputeUnits(txSig);
			}
		);

		printComputeUnitTable('Fast paths', [
			mmSuccess,
			mmStaleSequence,
			mmMinSlotGap,
			mmStepCap,
			ammSpread,
		]);

		assertOptionalMax(
			'mm_oracle_success',
			mmSuccess.measurement,
			'NATIVE_CU_MAX_MM_SUCCESS'
		);
		assertOptionalMax(
			'mm_oracle_stale_sequence_noop',
			mmStaleSequence.measurement,
			'NATIVE_CU_MAX_MM_STALE_SEQUENCE'
		);
		assertOptionalMax(
			'mm_oracle_min_slot_gap_noop',
			mmMinSlotGap.measurement,
			'NATIVE_CU_MAX_MM_MIN_SLOT_GAP'
		);
		assertOptionalMax(
			'mm_oracle_step_cap_noop',
			mmStepCap.measurement,
			'NATIVE_CU_MAX_MM_STEP_CAP'
		);
		assertOptionalMax(
			'amm_spread_adjustment_success',
			ammSpread.measurement,
			'NATIVE_CU_MAX_AMM_SPREAD'
		);
	});
});
