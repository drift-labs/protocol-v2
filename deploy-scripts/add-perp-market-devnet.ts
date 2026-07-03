/**
 * Add a single Pyth-Lazer perp market to devnet, mirroring init-devnet.ts's
 * proven SOL-PERP flow (Phases C/C+/D/D2) but for one arbitrary market selected
 * by name from the risk-params file. Use it to (re)create BTC-PERP and ETH-PERP
 * after they were pruned from devnet.
 *
 * WHY THIS EXISTS: init-devnet.ts only inits SOL-PERP at index 0.
 * init-markets.ts inits BTC+ETH from params but is the *mainnet* runbook — it
 * hardcodes the Pyth Lazer relay channel + SDK env to 'mainnet-beta', so its
 * signed price messages are rejected by the devnet program's Lazer verifier.
 * This script is the devnet-native equivalent: same param mapping and Phase-4
 * knob sync as init-markets.ts, but with the 'devnet' Lazer channel/env that
 * init-devnet.ts proved works against the deployed devnet program.
 *
 * SEQUENTIAL INDICES: admin.rs requires `market_index == state.number_of_markets`
 * at init, and derives the PerpMarket PDA from that counter. So markets must be
 * created in ascending order with no gaps. This script asserts the selected
 * market's `market_index` equals the current `state.numberOfMarkets` and refuses
 * otherwise. On today's devnet (SOL-PERP at index 0, numberOfMarkets = 1) run
 * BTC (index 1) first, then ETH (index 2).
 *
 * The market's AMM/margin/tier params come straight from the risk-params file
 * (default deploy-scripts/params/relaunch-perp-markets.json) — the same values
 * the mainnet runbook uses. Phase 4 repegs the AMM to the *live* devnet oracle
 * (the params peg is a dated snapshot) and re-derives max_open_interest from
 * `oi_cap_usd` at that live price, so a mainnet-tuned peg is fine here.
 *
 * NOT configured here (add separately if needed): mm_oracle_feed_id overlay,
 * insurance-fund staking, LP-pool membership. init-markets.ts doesn't set the
 * mm-oracle feed either — a market is fully functional without it.
 *
 * Idempotent: every phase checks whether its destination account already exists
 * (oracle PDA, perp PDA) and skips; Phase 4 diffs each knob and only sends when
 * the on-chain value differs, so a rerun repairs a partially-created market.
 *
 * Required env:
 *   DEVNET_ADMIN       path to admin keypair file (State.admin; signs everything)
 *   PYTH_LAZER_TOKEN   auth token for the Pyth Lazer relay (to post prices)
 *   MARKET             market to init — matched against params `name`
 *                      case-insensitively, with/without the "-PERP" suffix
 *                      (e.g. "ETH", "eth", "ETH-PERP" all select ETH-PERP)
 * Optional env:
 *   RPC_URL              default https://api.devnet.solana.com
 *   PARAMS_PATH          default deploy-scripts/params/relaunch-perp-markets.json
 *   RECEIPT_PATH         default deploy-scripts/out/devnet-<name>.json
 *   PYTH_LAZER_ENDPOINTS comma-separated WSS endpoints
 *                        (default wss://pyth-lazer.dourolabs.app/v1/stream)
 *   PYTH_LAZER_WAIT_MS   ms to wait for first signed message (default 30000)
 *   NON_INTERACTIVE / YES=1   skip confirm() prompts
 *   DRY_RUN=1 / --dry-run     no transactions; log intended actions
 *
 * Run from repo root (mirrors init-devnet.ts; bun works for this script — if it
 * hits the @solana/errors web3-v2 codec clash described in
 * fund-trade-sim-subaccounts.sh, fall back to that script's ts-node wrapper):
 *
 *   DEVNET_ADMIN=~/path/to/admin.json \
 *   PYTH_LAZER_TOKEN=<token> \
 *   MARKET=BTC \
 *   bun run deploy-scripts/add-perp-market-devnet.ts
 */

import { BN } from '@coral-xyz/anchor';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
	AdminClient,
	BASE_PRECISION,
	ContractTier,
	getPerpMarketPublicKey,
	getPythLazerOraclePublicKey,
	loadKeypair,
	OracleSource,
	PRICE_PRECISION,
	PythLazerSubscriber,
	VELOCITY_DEVNET_PROGRAM_ID,
	Wallet,
} from '../packages/sdk/src';

