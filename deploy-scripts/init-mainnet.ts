/**
 * Mainnet base initialization runbook for the velocity program.
 *
 * Modeled on init-devnet.ts with the devnet-only machinery removed: no token
 * faucet, no mint creation, no admin pre-mint, no keeper token funding. The
 * quote asset is mainnet USDT (Es9vMFrz...), overridable via QUOTE_MINT.
 *
 * Run AFTER the mainnet .so is deployed (bun run program:build:mainnet + the
 * buffer flow in deploy-scripts/README.md). Executes phases:
 *
 *   0)  pre-flight: program executable, admin key gate, quote mint sanity
 *   A)  global State + hot-role authorities + mm-oracle feature bit + AmmCache
 *   B)  quote spot market at index 0 (oracle source forced to QuoteAsset)
 *   C)  Pyth Lazer oracle PDA for the quote feed + initial signed price post
 *   E)  switch quote spot market oracle to PythLazerStableCoin
 *
 * Perp markets are NOT initialized here; run init-markets.sh afterwards
 * (params file drives the markets).
 *
 * IMPORTANT, state init authority: a real mainnet build (`mainnet-beta` on,
 * `anchor-test` off) locks `initialize` to ids.rs::state_init_authority so the
 * one-time State init cannot be front-run. ADMIN_KEYPAIR must therefore be
 * that key when State does not exist yet. The signer also becomes
 * State.cold_admin, which every subsequent admin ix (and active-status market
 * init) asserts against.
 *
 * Idempotent: every phase checks whether its destination already exists on
 * chain and skips if so. Safe to re-run after partial failure.
 *
 * Required env:
 *   ADMIN_KEYPAIR         path to admin keypair file (must be the state init
 *                         authority on first run, see above)
 *   RPC_URL               private mainnet RPC
 *   QUOTE_LAZER_FEED_ID   Pyth Lazer u32 feed id for the quote asset
 *   PYTH_LAZER_TOKEN      auth token for the Pyth Lazer relay
 * Optional env:
 *   QUOTE_MINT            quote SPL mint (default: mainnet USDT)
 *   QUOTE_SYMBOL          spot market 0 name (default USDT)
 *   HOT_MM_ORACLE_CRANK, HOT_AMM_SPREAD_ADJUST, HOT_LP_SWAP, HOT_LP_CACHE,
 *   HOT_LP_SETTLE, HOT_AMM_CRANK, HOT_FEATURE_FLAG, HOT_FUEL, HOT_USER_FLAG,
 *   HOT_VAULT_DEPOSIT, HOT_FEE_WITHDRAW
 *                         hot-role authorities (default: admin pubkey; set
 *                         the real keeper keys before the bots go live)
 *   PYTH_LAZER_ENDPOINTS  comma-separated WSS endpoints
 *   PYTH_LAZER_WAIT_MS    ms to wait for first price message (default 30000)
 *   RECEIPT_PATH          default deploy-scripts/out/mainnet-deployment.json
 *   NON_INTERACTIVE=1     skip confirmation prompts
 *   DRY_RUN=1 (or --dry-run)  no transactions sent; performs every read
 *                         (pre-flight, mint checks, Lazer relay fetch) and
 *                         prints each ix as "[DRY RUN] would ...". When State
 *                         does not exist yet the dependent diffs (hot roles,
 *                         oracle switch) cannot be read and are logged
 *                         generically. Receipt untouched.
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
  getAmmCachePublicKey,
  getPythLazerOraclePublicKey,
  getSpotMarketPublicKey,
  getVelocityStateAccountPublicKey,
  HotRole,
  loadKeypair,
  OracleSource,
  PythLazerSubscriber,
  SPOT_MARKET_RATE_PRECISION,
  SPOT_MARKET_WEIGHT_PRECISION,
  Wallet,
  ZERO,
} from '../packages/sdk/src';

// Mirrors programs/velocity/src/ids.rs::state_init_authority. On a real
// mainnet build `initialize` requires this exact signer.
const STATE_INIT_AUTHORITY = 'prpHJmuXnqdaz92tBVdwsqmqyhqPLuq5Km35a5QWco3';

const MAINNET_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

type Receipt = {
	cluster: string;
	programId: string;
	admin: string;
	quoteMint: string;
	state?: { pubkey: string; txSig?: string };
	ammCache?: { pubkey: string; txSig?: string };
	spotMarkets: Record<number, { pubkey: string; txSig?: string }>;
	pythLazerOracles: Record<number, { pubkey: string; txSig?: string }>;
	startedAt: string;
	finishedAt?: string;
};

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`missing env ${name}`);
	return v;
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

async function assertMint(
	connection: Connection,
	mint: PublicKey,
	label: string
) {
	const info = await connection.getAccountInfo(mint, 'confirmed');
	if (!info) throw new Error(`${label} ${mint.toBase58()} not found on cluster`);
	const owner = info.owner.toBase58();
	const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
	const token2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
	if (owner !== tokenProgram && owner !== token2022) {
		throw new Error(
			`${label} ${mint.toBase58()} is not a token mint (owner=${owner})`
		);
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

async function main() {
	const rpcUrl = requireEnv('RPC_URL');
	const adminPath = requireEnv('ADMIN_KEYPAIR');
	const pythLazerToken = requireEnv('PYTH_LAZER_TOKEN');
	const quoteLazerFeedId = Number(requireEnv('QUOTE_LAZER_FEED_ID'));
	if (!Number.isFinite(quoteLazerFeedId) || quoteLazerFeedId < 0) {
		throw new Error('QUOTE_LAZER_FEED_ID must be a non-negative integer');
	}
	const pythLazerEndpoints = (
		process.env.PYTH_LAZER_ENDPOINTS ??
		'wss://pyth-lazer.dourolabs.app/v1/stream'
	)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const pythLazerWaitMs = Number(process.env.PYTH_LAZER_WAIT_MS ?? 30_000);
	const quoteSymbol = process.env.QUOTE_SYMBOL ?? 'USDT';
	const receiptPath = path.resolve(
		process.cwd(),
		process.env.RECEIPT_PATH ?? 'deploy-scripts/out/mainnet-deployment.json'
	);
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });

	const config = configs['mainnet-beta'];
	const programId = new PublicKey(config.VELOCITY_PROGRAM_ID);
	const quoteMint = new PublicKey(process.env.QUOTE_MINT ?? MAINNET_USDT_MINT);
	const connection = new Connection(rpcUrl, 'confirmed');
	const keypair = loadKeypair(adminPath);
	const wallet = new Wallet(keypair);

	// Hot-role authorities. The native high-frequency cranks assert
	// signer == State.hot_<role> before doing work, so each role must hold the
	// key the corresponding bot signs with. Roles with a live mainnet keeper
	// default to that bot's wallet (the infrastructure-v3 gitops/prod
	// mainnet-beta bot wallets — the same set the gas-station bot tops up);
	// roles nothing signs yet default to the admin pubkey so a fresh State is
	// at least operable. Env vars override either way, and the phase is
	// idempotent so keys can be rotated by re-running.
	//
	// mm-oracle-cranker-bot-1 (internal-keeper-bot --mm-oracle-cranker):
	// signs the native mm-oracle crank.
	const MM_ORACLE_CRANKER_BOT_WALLET =
		'orc67EJyobz6pZuMUqgumoV6GgHkiWh42Wy5V9jpH8i';
	// rust-vamm-cranker-bot (vamm-crank): signs the native amm_spread_adjust
	// crank.
	const VAMM_CRANKER_BOT_WALLET =
		'RAmQrKiGsUhHeGubPmEC165fRKpL5J5jmbF85iCPk4w';
	// dlp-taker-bot / dlp-watcher-bot shared wallet: on mainnet the taker
	// signs LPTakerSwap / DepositProgramVault / LP Jupiter swaps with its own
	// keeper key (the external "lucy" signer is devnet-only).
	const DLP_TAKER_WATCHER_BOT_WALLET =
		'DtaKtiYKPLjjYksnD9hHtnxKKTcibDzLz7vDW5zdyn6Z';
	const hotDefault = keypair.publicKey;
	const HOT_ROLE_CONFIG: Array<{
		role: HotRole;
		field: string;
		pubkey: PublicKey;
	}> = [
		{ role: HotRole.MmOracleCrank, field: 'hotMmOracleCrank', pubkey: new PublicKey(process.env.HOT_MM_ORACLE_CRANK ?? MM_ORACLE_CRANKER_BOT_WALLET) },
		{ role: HotRole.AmmSpreadAdjust, field: 'hotAmmSpreadAdjust', pubkey: new PublicKey(process.env.HOT_AMM_SPREAD_ADJUST ?? VAMM_CRANKER_BOT_WALLET) },
		{ role: HotRole.LpSwap, field: 'hotLpSwap', pubkey: new PublicKey(process.env.HOT_LP_SWAP ?? DLP_TAKER_WATCHER_BOT_WALLET) },
		{ role: HotRole.LpCache, field: 'hotLpCache', pubkey: process.env.HOT_LP_CACHE ? new PublicKey(process.env.HOT_LP_CACHE) : hotDefault },
		{ role: HotRole.LpSettle, field: 'hotLpSettle', pubkey: process.env.HOT_LP_SETTLE ? new PublicKey(process.env.HOT_LP_SETTLE) : hotDefault },
		{ role: HotRole.AmmCrank, field: 'hotAmmCrank', pubkey: process.env.HOT_AMM_CRANK ? new PublicKey(process.env.HOT_AMM_CRANK) : hotDefault },
		{ role: HotRole.FeatureFlag, field: 'hotFeatureFlag', pubkey: process.env.HOT_FEATURE_FLAG ? new PublicKey(process.env.HOT_FEATURE_FLAG) : hotDefault },
		{ role: HotRole.Fuel, field: 'hotFuel', pubkey: process.env.HOT_FUEL ? new PublicKey(process.env.HOT_FUEL) : hotDefault },
		{ role: HotRole.UserFlag, field: 'hotUserFlag', pubkey: process.env.HOT_USER_FLAG ? new PublicKey(process.env.HOT_USER_FLAG) : hotDefault },
		{ role: HotRole.VaultDeposit, field: 'hotVaultDeposit', pubkey: process.env.HOT_VAULT_DEPOSIT ? new PublicKey(process.env.HOT_VAULT_DEPOSIT) : hotDefault },
		{ role: HotRole.FeeWithdraw, field: 'hotFeeWithdraw', pubkey: process.env.HOT_FEE_WITHDRAW ? new PublicKey(process.env.HOT_FEE_WITHDRAW) : hotDefault },
	];

	// Phase 0: pre-flight
	logStep('pre-flight checks');
	const programInfo = await connection.getAccountInfo(programId, 'confirmed');
	if (!programInfo || !programInfo.executable) {
		throw new Error(
			`velocity program ${programId.toBase58()} is not deployed/executable on ${rpcUrl}`
		);
	}
	await assertMint(connection, quoteMint, 'quote mint');
	const statePk = await getVelocityStateAccountPublicKey(programId);
	const stateExists = await pdaExists(connection, statePk);
	if (
		!stateExists &&
		keypair.publicKey.toBase58() !== STATE_INIT_AUTHORITY
	) {
		throw new Error(
			`State does not exist and ADMIN_KEYPAIR is ${keypair.publicKey.toBase58()}; ` +
				`a mainnet build locks initialize to the state init authority ${STATE_INIT_AUTHORITY} (ids.rs). ` +
				'Use that keypair.'
		);
	}
	const adminSol =
		(await connection.getBalance(keypair.publicKey, 'confirmed')) / 1e9;

	const hotDefaulted = HOT_ROLE_CONFIG.filter((h) =>
		h.pubkey.equals(hotDefault)
	).map((h) => h.role);
	await confirm('Proceed with this MAINNET configuration?', [
		...(DRY_RUN ? ['*** DRY RUN: no transactions will be sent ***', ''] : []),
		`cluster:      ${rpcUrl}`,
		`program:      ${programId.toBase58()} (executable ✓)`,
		`admin:        ${keypair.publicKey.toBase58()} (${adminSol.toFixed(4)} SOL)`,
		`quote mint:   ${quoteMint.toBase58()} (${quoteSymbol})`,
		`quote feed:   ${quoteLazerFeedId} (Pyth Lazer)`,
		`state:        ${stateExists ? 'exists (skipping init)' : 'will be created'}`,
		`receipt:      ${receiptPath}`,
		'',
		...HOT_ROLE_CONFIG.map(
			(h) => `hot ${String(h.role).padEnd(18)} ${h.pubkey.toBase58()}`
		),
		hotDefaulted.length > 0
			? `\n  WARNING: ${hotDefaulted.length} hot role(s) defaulting to the admin pubkey; set real keeper keys before bots go live.`
			: '',
		'',
		'NOTE: the signer becomes State.cold_admin. Verify the admin pubkey above.',
	]);

	const receipt: Receipt = {
		cluster: rpcUrl,
		programId: programId.toBase58(),
		admin: keypair.publicKey.toBase58(),
		quoteMint: quoteMint.toBase58(),
		spotMarkets: {},
		pythLazerOracles: {},
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

	// Phase A.1: global State
	await confirm('Begin Phase A: global State + hot roles + AmmCache?', [
		`State PDA: ${statePk.toBase58()}; quote_asset_mint = ${quoteMint.toBase58()}`,
	]);
	if (stateExists) {
		logStep('State already initialized', statePk.toBase58());
		receipt.state = { pubkey: statePk.toBase58() };
	} else if (DRY_RUN) {
		dryStep('initialize (global state)', statePk.toBase58());
	} else {
		logStep('initialize (global state)');
		const [txSig] = await client.initialize(quoteMint, false);
		receipt.state = { pubkey: statePk.toBase58(), txSig };
	}
	// in a dry run with no State the client cannot subscribe (nothing on chain)
	const clientSubscribed = stateExists || !DRY_RUN;
	if (clientSubscribed) {
		await client.subscribe();
	}
	writeReceipt();

	// Phase A.1b: native-crank authorities + feature flags
	// Freshly-initialized State is all zero, which makes every native crank
	// panic. Idempotent: only sends a tx when the on-chain value differs.
	if (!clientSubscribed) {
		// dry run against a fresh cluster: State is all zero after init, so
		// every value would be pushed
		dryStep('updateFeatureBitFlagsMMOracle(enable=true)');
		for (const { role, pubkey } of HOT_ROLE_CONFIG) {
			dryStep(`updateHotAdmin(${role})`, pubkey.toBase58());
		}
	} else {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const stateAcc = client.getStateAccount() as unknown as Record<string, any>;
		if ((Number(stateAcc.featureBitFlags) & 1) === 0) {
			if (DRY_RUN) {
				dryStep('updateFeatureBitFlagsMMOracle(enable=true)');
			} else {
				logStep('updateFeatureBitFlagsMMOracle(enable=true)');
				await client.updateFeatureBitFlagsMMOracle(true);
			}
		} else {
			logStep('mm-oracle feature bit already enabled');
		}
		for (const { role, field, pubkey } of HOT_ROLE_CONFIG) {
			const current = stateAcc[field] as PublicKey | undefined;
			if (!current || !current.equals(pubkey)) {
				if (DRY_RUN) {
					dryStep(`updateHotAdmin(${role})`, pubkey.toBase58());
				} else {
					logStep(`updateHotAdmin(${role})`, pubkey.toBase58());
					await client.updateHotAdmin(role, pubkey);
				}
			} else {
				logStep(`hot ${role} already set`, pubkey.toBase58());
			}
		}
	}

	// Phase A.2: AmmCache
	const ammCachePk = getAmmCachePublicKey(programId);
	if (await pdaExists(connection, ammCachePk)) {
		logStep('AmmCache already initialized', ammCachePk.toBase58());
		receipt.ammCache = { pubkey: ammCachePk.toBase58() };
	} else if (DRY_RUN) {
		dryStep('initializeAmmCache', ammCachePk.toBase58());
	} else {
		logStep('initializeAmmCache');
		const txSig = await client.initializeAmmCache();
		receipt.ammCache = { pubkey: ammCachePk.toBase58(), txSig };
	}
	writeReceipt();

	// Phase B: quote spot market at index 0
	// Program forces OracleSource::QuoteAsset for spot[0] at init; Phase E
	// switches it to PythLazerStableCoin afterwards. Collateral weights are the
	// 100% quote-market standard; the _mainnet_checklist item about collateral
	// weights concerns additional (non-quote) collateral markets, not this one.
	await confirm(`Begin Phase B: ${quoteSymbol} spot market at index 0?`, [
		`mint = ${quoteMint.toBase58()}`,
		`oracleSource = QUOTE_ASSET, assetTier = COLLATERAL, name = "${quoteSymbol}"`,
		'Creates spot_market_vault and insurance_fund_vault owned by velocity_signer.',
	]);
	const spot0Pk = await getSpotMarketPublicKey(programId, 0);
	const spot0Exists = await pdaExists(connection, spot0Pk);
	if (spot0Exists) {
		logStep(`Spot market 0 (${quoteSymbol}) already initialized`, spot0Pk.toBase58());
		receipt.spotMarkets[0] = { pubkey: spot0Pk.toBase58() };
	} else if (DRY_RUN) {
		dryStep(
			`initializeSpotMarket ${quoteSymbol} @ index 0`,
			`mint=${quoteMint.toBase58()} oracleSource=QUOTE_ASSET tier=COLLATERAL`
		);
	} else {
		logStep(`initializeSpotMarket ${quoteSymbol} @ index 0`);
		const txSig = await client.initializeSpotMarket(
			quoteMint,
			SPOT_MARKET_RATE_PRECISION.divn(2).toNumber(), // optimalUtilization 50%
			SPOT_MARKET_RATE_PRECISION.toNumber(), // optimalRate 100%
			SPOT_MARKET_RATE_PRECISION.toNumber(), // maxRate 100%
			PublicKey.default, // oracle (QUOTE_ASSET source -> default)
			OracleSource.QUOTE_ASSET,
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(), // initialAssetWeight
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(), // maintenanceAssetWeight
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(), // initialLiabilityWeight
			SPOT_MARKET_WEIGHT_PRECISION.toNumber(), // maintenanceLiabilityWeight
			0, // imfFactor
			0, // liquidatorFee
			0, // ifLiquidationFee
			true, // activeStatus
			AssetTier.COLLATERAL,
			ZERO, // scaleInitialAssetWeightStart
			ZERO, // withdrawGuardThreshold
			new BN(1), // orderTickSize
			new BN(1), // orderStepSize
			0, // ifTotalFactor
			quoteSymbol,
			0 // marketIndex
		);
		receipt.spotMarkets[0] = { pubkey: spot0Pk.toBase58(), txSig };
		await client.fetchAccounts();
	}
	writeReceipt();

	// Phase C: quote Pyth Lazer oracle PDA + initial price
	// Phase E's update_spot_market_oracle rejects an oracle that can't be read,
	// so the PDA needs a published price first.
	const quoteLazerPk = getPythLazerOraclePublicKey(programId, quoteLazerFeedId);
	await confirm(`Begin Phase C: quote Pyth Lazer oracle (feed ${quoteLazerFeedId})?`);
	if (await pdaExists(connection, quoteLazerPk)) {
		logStep(
			`Pyth Lazer oracle (feed ${quoteLazerFeedId}) already initialized`,
			quoteLazerPk.toBase58()
		);
		receipt.pythLazerOracles[quoteLazerFeedId] = {
			pubkey: quoteLazerPk.toBase58(),
		};
	} else if (DRY_RUN) {
		dryStep(
			`initializePythLazerOracle feed=${quoteLazerFeedId}`,
			quoteLazerPk.toBase58()
		);
	} else {
		logStep(`initializePythLazerOracle feed=${quoteLazerFeedId}`);
		const txSig = await client.initializePythLazerOracle(quoteLazerFeedId);
		receipt.pythLazerOracles[quoteLazerFeedId] = {
			pubkey: quoteLazerPk.toBase58(),
			txSig,
		};
	}
	{
		// fetch even in dry run: validates the relay token and feed id
		const messageHex = await fetchLazerMessageHex(
			pythLazerEndpoints,
			pythLazerToken,
			[quoteLazerFeedId],
			pythLazerWaitMs
		);
		if (DRY_RUN) {
			dryStep(
				`postPythLazerOracleUpdate feed=${quoteLazerFeedId}`,
				`message length = ${messageHex.length / 2}b`
			);
		} else {
			logStep(
				`postPythLazerOracleUpdate feed=${quoteLazerFeedId}`,
				`message length = ${messageHex.length / 2}b`
			);
			const sig = await client.postPythLazerOracleUpdate(
				[quoteLazerFeedId],
				messageHex
			);
			console.log(`  tx: ${sig}`);
		}
	}
	writeReceipt();

	// Phase E: switch quote spot market oracle to PythLazerStableCoin
	await confirm(
		`Begin Phase E: switch ${quoteSymbol} spot market oracle to PythLazerStableCoin?`,
		[
			`new oracle = ${quoteLazerPk.toBase58()} (feed ${quoteLazerFeedId})`,
			'Required because the program forces QuoteAsset at init for spot[0].',
		]
	);
	if (DRY_RUN && !spot0Exists) {
		// spot 0 would only be created by a real run; nothing to read
		dryStep(
			'updateSpotMarketOracle spot=0 -> PythLazerStableCoin',
			quoteLazerPk.toBase58()
		);
	} else {
		// the base client was constructed with spotMarketIndexes=[], so spin up a
		// one-shot client subscribed to spot[0] to read oracleSource/oracle.
		if (clientSubscribed) {
			await client.unsubscribe();
		}
		const phaseEClient = new AdminClient({
			connection,
			wallet,
			programID: programId,
			env: 'mainnet-beta',
			accountSubscription: { type: 'websocket', commitment: 'confirmed' },
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			oracleInfos: [],
			skipLoadUsers: true,
		});
		await phaseEClient.subscribe();
		const spot0 = phaseEClient.getSpotMarketAccount(0);
		if (!spot0) {
			throw new Error('spot market 0 not found after subscribe');
		}
		const alreadySwitched =
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(spot0.oracleSource as any)?.pythLazerStableCoin !== undefined &&
			spot0.oracle.equals(quoteLazerPk);
		if (alreadySwitched) {
			logStep(
				`${quoteSymbol} oracle already PythLazerStableCoin`,
				spot0.oracle.toBase58()
			);
		} else if (DRY_RUN) {
			dryStep(
				'updateSpotMarketOracle spot=0 -> PythLazerStableCoin',
				quoteLazerPk.toBase58()
			);
		} else {
			logStep(
				'updateSpotMarketOracle spot=0 -> PythLazerStableCoin',
				quoteLazerPk.toBase58()
			);
			const txSig = await phaseEClient.updateSpotMarketOracle(
				0,
				quoteLazerPk,
				OracleSource.PYTH_LAZER_STABLE_COIN
			);
			console.log(`  tx: ${txSig}`);
		}
		await phaseEClient.unsubscribe();
	}

	receipt.finishedAt = new Date().toISOString();
	writeReceipt();
	if (DRY_RUN) {
		console.log('\n[DRY RUN] complete; no transactions were sent.');
	} else {
		console.log(`\nreceipt written: ${receiptPath}`);
	}
	console.log(
		'\nNext: initialize perp markets: sh deploy-scripts/init-markets.sh'
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
