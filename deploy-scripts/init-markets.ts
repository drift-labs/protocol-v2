/**
 * Relaunch perp-market initialization runbook for the velocity program.
 *
 * Mainnet-only. Initializes N perp markets driven by a params file
 * (deploy-scripts/params/relaunch-perp-markets.json). Run AFTER the base
 * phases of init-mainnet.sh (state, AmmCache, quote spot market, hot roles).
 *
 * Markets with active_status=true require the signer to be State.cold_admin
 * (init handler asserts it), so use the same admin keypair init-mainnet ran
 * with.
 *
 * Phases (all idempotent: every phase checks on-chain state and skips):
 *
 *   0)  pre-flight: program, State, AmmCache, spot market 0 must exist
 *   1)  Pyth Lazer oracle PDA per unique feed id
 *   2)  post one signed Lazer price update covering every feed
 *   3)  initialize_perp_market per market, ascending market_index
 *   4)  per-market post-init:
 *        - repeg AMM to ~1% below live oracle (params peg is a dated reference;
 *          program blocks funding when mark diverges from oracle)
 *        - set max_open_interest from oi_cap_usd at the live oracle price
 *          (the init value was computed at a reference-price snapshot)
 *        - oracle_slot_delay_override / curve_update_intensity /
 *          amm_jit_intensity sync
 *   5)  global params from the params file `global` section (null = skip)
 *
 * Params-file contract:
 *   - All u64/u128 fields are strings (JSON numbers above 2^53 lose precision).
 *   - Fields listed in REQUIRED_AT_DEPLOY must be non-null per market; the
 *     script refuses to run otherwise (see the constant's comment).
 *
 * Required env:
 *   ADMIN_KEYPAIR      path to admin keypair file (State.cold_admin)
 *   RPC_URL            private mainnet RPC
 *   PYTH_LAZER_TOKEN   auth token for the Pyth Lazer relay
 * Optional env:
 *   PROGRAM_ID            default: SDK mainnet config program id
 *   PARAMS_PATH           default deploy-scripts/params/relaunch-perp-markets.json
 *   RECEIPT_PATH          default deploy-scripts/out/relaunch-markets.json
 *   PYTH_LAZER_ENDPOINTS  comma-separated WSS endpoints
 *   PYTH_LAZER_WAIT_MS    ms to wait for first price message (default 30000)
 *   NON_INTERACTIVE=1     skip confirmation prompts
 *   DRY_RUN=1 (or --dry-run)  no transactions sent; performs every read
 *                         (pre-flight, on-chain diffs, Lazer relay fetch) and
 *                         prints each ix as "[DRY RUN] would ...". Markets that
 *                         do not exist yet get their init logged and Phase 4
 *                         skipped for them (nothing on chain to diff). Receipt
 *                         untouched.
 */

import { BN } from '@coral-xyz/anchor';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
  AdminClient,
  BASE_PRECISION,
  configs,
  ContractTier,
  getAmmCachePublicKey,
  getPerpMarketPublicKey,
  getPythLazerOraclePublicKey,
  getSpotMarketPublicKey,
  getVelocityStateAccountPublicKey,
  loadKeypair,
  OracleSource,
  PRICE_PRECISION,
  PythLazerSubscriber,
  Wallet,
} from '../packages/sdk/src';

type MarketParams = {
	name: string;
	market_index: number;
	oracle_source: string;
	contract_tier: string;
	lazer_feed_id: number | null;
	// informational only: feed id for the keeper-bot mm-oracle crank config.
	// The mm oracle is posted by the native crank; no on-chain field at init.
	mm_oracle_feed_id: number | null;
	// USD cap intent; phase 4 derives max_open_interest from it at the live
	// oracle price. null = keep the init value as-is.
	oi_cap_usd: number | null;
	amm_base_asset_reserve: string;
	amm_quote_asset_reserve: string;
	amm_peg_multiplier: string;
	amm_periodicity: number;
	margin_ratio_initial: number;
	margin_ratio_maintenance: number;
	imf_factor: number;
	liquidator_fee: number;
	if_liquidation_fee: number;
	max_open_interest: string;
	quote_max_insurance: string;
	max_revenue_withdraw_per_period: string;
	base_spread: number;
	max_spread: number;
	order_step_size: string;
	concentration_coef_scale: string;
	order_tick_size: string | null;
	min_order_size: string | null;
	curve_update_intensity: number | null;
	amm_jit_intensity: number | null;
	oracle_slot_delay_override: number | null;
	active_status: boolean;
	lp_pool_id: number;
	funding_clamp_threshold: number;
	funding_ramp_slope: number;
};