// Pyth Lazer relay channel + SDK env for devnet. init-markets.ts uses
// 'mainnet-beta' for both; the devnet program only accepts devnet-signed
// messages, so we mirror init-devnet.ts's 'devnet'.
const LAZER_CHANNEL = 'devnet' as const;
const SDK_ENV = 'devnet' as const;

type MarketParams = {
	name: string;
	market_index: number;
	oracle_source: string;
	contract_tier: string;
	lazer_feed_id: number | null;
	mm_oracle_feed_id: number | null;
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
	order_tick_size: string;
	min_order_size: string;
	curve_update_intensity: number;
	amm_jit_intensity: number;
	oracle_slot_delay_override: number | null;
	active_status: boolean;
	lp_pool_id: number;
	funding_clamp_threshold: number;
	funding_ramp_slope: number;
};

type ParamsFile = { markets: MarketParams[] };

type Receipt = {
	cluster: string;
	programId: string;
	name: string;
	marketIndex: number;
	lazerFeedId: number;
	perpMarketPubkey: string;
	pythLazerOraclePubkey: string;
	oracleInitTxSig?: string;
	pricePostTxSig?: string;
	initTxSig?: string;
	repegTxSig?: string;
	maxOpenInterestTxSig?: string;
};

const ORACLE_SOURCES: Record<
	string,
	(typeof OracleSource)[keyof typeof OracleSource]
> = {
	PythLazer: OracleSource.PYTH_LAZER,
};
const CONTRACT_TIERS: Record<
	string,
	(typeof ContractTier)[keyof typeof ContractTier]
> = {
	A: ContractTier.A,
	B: ContractTier.B,
	C: ContractTier.C,
	Speculative: ContractTier.SPECULATIVE,
	HighlySpeculative: ContractTier.HIGHLY_SPECULATIVE,
	Isolated: ContractTier.ISOLATED,
};

// Program constants (math/constants.rs): coef = CONCENTRATION_PRECISION +
// (MAX_CONCENTRATION_COEFFICIENT - CONCENTRATION_PRECISION) / scale.
const CONCENTRATION_PRECISION = 1_000_000;
const MAX_CONCENTRATION_COEFFICIENT = 1_414_200;

// Resolve the scale divisor initializePerpMarket expects. Honors a
// CONCENTRATION_SCALE override; otherwise interprets the params value: a valid
// scale is <= (MAX - PRECISION) = 414_200, so anything larger is a coefficient
// and is converted back to its scale.
function resolveConcentrationScale(paramValue: string): number {
	if (process.env.CONCENTRATION_SCALE !== undefined) {
		return Number(process.env.CONCENTRATION_SCALE);
	}
	const v = Number(paramValue);
	const maxScale = MAX_CONCENTRATION_COEFFICIENT - CONCENTRATION_PRECISION;
	if (v > maxScale) {
		return Math.round(maxScale / (v - CONCENTRATION_PRECISION));
	}
	return v;
}

const NON_INTERACTIVE =
	process.env.NON_INTERACTIVE === '1' || process.env.YES === '1';
const DRY_RUN =
	process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

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
	return (await connection.getAccountInfo(pda, 'confirmed')) !== null;
}

function logStep(title: string, note?: string) {
	console.log(
		`\n[${new Date().toISOString()}] ${title}${note ? `: ${note}` : ''}`
	);
}

function dryStep(action: string, note?: string) {
	logStep(`[DRY RUN] would ${action}`, note);
}

