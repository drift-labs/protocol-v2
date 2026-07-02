/**
 * Mainnet spot (lending) market initialization runbook.
 *
 * Initializes/updates the lending markets from a params file
 * (deploy-scripts/params/relaunch-spot-markets.json). Two cases per market:
 *
 *   - market does not exist: initialize_spot_market with the full param set,
 *     then apply the post-init-only caps (max_token_deposits,
 *     max_token_borrows_fraction)
 *   - market exists (USDT spot 0, created by init-mainnet with placeholder
 *     lending params): sync every updatable group via update ixs
 *     (borrow rate curve, margin weights, withdraw guard, scale start,
 *     if factor, deposit/borrow caps). order_tick_size/order_step_size are
 *     init-only here and NOT synced on existing markets.
 *
 * Run AFTER init-mainnet.sh. Markets initialize in ascending market_index
 * (the program requires market_index == state.number_of_spot_markets).
 *
 * The params file ships with lending fields null; the script refuses to run
 * until they are filled. See _fields in the params file for what each one
 * means and its precision.
 *
 * Required env:
 *   ADMIN_KEYPAIR      path to admin keypair file (State.cold_admin)
 *   RPC_URL            private mainnet RPC
 *   PYTH_LAZER_TOKEN   auth token for the Pyth Lazer relay
 * Optional env:
 *   PROGRAM_ID            default: SDK mainnet config program id
 *   PARAMS_PATH           default deploy-scripts/params/relaunch-spot-markets.json
 *   RECEIPT_PATH          default deploy-scripts/out/relaunch-spot-markets.json
 *   PYTH_LAZER_ENDPOINTS  comma-separated WSS endpoints
 *   PYTH_LAZER_WAIT_MS    ms to wait for first price message (default 30000)
 *   NON_INTERACTIVE=1     skip confirmation prompts
 */

import { BN } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
  AdminClient,
  AssetTier,
  configs,
  getPythLazerOraclePublicKey,
  getSpotMarketPublicKey,
  getVelocityStateAccountPublicKey,
  loadKeypair,
  OracleSource,
  PythLazerSubscriber,
  Wallet,
} from '../packages/sdk/src';

type SpotMarketParams = {
	name: string;
	market_index: number;
	mint: string;
	decimals: number;
	oracle_source: string;
	lazer_feed_id: number | null;
	asset_tier: string;
	active_status: boolean;
	optimal_utilization: number | null;
	optimal_borrow_rate: number | null;
	max_borrow_rate: number | null;
	min_borrow_rate: number | null;
	initial_asset_weight: number | null;
	maintenance_asset_weight: number | null;
	initial_liability_weight: number | null;
	maintenance_liability_weight: number | null;
	imf_factor: number | null;
	liquidator_fee: number | null;
	if_liquidation_fee: number | null;
	scale_initial_asset_weight_start: string | null;
	withdraw_guard_threshold: string | null;
	order_tick_size: string | null;
	order_step_size: string | null;
	if_total_factor: number | null;
	max_token_deposits: string | null;
	max_token_borrows_fraction: number | null;
};

type ParamsFile = { markets: SpotMarketParams[] };

type Receipt = {
	cluster: string;
	programId: string;
	admin: string;
	paramsPath: string;
	spotMarkets: Record<
		number,
		{ name: string; pubkey: string; initTxSig?: string; syncTxSigs?: string[] }
	>;
	startedAt: string;
	finishedAt?: string;
};

const ORACLE_SOURCES: Record<string, (typeof OracleSource)[keyof typeof OracleSource]> = {
	PythLazer: OracleSource.PYTH_LAZER,
	PythLazerStableCoin: OracleSource.PYTH_LAZER_STABLE_COIN,
};
const ASSET_TIERS: Record<string, (typeof AssetTier)[keyof typeof AssetTier]> = {
	Collateral: AssetTier.COLLATERAL,
	Protected: AssetTier.PROTECTED,
	Cross: AssetTier.CROSS,
	Isolated: AssetTier.ISOLATED,
	Unlisted: AssetTier.UNLISTED,
};