type GlobalParams = {
	initial_pct_to_liquidate: number | null;
	liquidation_duration: number | null;
};

type ParamsFile = {
	global?: GlobalParams;
	markets: MarketParams[];
};

type Receipt = {
	cluster: string;
	programId: string;
	admin: string;
	paramsPath: string;
	pythLazerOracles: Record<number, { pubkey: string; txSig?: string }>;
	perpMarkets: Record<
		number,
		{
			name: string;
			pubkey: string;
			initTxSig?: string;
			repegTxSig?: string;
			maxOpenInterestTxSig?: string;
		}
	>;
	startedAt: string;
	finishedAt?: string;
};

// enum-string -> SDK variant maps. Extend when a market uses a new variant.
const ORACLE_SOURCES: Record<string, (typeof OracleSource)[keyof typeof OracleSource]> = {
	PythLazer: OracleSource.PYTH_LAZER,
};
const CONTRACT_TIERS: Record<string, (typeof ContractTier)[keyof typeof ContractTier]> = {
	A: ContractTier.A,
	B: ContractTier.B,
	C: ContractTier.C,
	Speculative: ContractTier.SPECULATIVE,
	HighlySpeculative: ContractTier.HIGHLY_SPECULATIVE,
	Isolated: ContractTier.ISOLATED,
};