async function confirm(prompt: string, details?: string[]): Promise<void> {
	if (details?.length) {
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
	const answer: string = await new Promise((resolve) =>
		rl.question(`\n${prompt} [y/N] `, (a) => resolve(a.trim().toLowerCase()))
	);
	rl.close();
	if (answer !== 'y' && answer !== 'yes') {
		console.log('aborted by user.');
		process.exit(1);
	}
}

// Match MARKET against params `name`, tolerating case and a missing "-PERP".
function selectMarket(markets: MarketParams[], want: string): MarketParams {
	const norm = (s: string) => s.toLowerCase().replace(/-perp$/, '');
	const target = norm(want);
	const hit = markets.filter((m) => norm(m.name) === target);
	if (hit.length === 0) {
		throw new Error(
			`MARKET="${want}" not found in params. Available: ${markets
				.map((m) => m.name)
				.join(', ')}`
		);
	}
	if (hit.length > 1) {
		throw new Error(
			`MARKET="${want}" is ambiguous: ${hit.map((m) => m.name).join(', ')}`
		);
	}
	return hit[0];
}

// Subscribe to Pyth Lazer, wait for the first signed message for `feedIds`,
// return its hex. Used for the initial price post and the Phase-4 repeg bundle.
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
		LAZER_CHANNEL,
		2000,
		false,
		// feedUpdateTimestamp is mandatory: the on-chain post silently skips
		// messages without it. bestBid/Ask feed the on-chain conf calc.
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
			)}]. Check PYTH_LAZER_TOKEN and that the ${LAZER_CHANNEL} relay accepts it.`
		);
	}
	return messageHex;
}

async function main() {
	const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
	const paramsPath =
		process.env.PARAMS_PATH ??
		'deploy-scripts/params/relaunch-perp-markets.json';
	const pythLazerToken = requireEnv('PYTH_LAZER_TOKEN');
	const pythLazerEndpoints = (
		process.env.PYTH_LAZER_ENDPOINTS ??
		'wss://pyth-lazer.dourolabs.app/v1/stream'
	)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const pythLazerWaitMs = Number(process.env.PYTH_LAZER_WAIT_MS ?? 30_000);

	const params = JSON.parse(
		fs.readFileSync(path.resolve(paramsPath), 'utf8')
	) as ParamsFile;
	const m = selectMarket(params.markets, requireEnv('MARKET'));

	if (!(m.oracle_source in ORACLE_SOURCES)) {
		throw new Error(`${m.name}: unmapped oracle_source "${m.oracle_source}"`);
	}
	if (m.oracle_source !== 'PythLazer') {
		throw new Error(`${m.name}: this script only handles PythLazer markets`);
	}
	// Feed id comes from the risk-params file (SOL=6, BTC=1, ETH=2 — the real
	// asset price feeds; note ETH's 3114 in params is the mm-oracle feed, not the
	// price feed). Override with LAZER_FEED_ID per run if devnet differs.
	const feedId =
		process.env.LAZER_FEED_ID !== undefined
			? Number(process.env.LAZER_FEED_ID)
			: m.lazer_feed_id;
	if (feedId === null || !Number.isInteger(feedId) || feedId < 0) {
		throw new Error(
			`${m.name}: no valid lazer feed id — set LAZER_FEED_ID (params value is ${m.lazer_feed_id})`
		);
	}
	if (m.lazer_feed_id !== feedId) {
		console.log(
			`note: using lazer feed id ${feedId} (overrides params value ${m.lazer_feed_id})`
		);
	}

	// The risk-params file stores concentration_coef_scale as the COEFFICIENT
	// (~1.00e6), but initializePerpMarket wants the SCALE DIVISOR: the program
	// computes coef = 1e6 + (1_414_200 - 1e6) / scale and rejects (6194,
	// InvalidConcentrationCoef) unless 1e6 < coef <= 1_414_200 — so scale must be
	// in [1, 414_200]. A raw coefficient (e.g. 1_000_828) floors the division to 0
	// and fails. Convert coef -> scale here. (Mainnet-relaunch bug #1; the shared
	// params file still holds coefficients.) Override with CONCENTRATION_SCALE.
	const concentrationScale = resolveConcentrationScale(
		m.concentration_coef_scale
	);
	{
		const maxScale = MAX_CONCENTRATION_COEFFICIENT - CONCENTRATION_PRECISION;
		if (
			!Number.isInteger(concentrationScale) ||
			concentrationScale < 1 ||
			concentrationScale > maxScale
		) {
			throw new Error(
				`${m.name}: resolved concentration scale ${concentrationScale} out of range [1, ${maxScale}] ` +
					`(params concentration_coef_scale=${m.concentration_coef_scale})`
			);
		}
		const coef =
			CONCENTRATION_PRECISION + Math.floor(maxScale / concentrationScale);
		if (m.concentration_coef_scale !== String(concentrationScale)) {
			console.log(
				`note: concentration scale ${concentrationScale} -> coef ${coef} ` +
					`(params value ${m.concentration_coef_scale} is the coefficient)`
			);
		}
	}

	const receiptPath =
		process.env.RECEIPT_PATH ??
		`deploy-scripts/out/devnet-${m.name.toLowerCase()}.json`;
	const absReceiptPath = path.resolve(receiptPath);
	fs.mkdirSync(path.dirname(absReceiptPath), { recursive: true });

	const connection = new Connection(rpcUrl, 'confirmed');
	const keypair = loadKeypair(requireEnv('DEVNET_ADMIN'));
	const wallet = new Wallet(keypair);
	const programId = new PublicKey(VELOCITY_DEVNET_PROGRAM_ID);

	const perpPk = await getPerpMarketPublicKey(programId, m.market_index);
	const oraclePk = getPythLazerOraclePublicKey(programId, feedId);

	console.log(`velocity program: ${programId.toBase58()}`);
	console.log(`rpc:              ${rpcUrl}`);
	console.log(`admin:            ${keypair.publicKey.toBase58()}`);
	console.log(`market:           ${m.name} @ index ${m.market_index}`);
	console.log(`lazer feed id:    ${feedId}`);
	console.log(`lazer channel:    ${LAZER_CHANNEL}`);
	console.log(`perp PDA:         ${perpPk.toBase58()}`);
	console.log(`oracle PDA:       ${oraclePk.toBase58()}`);
	if (DRY_RUN) console.log('*** DRY RUN — no transactions will be sent ***');

	const client = new AdminClient({
		connection,
		wallet,
		programID: programId,
		env: SDK_ENV,
		accountSubscription: { type: 'websocket', commitment: 'confirmed' },
		perpMarketIndexes: [],
		spotMarketIndexes: [],
		oracleInfos: [],
		skipLoadUsers: true,
	});
	await client.subscribe();

	// Guard: sequential/gapless indices. admin.rs requires
	// market_index == state.number_of_markets at init.
	const nMarkets = client.getStateAccount().numberOfMarkets;
	if (nMarkets !== m.market_index) {
		throw new Error(
			`Refusing to init ${m.name}: its market_index is ${m.market_index} but ` +
				`state.numberOfMarkets is ${nMarkets}. Markets must be created in ` +
				`ascending order with no gaps — init index ${nMarkets} first ` +
				`(the market whose market_index === ${nMarkets} in ${paramsPath}).`
		);
	}

	const receipt: Receipt = {
		cluster: rpcUrl,
		programId: programId.toBase58(),
		name: m.name,
		marketIndex: m.market_index,
		lazerFeedId: feedId,
		perpMarketPubkey: perpPk.toBase58(),
		pythLazerOraclePubkey: oraclePk.toBase58(),
	};
	const saveReceipt = () =>
		fs.writeFileSync(absReceiptPath, JSON.stringify(receipt, null, 2));

	await confirm(`Create ${m.name} at index ${m.market_index} on devnet?`, [
		`oracle:          PythLazer feed ${feedId} (${oraclePk.toBase58()})`,
		`contract tier:   ${m.contract_tier}`,
		`margin ratios:   ${m.margin_ratio_initial / 100}% init / ${
			m.margin_ratio_maintenance / 100
		}% maint`,
		`peg (snapshot):  ${m.amm_peg_multiplier} — Phase 4 repegs to live oracle`,
		`oi cap:          ${
			m.oi_cap_usd === null ? '(none)' : `$${m.oi_cap_usd.toLocaleString()}`
		}`,
		`receipt:         ${absReceiptPath}`,
	]);

	// === Phase 1: Pyth Lazer oracle PDA ===
	if (await pdaExists(connection, oraclePk)) {
		logStep(
			`Pyth Lazer oracle (feed ${feedId}) already initialized`,
			oraclePk.toBase58()
		);
	} else if (DRY_RUN) {
		dryStep(`initializePythLazerOracle feed=${feedId}`, oraclePk.toBase58());
	} else {
		logStep(`initializePythLazerOracle feed=${feedId}`);
		receipt.oracleInitTxSig = await client.initializePythLazerOracle(feedId);
		console.log(`  tx: ${receipt.oracleInitTxSig}`);
		saveReceipt();
	}

	// === Phase 2: post an initial signed price ===
	// initializePerpMarket calls get_oracle_price and fails if the oracle has no
	// published price yet.
	if (DRY_RUN) {
		dryStep(`postPythLazerOracleUpdate feed=${feedId}`);
	} else {
		logStep(`postPythLazerOracleUpdate feed=${feedId}`);
		const messageHex = await fetchLazerMessageHex(
			pythLazerEndpoints,
			pythLazerToken,
			[feedId],
			pythLazerWaitMs
		);
		receipt.pricePostTxSig = await client.postPythLazerOracleUpdate(
			[feedId],
			messageHex
		);
		console.log(`  tx: ${receipt.pricePostTxSig}`);
		saveReceipt();
	}

	// === Phase 3: initialize the perp market (param mapping mirrors init-markets.ts) ===
	if (await pdaExists(connection, perpPk)) {
		logStep(`${m.name} already initialized`, perpPk.toBase58());
	} else if (DRY_RUN) {
		dryStep(`initializePerpMarket ${m.name} @ index ${m.market_index}`);
	} else {
		logStep(`initializePerpMarket ${m.name} @ index ${m.market_index}`);
		receipt.initTxSig = await client.initializePerpMarket(
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
			bn(m.order_tick_size),
			bn(m.min_order_size),
			new BN(concentrationScale),
			// init rejects > 100; values in (100, 200] are pushed via the update ix
			// in Phase 4.
			Math.min(m.curve_update_intensity, 100),
			m.amm_jit_intensity,
			m.name,
			m.lp_pool_id,
			m.funding_clamp_threshold,
			m.funding_ramp_slope
		);
		console.log(`  tx: ${receipt.initTxSig}`);
		saveReceipt();
	}

	// === Phase 4: repeg to live oracle + sync knobs ===
	// Skip entirely in a dry run of a not-yet-created market (nothing on chain).
	if (DRY_RUN && !(await pdaExists(connection, perpPk))) {
		dryStep(
			`repeg + sync knobs for ${m.name}`,
			'market does not exist yet; a real run does this right after init'
		);
		logStep('DRY RUN complete; no transactions were sent.');
		await client.unsubscribe();
		return;
	}

	await confirm(`Phase 4 — repeg ${m.name} to live oracle + sync knobs?`, [
		'repegs mark to ~1% below the live oracle (params peg is a snapshot)',
		'sets max_open_interest from the USD cap at the live price',
		'syncs oracleSlotDelayOverride / curveUpdateIntensity / ammJitIntensity',
	]);

	await client.unsubscribe();
	const knobsClient = new AdminClient({
		connection,
		wallet,
		programID: programId,
		env: SDK_ENV,
		accountSubscription: { type: 'websocket', commitment: 'confirmed' },
		perpMarketIndexes: [m.market_index],
		spotMarketIndexes: [],
		oracleInfos: [{ publicKey: oraclePk, source: OracleSource.PYTH_LAZER }],
		skipLoadUsers: true,
	});
	await knobsClient.subscribe();

	const idx = m.market_index;
	const pm = knobsClient.getPerpMarketAccount(idx);
	if (!pm) throw new Error(`perp market ${idx} not found after subscribe`);
	const oraclePrice = knobsClient.getOracleDataForPerpMarket(idx).price;
	if (oraclePrice.lten(0)) {
		throw new Error(
			`${m.name}: live oracle price unavailable/zero; cannot repeg`
		);
	}

	// --- repeg mark toward live oracle (target ~1% below; a single repeg can only
	// reach the bottom of the oracle confidence band). Skip when within 2%.
	const markPrice = pm.amm.quoteAssetReserve
		.mul(pm.amm.pegMultiplier)
		.div(pm.amm.baseAssetReserve);
	const tolerance = oraclePrice.divn(50); // 2%
	if (markPrice.sub(oraclePrice).abs().lte(tolerance)) {
		logStep(
			`${m.name}: mark within 2% of oracle; skip repeg`,
			`mark=${markPrice.toString()} oracle=${oraclePrice.toString()}`
		);
	} else {
		// Direction-aware target: a single repeg can only reach the near edge of
		// the oracle confidence band, and repegging the wrong way is rejected
		// (InvalidRepegDirection/6013). Aim ~1% toward the oracle from whichever
		// side mark sits. (Mainnet-relaunch bug #2 was an unconditional 1%-below.)
		const targetPrice = markPrice.gt(oraclePrice)
			? oraclePrice.add(oraclePrice.divn(100)) // mark high -> repeg down to oracle+1%
			: oraclePrice.sub(oraclePrice.divn(100)); // mark low  -> repeg up to oracle-1%
		const newPeg = targetPrice
			.mul(pm.amm.baseAssetReserve)
			.div(pm.amm.quoteAssetReserve);
		logStep(
			`repegAmmCurve ${m.name} -> ~1% toward oracle`,
			`newPeg=${newPeg.toString()} target=${targetPrice.toString()} oracle=${oraclePrice.toString()} mark=${markPrice.toString()}`
		);
		// RepegAmmCurve rejects a stale oracle, so bundle a fresh price post in the
		// SAME tx: [ed25519 verify (0), post (1), repeg (2)]. The post ix must sit
		// at index 1 (getPostPythLazerOracleUpdateIxs defaults the verify reference
		// to 1), so build the tx by hand — no buildTransaction (it prepends
		// compute-budget ixs and shifts the index).
		const msgHex = await fetchLazerMessageHex(
			pythLazerEndpoints,
			pythLazerToken,
			[feedId],
			pythLazerWaitMs
		);
		const postIxs = await knobsClient.getPostPythLazerOracleUpdateIxs(
			[feedId],
			msgHex
		);
		const repegIx = await knobsClient.getRepegAmmCurveIx(newPeg, idx);
		const { blockhash } = await connection.getLatestBlockhash('confirmed');
		const tx = new Transaction();
		tx.add(...postIxs, repegIx);
		tx.recentBlockhash = blockhash;
		tx.feePayer = keypair.publicKey;
		receipt.repegTxSig = await connection.sendTransaction(tx, [keypair]);
		await connection.confirmTransaction(receipt.repegTxSig, 'confirmed');
		console.log(`  tx: ${receipt.repegTxSig}`);
		saveReceipt();
	}

	// --- max_open_interest from the USD cap at the live price.
	// usd * 1e6 * 1e9 / price(1e6) = base 1e9. Skip within 2%, or if null.
	if (m.oi_cap_usd !== null) {
		const stepSize = new BN(m.order_step_size);
		let derivedOi = new BN(m.oi_cap_usd)
			.mul(PRICE_PRECISION)
			.mul(BASE_PRECISION)
			.div(oraclePrice);
		// max_open_interest must be a multiple of order_step_size — the update ix
		// rejects otherwise (init doesn't check). (Mainnet-relaunch bug #3.)
		derivedOi = derivedOi.sub(derivedOi.mod(stepSize));
		const oiTolerance = derivedOi.divn(50); // 2%
		if (pm.maxOpenInterest.sub(derivedOi).abs().lte(oiTolerance)) {
			logStep(
				`${m.name}: maxOpenInterest within 2% of USD cap; skip`,
				`onchain=${pm.maxOpenInterest.toString()} derived=${derivedOi.toString()}`
			);
		} else {
			logStep(
				`updatePerpMarketMaxOpenInterest ${m.name}`,
				`$${m.oi_cap_usd.toLocaleString()} @ oracle=${oraclePrice.toString()} -> ${derivedOi.toString()} (was ${pm.maxOpenInterest.toString()})`
			);
			receipt.maxOpenInterestTxSig =
				await knobsClient.updatePerpMarketMaxOpenInterest(idx, derivedOi);
			console.log(`  tx: ${receipt.maxOpenInterestTxSig}`);
			saveReceipt();
		}
	}

	// --- oracle slot delay override (null = leave as-is).
	if (
		m.oracle_slot_delay_override !== null &&
		pm.oracleSlotDelayOverride !== m.oracle_slot_delay_override
	) {
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

	// --- curve update intensity (init clamps to 100; params may be up to 200).
	if (pm.amm.curveUpdateIntensity !== m.curve_update_intensity) {
		logStep(
			`updatePerpMarketCurveUpdateIntensity ${m.name}`,
			`${pm.amm.curveUpdateIntensity} -> ${m.curve_update_intensity}`
		);
		const sig = await knobsClient.updatePerpMarketCurveUpdateIntensity(
			idx,
			m.curve_update_intensity
		);
		console.log(`  tx: ${sig}`);
	}

	// --- amm jit intensity.
	if (pm.amm.ammJitIntensity !== m.amm_jit_intensity) {
		logStep(
			`updateAmmJitIntensity ${m.name}`,
			`${pm.amm.ammJitIntensity} -> ${m.amm_jit_intensity}`
		);
		const sig = await knobsClient.updateAmmJitIntensity(
			idx,
			m.amm_jit_intensity
		);
		console.log(`  tx: ${sig}`);
	}

	await knobsClient.unsubscribe();

	console.log(`\n=== ${m.name} @ index ${idx} done ===`);
	console.log(`perp market: ${perpPk.toBase58()}`);
	console.log(`oracle:      ${oraclePk.toBase58()}`);
	console.log(`receipt:     ${absReceiptPath}`);
	console.log(
		'\nNext: add this market to packages/sdk/src/constants/perpMarkets.ts ' +
			'(DevnetPerpMarkets) and rebuild the SDK if clients need to see it.'
	);
}

main().then(
	() => process.exit(0),
	(e) => {
		console.error(e);
		process.exit(1);
	}
);