// Lending params the risk team must fill before this script will run.
// min_borrow_rate stays nullable (null = program default).
const REQUIRED_AT_DEPLOY: Array<keyof SpotMarketParams> = [
	'optimal_utilization',
	'optimal_borrow_rate',
	'max_borrow_rate',
	'initial_asset_weight',
	'maintenance_asset_weight',
	'initial_liability_weight',
	'maintenance_liability_weight',
	'imf_factor',
	'liquidator_fee',
	'if_liquidation_fee',
	'scale_initial_asset_weight_start',
	'withdraw_guard_threshold',
	'order_tick_size',
	'order_step_size',
	'if_total_factor',
	'max_token_deposits',
	'max_token_borrows_fraction',
];

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`missing env ${name}`);
	return v;
}

function bn(v: string | number): BN {
	return new BN(String(v));
}

async function pdaExists(
	connection: Connection,
	pda: PublicKey
): Promise<boolean> {
	const info = await connection.getAccountInfo(pda, 'confirmed');
	return info !== null;
}

function logStep(title: string, note?: string) {
	const ts = new Date().toISOString();
	console.log(`\n[${ts}] ${title}${note ? `: ${note}` : ''}`);
}

const NON_INTERACTIVE =
	process.env.NON_INTERACTIVE === '1' || process.env.YES === '1';

async function confirm(prompt: string, details?: string[]): Promise<void> {
	if (details && details.length > 0) {
		console.log('');
		for (const line of details) console.log(`  ${line}`);
	}
	if (NON_INTERACTIVE) {
		console.log(`[non-interactive] ${prompt} (auto-yes)`);
		return;
	}
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const answer: string = await new Promise((resolve) => {
		rl.question(`\n${prompt} [y/N] `, (a) => resolve(a.trim().toLowerCase()));
	});
	rl.close();
	if (answer !== 'y' && answer !== 'yes') {
		console.log('aborted by user.');
		process.exit(1);
	}
}