// Init args that must be non-null in the params file. Guards new market
// entries: a null here would otherwise coerce silently (e.g. Math.min(null,
// 100) -> 0) and initialize a live market with wrong values.
const REQUIRED_AT_DEPLOY: Array<keyof MarketParams> = [
	'lazer_feed_id',
	'order_tick_size',
	'min_order_size',
	'curve_update_intensity',
	'amm_jit_intensity',
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

const DRY_RUN =
	process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

function dryStep(action: string, note?: string) {
	logStep(`[DRY RUN] would ${action}`, note);
}

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

// Subscribe to Pyth Lazer, wait for the first signed message for `feedIds`,
// and return its hex.
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
		// feedUpdateTimestamp is mandatory: the on-chain post silently skips
		// messages without it. bestBid/Ask feed the on-chain conf calculation.
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
	const raw = fs.readFileSync(paramsPath, 'utf8');
	const params = JSON.parse(raw) as ParamsFile;
	if (!Array.isArray(params.markets) || params.markets.length === 0) {
		throw new Error(`${paramsPath}: no markets`);
	}

	// Refuse placeholders. These are deliberate nulls in the risk params file;
	// filling them here with defaults would silently launch wrong markets.
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
		if (!(m.contract_tier in CONTRACT_TIERS)) {
			throw new Error(
				`${m.name}: unmapped contract_tier "${m.contract_tier}", extend CONTRACT_TIERS`
			);
		}
		if (m.amm_base_asset_reserve !== m.amm_quote_asset_reserve) {
			throw new Error(
				`${m.name}: base/quote reserves differ, program rejects (InvalidInitialPeg)`
			);
		}
		// (100, 200] is valid post-init (reference price offset intensity) but
		// init itself rejects > 100; Phase 3 clamps, Phase 4 raises.
		if ((m.curve_update_intensity as number) > 200) {
			throw new Error(
				`${m.name}: curve_update_intensity > 200, program rejects`
			);
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`params file has unfilled deploy placeholders:\n  ${missing.join(
				'\n  '
			)}\nFill them in ${paramsPath} before running.`
		);
	}

	// markets must be initialized in ascending index order; the program
	// requires market_index == state.number_of_markets at init.
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
		process.env.PARAMS_PATH ?? 'deploy-scripts/params/relaunch-perp-markets.json'
	);
	const receiptPath = path.resolve(
		process.cwd(),
		process.env.RECEIPT_PATH ?? 'deploy-scripts/out/relaunch-markets.json'
	);
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });

	const params = loadParams(paramsPath);
	const connection = new Connection(rpcUrl, 'confirmed');
	const keypair = loadKeypair(adminPath);
	const wallet = new Wallet(keypair);
	const programId = new PublicKey(
		process.env.PROGRAM_ID ?? configs['mainnet-beta'].VELOCITY_PROGRAM_ID
	);

	const feedIds = [
		...new Set(params.markets.map((m) => m.lazer_feed_id as number)),
	];

	// Phase 0: pre-flight
	logStep('pre-flight checks');
	const programInfo = await connection.getAccountInfo(programId, 'confirmed');
	if (!programInfo || !programInfo.executable) {
		throw new Error(
			`velocity program ${programId.toBase58()} is not deployed/executable on ${rpcUrl}`
		);
	}
	const statePk = await getVelocityStateAccountPublicKey(programId);
	const ammCachePk = getAmmCachePublicKey(programId);
	const spot0Pk = await getSpotMarketPublicKey(programId, 0);
	for (const [pk, label] of [
		[statePk, 'State'],
		[ammCachePk, 'AmmCache'],
		[spot0Pk, 'spot market 0 (quote)'],
	] as const) {
		if (!(await pdaExists(connection, pk))) {
			throw new Error(
				`${label} ${pk.toBase58()} not initialized, run init-mainnet.sh first`
			);
		}
	}
	const adminSol =
		(await connection.getBalance(keypair.publicKey, 'confirmed')) / 1e9;

	await confirm('Proceed with this MAINNET configuration?', [
		...(DRY_RUN ? ['*** DRY RUN: no transactions will be sent ***', ''] : []),
		`cluster:   ${rpcUrl}`,
		`program:   ${programId.toBase58()} (executable ✓)`,
		`admin:     ${keypair.publicKey.toBase58()} (${adminSol.toFixed(4)} SOL)`,
		`params:    ${paramsPath}`,
		`receipt:   ${receiptPath}`,
		`feeds:     [${feedIds.join(', ')}]`,
		'',
		...params.markets.map(
			(m) =>
				`${m.name} idx=${m.market_index} tier=${m.contract_tier} ` +
				`margin=${m.margin_ratio_initial}/${m.margin_ratio_maintenance} ` +
				`maxOI=${m.max_open_interest} feed=${m.lazer_feed_id}`
		),
	]);

	const receipt: Receipt = {
		cluster: rpcUrl,
		programId: programId.toBase58(),
		admin: keypair.publicKey.toBase58(),
		paramsPath,
		pythLazerOracles: {},
		perpMarkets: {},
		startedAt: new Date().toISOString(),
	};
	const writeReceipt = () => {
		if (DRY_RUN) return;
		fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
	};

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

	// Phase 1: Pyth Lazer oracle PDA per unique feed
	await confirm(`Begin Phase 1: ${feedIds.length} Pyth Lazer oracle PDA(s)?`);
	for (const feedId of feedIds) {
		const pk = getPythLazerOraclePublicKey(programId, feedId);
		if (await pdaExists(connection, pk)) {
			logStep(`lazer oracle feed=${feedId} already initialized`, pk.toBase58());
			receipt.pythLazerOracles[feedId] = { pubkey: pk.toBase58() };
		} else if (DRY_RUN) {
			dryStep(`initializePythLazerOracle feed=${feedId}`, pk.toBase58());
		} else {
			logStep(`initializePythLazerOracle feed=${feedId}`);
			const txSig = await client.initializePythLazerOracle(feedId);
			receipt.pythLazerOracles[feedId] = { pubkey: pk.toBase58(), txSig };
		}
	}
	writeReceipt();

	// Phase 2: post initial prices for every feed
	// initialize_perp_market validates get_oracle_price succeeds, so every
	// oracle needs a published price before Phase 3.
	await confirm(`Begin Phase 2: post initial Lazer prices for [${feedIds.join(', ')}]?`);
	{
		// fetch even in dry run: validates the relay token and feed ids
		const messageHex = await fetchLazerMessageHex(
			pythLazerEndpoints,
			pythLazerToken,
			feedIds,
			pythLazerWaitMs
		);
		if (DRY_RUN) {
			dryStep(
				`postPythLazerOracleUpdate feeds=[${feedIds.join(',')}]`,
				`message length = ${messageHex.length / 2}b`
			);
		} else {
			logStep(
				`postPythLazerOracleUpdate feeds=[${feedIds.join(',')}]`,
				`message length = ${messageHex.length / 2}b`
			);
			const sig = await client.postPythLazerOracleUpdate(feedIds, messageHex);
			console.log(`  tx: ${sig}`);
		}
	}

	// Phase 3: initialize perp markets
	await confirm(`Begin Phase 3: initialize ${params.markets.length} perp market(s)?`);
	// dry-run only: markets whose init was skipped, so Phase 4 has nothing to
	// read on chain for them
	const wouldInit = new Set<number>();
	for (const m of params.markets) {
		const perpPk = await getPerpMarketPublicKey(programId, m.market_index);
		if (await pdaExists(connection, perpPk)) {
			logStep(
				`${m.name} (index ${m.market_index}) already initialized`,
				perpPk.toBase58()
			);
			receipt.perpMarkets[m.market_index] = {
				name: m.name,
				pubkey: perpPk.toBase58(),
			};
			continue;
		}
		if (DRY_RUN) {
			dryStep(
				`initializePerpMarket ${m.name} @ index ${m.market_index}`,
				`tier=${m.contract_tier} margin=${m.margin_ratio_initial}/${m.margin_ratio_maintenance} ` +
					`peg=${m.amm_peg_multiplier} maxOI=${m.max_open_interest} feed=${m.lazer_feed_id}`
			);
			wouldInit.add(m.market_index);
			continue;
		}
		const oraclePk = getPythLazerOraclePublicKey(
			programId,
			m.lazer_feed_id as number
		);
		logStep(`initializePerpMarket ${m.name} @ index ${m.market_index}`);
		const txSig = await client.initializePerpMarket(
			m.market_index,
			oraclePk,
			bn(m.amm_base_asset_reserve),
			bn(m.amm_quote_asset_reserve),
			new BN(m.amm_periodicity),
			bn(m.amm_peg_multiplier),
			ORACLE_SOURCES[m.oracle_source],
			CONTRACT_TIERS[m.contract_tier],
			m.margin_ratio_initial,
			m.margin_ratio_maintenance,
			m.liquidator_fee,
			m.if_liquidation_fee,
			m.imf_factor,
			m.active_status,
			m.base_spread,
			m.max_spread,
			bn(m.max_open_interest),
			bn(m.max_revenue_withdraw_per_period),
			bn(m.quote_max_insurance),
			bn(m.order_step_size),
			bn(m.order_tick_size as string),
			bn(m.min_order_size as string),
			bn(m.concentration_coef_scale),
			// init rejects > 100; values in (100, 200] (reference price offset
			// intensity) are pushed via the update ix in Phase 4.
			Math.min(m.curve_update_intensity as number, 100),
			m.amm_jit_intensity as number,
			m.name,
			m.lp_pool_id,
			m.funding_clamp_threshold,
			m.funding_ramp_slope
		);
		receipt.perpMarkets[m.market_index] = {
			name: m.name,
			pubkey: perpPk.toBase58(),
			initTxSig: txSig,
		};
		await client.fetchAccounts();
		writeReceipt();
	}

	// Phase 4: per-market post-init (repeg + knob sync)
	await confirm('Begin Phase 4: repeg to live oracle + sync market knobs?');
	await client.unsubscribe();

	// in a dry run, would-init markets do not exist on chain; nothing to
	// subscribe to or diff against, so Phase 4 covers existing markets only.
	const knobsMarkets = params.markets.filter((m) => !wouldInit.has(m.market_index));
	for (const m of params.markets) {
		if (wouldInit.has(m.market_index)) {
			dryStep(
				`run Phase 4 for ${m.name} after init`,
				'market does not exist yet; a real run repegs + syncs knobs right after init'
			);
		}
	}
	if (knobsMarkets.length === 0) {
		console.log('\n[DRY RUN] complete; no transactions were sent.');
		return;
	}
	const knobsFeedIds = [
		...new Set(knobsMarkets.map((m) => m.lazer_feed_id as number)),
	];
	const knobsClient = new AdminClient({
		connection,
		wallet,
		programID: programId,
		env: 'mainnet-beta',
		accountSubscription: { type: 'websocket', commitment: 'confirmed' },
		perpMarketIndexes: knobsMarkets.map((m) => m.market_index),
		spotMarketIndexes: [],
		oracleInfos: knobsFeedIds.map((feedId) => ({
			publicKey: getPythLazerOraclePublicKey(programId, feedId),
			source: OracleSource.PYTH_LAZER,
		})),
		skipLoadUsers: true,
	});
	await knobsClient.subscribe();

	for (const m of knobsMarkets) {
		const idx = m.market_index;
		const pm = knobsClient.getPerpMarketAccount(idx);
		if (!pm) throw new Error(`perp market ${idx} not found after subscribe`);
		const oraclePrice = knobsClient.getOracleDataForPerpMarket(idx).price;
		if (oraclePrice.lten(0)) {
			logStep(`${m.name}: oracle price unavailable, skipping Phase 4`);
			continue;
		}

		// --- repeg mark toward live oracle. Params peg is a dated reference;
		// funding blocks (6251) when mark diverges too far from the oracle.
		// A single repeg can only reach the bottom of the oracle confidence band
		// (calculate_repeg_validity), so target ~1% below and let the formulaic
		// curve-update close the residual. Skip when already within 2%.
		const markPrice = pm.amm.quoteAssetReserve
			.mul(pm.amm.pegMultiplier)
			.div(pm.amm.baseAssetReserve);
		const tolerance = oraclePrice.divn(50); // 2%
		if (markPrice.sub(oraclePrice).abs().lte(tolerance)) {
			logStep(
				`${m.name}: mark within 2% of oracle; skip repeg`,
				`mark=${markPrice.toString()} oracle=${oraclePrice.toString()}`
			);
		} else if (DRY_RUN) {
			const targetPrice = oraclePrice.sub(oraclePrice.divn(100)); // 1% below
			const newPeg = targetPrice
				.mul(pm.amm.baseAssetReserve)
				.div(pm.amm.quoteAssetReserve);
			dryStep(
				`repegAmmCurve ${m.name} -> ~1% below oracle`,
				`newPeg=${newPeg.toString()} oracle=${oraclePrice.toString()} mark=${markPrice.toString()}`
			);
		} else {
			const targetPrice = oraclePrice.sub(oraclePrice.divn(100)); // 1% below
			const newPeg = targetPrice
				.mul(pm.amm.baseAssetReserve)
				.div(pm.amm.quoteAssetReserve);
			logStep(
				`repegAmmCurve ${m.name} -> ~1% below oracle`,
				`newPeg=${newPeg.toString()} oracle=${oraclePrice.toString()} mark=${markPrice.toString()}`
			);
			// RepegAmmCurve rejects a stale oracle, so bundle a fresh price post in
			// the SAME tx: [ed25519 verify (0), post (1), repeg (2)]. The post ix
			// must sit at index 1 (getPostPythLazerOracleUpdateIxs defaults the
			// verify reference to 1), so build the tx by hand, no buildTransaction.
			const msgHex = await fetchLazerMessageHex(
				pythLazerEndpoints,
				pythLazerToken,
				[m.lazer_feed_id as number],
				pythLazerWaitMs
			);
			const postIxs = await knobsClient.getPostPythLazerOracleUpdateIxs(
				[m.lazer_feed_id as number],
				msgHex
			);
			const repegIx = await knobsClient.getRepegAmmCurveIx(newPeg, idx);
			const { blockhash } = await connection.getLatestBlockhash('confirmed');
			const tx = new Transaction();
			tx.add(...postIxs, repegIx);
			tx.recentBlockhash = blockhash;
			tx.feePayer = keypair.publicKey;
			const sig = await connection.sendTransaction(tx, [keypair]);
			await connection.confirmTransaction(sig, 'confirmed');
			receipt.perpMarkets[idx].repegTxSig = sig;
			console.log(`  tx: ${sig}`);
		}

		// --- set max_open_interest from the USD cap at the live oracle price.
		// The init value was computed at a reference-price snapshot; this holds
		// the USD intent. usd * 1e6 * 1e9 / price(1e6) = base 1e9. Skip when
		// within 2% of the on-chain value, or when oi_cap_usd is null.
		if (m.oi_cap_usd !== null) {
			const derivedOi = new BN(m.oi_cap_usd)
				.mul(PRICE_PRECISION)
				.mul(BASE_PRECISION)
				.div(oraclePrice);
			const oiTolerance = derivedOi.divn(50); // 2%
			if (pm.maxOpenInterest.sub(derivedOi).abs().lte(oiTolerance)) {
				logStep(
					`${m.name}: maxOpenInterest within 2% of USD cap; skip`,
					`onchain=${pm.maxOpenInterest.toString()} derived=${derivedOi.toString()}`
				);
			} else if (DRY_RUN) {
				dryStep(
					`updatePerpMarketMaxOpenInterest ${m.name}`,
					`$${m.oi_cap_usd.toLocaleString()} @ oracle=${oraclePrice.toString()} -> ${derivedOi.toString()} (was ${pm.maxOpenInterest.toString()})`
				);
			} else {
				logStep(
					`updatePerpMarketMaxOpenInterest ${m.name}`,
					`$${m.oi_cap_usd.toLocaleString()} @ oracle=${oraclePrice.toString()} -> ${derivedOi.toString()} (was ${pm.maxOpenInterest.toString()})`
				);
				const sig = await knobsClient.updatePerpMarketMaxOpenInterest(
					idx,
					derivedOi
				);
				receipt.perpMarkets[idx].maxOpenInterestTxSig = sig;
				console.log(`  tx: ${sig}`);
			}
		}

		// --- oracle slot delay override. Init default -1 clamps the
		// stale-for-amm-immediate threshold to 0 slots; with a multi-slot crank
		// cadence the oracle is then always "stale". null in params = leave as-is.
		if (
			m.oracle_slot_delay_override !== null &&
			pm.oracleSlotDelayOverride !== m.oracle_slot_delay_override
		) {
			if (DRY_RUN) {
				dryStep(
					`updatePerpMarketOracleSlotDelayOverride ${m.name}`,
					`${pm.oracleSlotDelayOverride} -> ${m.oracle_slot_delay_override}`
				);
			} else {
				logStep(
					`updatePerpMarketOracleSlotDelayOverride ${m.name}`,
					`${pm.oracleSlotDelayOverride} -> ${m.oracle_slot_delay_override}`
				);
				const sig = await knobsClient.updatePerpMarketOracleSlotDelayOverride(
					idx,
					m.oracle_slot_delay_override
				);
				console.log(`  tx: ${sig}`);
			}
		}

		// --- intensity sync. Init clamps curve_update_intensity to 100, so for
		// params in (100, 200] (reference price offset intensity) this update is
		// the intended path, not just rerun repair. Also fixes a market that
		// already existed with different values.
		if (pm.amm.curveUpdateIntensity !== m.curve_update_intensity) {
			if (DRY_RUN) {
				dryStep(
					`updatePerpMarketCurveUpdateIntensity ${m.name}`,
					`${pm.amm.curveUpdateIntensity} -> ${m.curve_update_intensity}`
				);
			} else {
				logStep(
					`updatePerpMarketCurveUpdateIntensity ${m.name}`,
					`${pm.amm.curveUpdateIntensity} -> ${m.curve_update_intensity}`
				);
				const sig = await knobsClient.updatePerpMarketCurveUpdateIntensity(
					idx,
					m.curve_update_intensity as number
				);
				console.log(`  tx: ${sig}`);
			}
		}
		if (pm.amm.ammJitIntensity !== m.amm_jit_intensity) {
			if (DRY_RUN) {
				dryStep(
					`updateAmmJitIntensity ${m.name}`,
					`${pm.amm.ammJitIntensity} -> ${m.amm_jit_intensity}`
				);
			} else {
				logStep(
					`updateAmmJitIntensity ${m.name}`,
					`${pm.amm.ammJitIntensity} -> ${m.amm_jit_intensity}`
				);
				const sig = await knobsClient.updateAmmJitIntensity(
					idx,
					m.amm_jit_intensity as number
				);
				console.log(`  tx: ${sig}`);
			}
		}
		writeReceipt();
	}

	// Phase 5: global params
	// Liquidation pacing lives on State, not per market. null = skip (on-chain
	// stays 0 = pacing disabled). Fee structure, oracle guard rails, and the
	// dUSDT collateral weights are NOT handled here yet; see the params file
	// _mainnet_checklist. Extend this phase when those values land.
	const g = params.global;
	if (g) {
		await confirm('Begin Phase 5: global liquidation pacing?', [
			`initial_pct_to_liquidate: ${g.initial_pct_to_liquidate ?? 'null (skip)'}`,
			`liquidation_duration:     ${g.liquidation_duration ?? 'null (skip)'}`,
		]);
		if (g.initial_pct_to_liquidate !== null) {
			if (DRY_RUN) {
				dryStep(`updateInitialPctToLiquidate -> ${g.initial_pct_to_liquidate}`);
			} else {
				logStep(`updateInitialPctToLiquidate -> ${g.initial_pct_to_liquidate}`);
				await knobsClient.updateInitialPctToLiquidate(g.initial_pct_to_liquidate);
			}
		}
		if (g.liquidation_duration !== null) {
			if (DRY_RUN) {
				dryStep(`updateLiquidationDuration -> ${g.liquidation_duration}`);
			} else {
				logStep(`updateLiquidationDuration -> ${g.liquidation_duration}`);
				await knobsClient.updateLiquidationDuration(g.liquidation_duration);
			}
		}
	}

	receipt.finishedAt = new Date().toISOString();
	writeReceipt();
	if (DRY_RUN) {
		console.log('\n[DRY RUN] complete; no transactions were sent.');
	} else {
		console.log(`\nreceipt written: ${receiptPath}`);
	}

	await knobsClient.unsubscribe();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