async function fetchLazerMessageHex(
	endpoints: string[],
	token: string,
	feedIds: number[],
	waitMs: number
): Promise<string> {
	const subscriber = new PythLazerSubscriber(
		endpoints,
		token,
		[{ priceFeedIds: feedIds }],
		'mainnet-beta',
		2000,
		false,
		['price', 'bestAskPrice', 'bestBidPrice', 'exponent', 'feedUpdateTimestamp']
	);
	await subscriber.subscribe();
	const deadline = Date.now() + waitMs;
	let messageHex: string | undefined;
	while (Date.now() < deadline) {
		const messages = Array.from(subscriber.feedIdChunkToPriceMessage.values());
		if (messages.length > 0) {
			messageHex = messages[0];
			break;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	try {
		await subscriber.unsubscribe();
	} catch {
		/* ignore */
	}
	if (!messageHex) {
		throw new Error(
			`Timed out waiting ${waitMs}ms for a Pyth Lazer message for feeds [${feedIds.join(
				', '
			)}]`
		);
	}
	return messageHex;
}

function loadParams(paramsPath: string): ParamsFile {
	const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8')) as ParamsFile;
	if (!Array.isArray(params.markets) || params.markets.length === 0) {
		throw new Error(`${paramsPath}: no markets`);
	}
	const missing: string[] = [];
	for (const m of params.markets) {
		for (const field of REQUIRED_AT_DEPLOY) {
			if (m[field] === null || m[field] === undefined) {
				missing.push(`${m.name}.${field}`);
			}
		}
		if (!(m.oracle_source in ORACLE_SOURCES)) {
			throw new Error(
				`${m.name}: unmapped oracle_source "${m.oracle_source}", extend ORACLE_SOURCES`
			);
		}
		if (!(m.asset_tier in ASSET_TIERS)) {
			throw new Error(
				`${m.name}: unmapped asset_tier "${m.asset_tier}", extend ASSET_TIERS`
			);
		}
		if (m.lazer_feed_id === null) {
			missing.push(`${m.name}.lazer_feed_id`);
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`params file has unfilled placeholders:\n  ${missing.join(
				'\n  '
			)}\nFill them in ${paramsPath} before running (see _fields there for meaning/precision).`
		);
	}
	params.markets.sort((a, b) => a.market_index - b.market_index);
	return params;
}

async function main() {
	const rpcUrl = requireEnv('RPC_URL');
	const adminPath = requireEnv('ADMIN_KEYPAIR');
	const pythLazerToken = requireEnv('PYTH_LAZER_TOKEN');
	const pythLazerEndpoints = (
		process.env.PYTH_LAZER_ENDPOINTS ??
		'wss://pyth-lazer.dourolabs.app/v1/stream'
	)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const pythLazerWaitMs = Number(process.env.PYTH_LAZER_WAIT_MS ?? 30_000);
	const paramsPath = path.resolve(
		process.cwd(),
		process.env.PARAMS_PATH ?? 'deploy-scripts/params/relaunch-spot-markets.json'
	);
	const receiptPath = path.resolve(
		process.cwd(),
		process.env.RECEIPT_PATH ?? 'deploy-scripts/out/relaunch-spot-markets.json'
	);
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });

	const params = loadParams(paramsPath);
	const connection = new Connection(rpcUrl, 'confirmed');
	const keypair = loadKeypair(adminPath);
	const wallet = new Wallet(keypair);
	const programId = new PublicKey(
		process.env.PROGRAM_ID ?? configs['mainnet-beta'].VELOCITY_PROGRAM_ID
	);

	// Phase 0: pre-flight
	logStep('pre-flight checks');
	const programInfo = await connection.getAccountInfo(programId, 'confirmed');
	if (!programInfo || !programInfo.executable) {
		throw new Error(
			`velocity program ${programId.toBase58()} is not deployed/executable on ${rpcUrl}`
		);
	}
	const statePk = await getVelocityStateAccountPublicKey(programId);
	if (!(await pdaExists(connection, statePk))) {
		throw new Error(
			`State ${statePk.toBase58()} not initialized, run init-mainnet.sh first`
		);
	}
	const adminSol =
		(await connection.getBalance(keypair.publicKey, 'confirmed')) / 1e9;

	await confirm('Proceed with this MAINNET spot-market configuration?', [
		`cluster:   ${rpcUrl}`,
		`program:   ${programId.toBase58()} (executable ✓)`,
		`admin:     ${keypair.publicKey.toBase58()} (${adminSol.toFixed(4)} SOL)`,
		`params:    ${paramsPath}`,
		'',
		...params.markets.map(
			(m) =>
				`${m.name} idx=${m.market_index} tier=${m.asset_tier} mint=${m.mint} ` +
				`weights=${m.initial_asset_weight}/${m.maintenance_asset_weight}/` +
				`${m.initial_liability_weight}/${m.maintenance_liability_weight} ` +
				`curve=${m.optimal_utilization}/${m.optimal_borrow_rate}/${m.max_borrow_rate}`
		),
	]);

	const receipt: Receipt = {
		cluster: rpcUrl,
		programId: programId.toBase58(),
		admin: keypair.publicKey.toBase58(),
		paramsPath,
		spotMarkets: {},
		startedAt: new Date().toISOString(),
	};
	const writeReceipt = () =>
		fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

	const marketIndexes = params.markets.map((m) => m.market_index);
	const client = new AdminClient({
		connection,
		wallet,
		programID: programId,
		env: 'mainnet-beta',
		accountSubscription: { type: 'websocket', commitment: 'confirmed' },
		perpMarketIndexes: [],
		spotMarketIndexes: [],
		oracleInfos: [],
		skipLoadUsers: true,
	});
	await client.subscribe();

	// Phase 1: initialize missing markets (ascending index; the program
	// requires market_index == state.number_of_spot_markets at init)
	await confirm(`Begin Phase 1: initialize missing spot market(s)?`);
	const freshlyInitialized = new Set<number>();
	for (const m of params.markets) {
		const spotPk = await getSpotMarketPublicKey(programId, m.market_index);
		if (await pdaExists(connection, spotPk)) {
			logStep(`${m.name} (spot ${m.market_index}) already exists`, spotPk.toBase58());
			receipt.spotMarkets[m.market_index] = {
				name: m.name,
				pubkey: spotPk.toBase58(),
			};
			continue;
		}

		// non-quote spot init reads the oracle, so ensure the lazer PDA exists
		// and carries a price first
		const oraclePk = getPythLazerOraclePublicKey(
			programId,
			m.lazer_feed_id as number
		);
		if (!(await pdaExists(connection, oraclePk))) {
			logStep(`initializePythLazerOracle feed=${m.lazer_feed_id}`);
			await client.initializePythLazerOracle(m.lazer_feed_id as number);
		}
		const messageHex = await fetchLazerMessageHex(
			pythLazerEndpoints,
			pythLazerToken,
			[m.lazer_feed_id as number],
			pythLazerWaitMs
		);
		logStep(`postPythLazerOracleUpdate feed=${m.lazer_feed_id}`);
		await client.postPythLazerOracleUpdate(
			[m.lazer_feed_id as number],
			messageHex
		);

		logStep(`initializeSpotMarket ${m.name} @ index ${m.market_index}`);
		const txSig = await client.initializeSpotMarket(
			new PublicKey(m.mint),
			m.optimal_utilization as number,
			m.optimal_borrow_rate as number,
			m.max_borrow_rate as number,
			oraclePk,
			ORACLE_SOURCES[m.oracle_source],
			m.initial_asset_weight as number,
			m.maintenance_asset_weight as number,
			m.initial_liability_weight as number,
			m.maintenance_liability_weight as number,
			m.imf_factor as number,
			m.liquidator_fee as number,
			m.if_liquidation_fee as number,
			m.active_status,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			ASSET_TIERS[m.asset_tier] as any,
			bn(m.scale_initial_asset_weight_start as string),
			bn(m.withdraw_guard_threshold as string),
			bn(m.order_tick_size as string),
			bn(m.order_step_size as string),
			m.if_total_factor as number,
			m.name,
			m.market_index
		);
		freshlyInitialized.add(m.market_index);
		receipt.spotMarkets[m.market_index] = {
			name: m.name,
			pubkey: spotPk.toBase58(),
			initTxSig: txSig,
		};
		await client.fetchAccounts();
		writeReceipt();
	}

	// Phase 2: sync lending params. For fresh markets only the caps are
	// missing (init cannot set them). For pre-existing markets (USDT spot 0
	// carries init-mainnet placeholders) every updatable group is compared
	// against chain and pushed when it differs.
	await confirm('Begin Phase 2: sync lending params against chain?');
	await client.unsubscribe();
	const syncClient = new AdminClient({
		connection,
		wallet,
		programID: programId,
		env: 'mainnet-beta',
		accountSubscription: { type: 'websocket', commitment: 'confirmed' },
		perpMarketIndexes: [],
		spotMarketIndexes: marketIndexes,
		oracleInfos: [],
		skipLoadUsers: true,
	});
	await syncClient.subscribe();

	for (const m of params.markets) {
		const idx = m.market_index;
		const sm = syncClient.getSpotMarketAccount(idx);
		if (!sm) throw new Error(`spot market ${idx} not found after subscribe`);
		const sigs: string[] = [];
		const fresh = freshlyInitialized.has(idx);

		if (!fresh) {
			// borrow rate curve
			if (
				sm.optimalUtilization !== m.optimal_utilization ||
				sm.optimalBorrowRate !== m.optimal_borrow_rate ||
				sm.maxBorrowRate !== m.max_borrow_rate ||
				(m.min_borrow_rate !== null && sm.minBorrowRate !== m.min_borrow_rate)
			) {
				logStep(
					`updateSpotMarketBorrowRate ${m.name}`,
					`${sm.optimalUtilization}/${sm.optimalBorrowRate}/${sm.maxBorrowRate} -> ${m.optimal_utilization}/${m.optimal_borrow_rate}/${m.max_borrow_rate}`
				);
				sigs.push(
					await syncClient.updateSpotMarketBorrowRate(
						idx,
						m.optimal_utilization as number,
						m.optimal_borrow_rate as number,
						m.max_borrow_rate as number,
						m.min_borrow_rate ?? undefined
					)
				);
			}

			// margin weights
			if (
				sm.initialAssetWeight !== m.initial_asset_weight ||
				sm.maintenanceAssetWeight !== m.maintenance_asset_weight ||
				sm.initialLiabilityWeight !== m.initial_liability_weight ||
				sm.maintenanceLiabilityWeight !== m.maintenance_liability_weight ||
				sm.imfFactor !== m.imf_factor
			) {
				logStep(
					`updateSpotMarketMarginWeights ${m.name}`,
					`-> ${m.initial_asset_weight}/${m.maintenance_asset_weight}/${m.initial_liability_weight}/${m.maintenance_liability_weight} imf=${m.imf_factor}`
				);
				sigs.push(
					await syncClient.updateSpotMarketMarginWeights(
						idx,
						m.initial_asset_weight as number,
						m.maintenance_asset_weight as number,
						m.initial_liability_weight as number,
						m.maintenance_liability_weight as number,
						m.imf_factor as number
					)
				);
			}

			// withdraw guard threshold
			if (!sm.withdrawGuardThreshold.eq(bn(m.withdraw_guard_threshold as string))) {
				logStep(
					`updateWithdrawGuardThreshold ${m.name}`,
					`${sm.withdrawGuardThreshold.toString()} -> ${m.withdraw_guard_threshold}`
				);
				sigs.push(
					await syncClient.updateWithdrawGuardThreshold(
						idx,
						bn(m.withdraw_guard_threshold as string)
					)
				);
			}

			// scale start
			if (
				!sm.scaleInitialAssetWeightStart.eq(
					bn(m.scale_initial_asset_weight_start as string)
				)
			) {
				logStep(
					`updateSpotMarketScaleInitialAssetWeightStart ${m.name}`,
					`${sm.scaleInitialAssetWeightStart.toString()} -> ${m.scale_initial_asset_weight_start}`
				);
				sigs.push(
					await syncClient.updateSpotMarketScaleInitialAssetWeightStart(
						idx,
						bn(m.scale_initial_asset_weight_start as string)
					)
				);
			}
		}

		// deposit/borrow caps: init cannot set these, always sync
		if (!sm.maxTokenDeposits.eq(bn(m.max_token_deposits as string))) {
			logStep(
				`updateSpotMarketMaxTokenDeposits ${m.name}`,
				`${sm.maxTokenDeposits.toString()} -> ${m.max_token_deposits}`
			);
			sigs.push(
				await syncClient.updateSpotMarketMaxTokenDeposits(
					idx,
					bn(m.max_token_deposits as string)
				)
			);
		}
		if (sm.maxTokenBorrowsFraction !== m.max_token_borrows_fraction) {
			logStep(
				`updateSpotMarketMaxTokenBorrows ${m.name}`,
				`${sm.maxTokenBorrowsFraction} -> ${m.max_token_borrows_fraction}`
			);
			sigs.push(
				await syncClient.updateSpotMarketMaxTokenBorrows(
					idx,
					m.max_token_borrows_fraction as number
				)
			);
		}

		if (sigs.length === 0) {
			logStep(`${m.name}: lending params already in sync`);
		}
		receipt.spotMarkets[idx].syncTxSigs = sigs;
		writeReceipt();
	}

	receipt.finishedAt = new Date().toISOString();
	writeReceipt();
	console.log(`\nreceipt written: ${receiptPath}`);
	await syncClient.unsubscribe();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
