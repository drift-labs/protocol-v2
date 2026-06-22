/**
 * Devnet initialization runbook for the velocity program.
 *
 * Run AFTER `anchor deploy` has published the velocity and token_faucet programs
 * to devnet. Executes phases 0 + A–H:
 *
 *   0)  create dUSDT SPL mint + initialize token_faucet for distribution
 *   A)  global state + amm cache
 *   B)  dUSDT spot market at index 0 (oracle source forced to QuoteAsset by program)
 *   C)  Pyth Lazer SOL + USDT oracle PDAs (created empty)
 *   C+) post initial Pyth Lazer signed price update for SOL + USDT (one tx)
 *   C2) SOL spot market at index 1 (uses SOL Pyth Lazer oracle)
 *   D)  SOL-PERP at index 0 (uses SOL Pyth Lazer oracle)
 *   D2) repeg SOL-PERP so mark ≈ oracle (avoids funding 6251; fixes live market on rerun)
 *   E)  switch dUSDT spot market oracle to PythLazerStableCoin pointing at USDT lazer PDA
 *
 * Phase F below is an OPTIONAL follow-on. A minimal functional devnet deploy
 * is complete after Phase E. Skip it with SKIP_PHASE_F=1:
 *
 *   F)  LP pool + dUSDT constituent                     (optional)
 *
 * Idempotent: every phase checks whether its destination PDA already exists on
 * chain and skips if so. Safe to re-run after partial failure. Phase 0 reuses
 * the mint recorded in the receipt on re-runs.
 *
 * Required env:
 *   DEVNET_ADMIN          path to admin keypair file (becomes State.admin — immutable)
 *   SOL_LAZER_FEED_ID     Pyth Lazer u32 feed id for SOL/USD
 *   PYTH_LAZER_TOKEN      auth token for the Pyth Lazer relay (needed to post initial prices)
 * Optional env:
 *   USDT_LAZER_FEED_ID    Pyth Lazer u32 feed id for USDT/USD (default 8)
 *   PYTH_LAZER_ENDPOINTS  comma-separated WSS endpoints (default wss://pyth-lazer.dourolabs.app/v1/stream)
 *   PYTH_LAZER_WAIT_MS    milliseconds to wait for first price message (default 30000)
 *   USDT_MINT             existing devnet USDT SPL mint (6 decimals). If unset, a
 *                         fresh mint is created in Phase 0 and persisted to the
 *                         receipt; subsequent runs reuse it.
 *   USDT_MINT_KEYPAIR   path to keypair for the USDT mint (vanity address).
 *                       If unset, a random keypair is generated and saved next
 *                       to the receipt as usdt-mint.json.
 *   USDT_INITIAL_SUPPLY amount (whole tokens) to mint to admin before the
 *                       faucet takes over mint authority. Default 10_000_000.
 *   KEEPER_PUBKEYS      comma-separated keeper authority pubkeys to seed with
 *                       dUSDT (Phase K) so they can stake the insurance fund the
 *                       bid/ask-twap crank requires. Unset = skip Phase K.
 *   KEEPER_FUND_AMOUNT  whole dUSDT to send each keeper (default 1000).
 *   TOKEN_FAUCET_PROGRAM_ID  defaults to V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB.
 *   RPC_URL             default https://api.devnet.solana.com
 *   LP_POOL_ID          default 1 (id 0 is the sentinel "not in a pool")
 *   LP_MAX_AUM          default 1_000_000 USDT (in QUOTE_PRECISION units)
 *   RECEIPT_PATH        default deploy-scripts/out/devnet-deployment.json
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
	Connection,
	Keypair,
	PublicKey,
	SystemProgram,
	SYSVAR_RENT_PUBKEY,
	Transaction,
} from '@solana/web3.js';
import { BN, AnchorProvider, Program, Idl } from '@coral-xyz/anchor';
import {
	TOKEN_PROGRAM_ID,
	createMint,
	getAssociatedTokenAddress,
	createAssociatedTokenAccountInstruction,
	createMintToInstruction,
	createTransferInstruction,
} from '@solana/spl-token';
import tokenFaucetIdl from '../packages/sdk/src/idl/token_faucet.json';
import {
	AdminClient,
	AMM_RESERVE_PRECISION,
	AssetTier,
	BASE_PRECISION,
	ContractTier,
	HotRole,
	VELOCITY_DEVNET_PROGRAM_ID,
	OracleSource,
	PEG_PRECISION,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	PythLazerSubscriber,
	QUOTE_PRECISION,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	Wallet,
	ZERO,
	getAmmCachePublicKey,
	getConstituentPublicKey,
	getVelocityStateAccountPublicKey,
	getLpPoolPublicKey,
	getPerpMarketPublicKey,
	getPythLazerOraclePublicKey,
	getSpotMarketPublicKey,
	loadKeypair,
} from '../packages/sdk/src';
import type { InitializeConstituentParams } from '../packages/sdk/src/types';

type Receipt = {
	cluster: string;
	programId: string;
	admin: string;
	usdtMint: string;
	usdtMintKeypairPath?: string;
	usdtMintCreateTxSig?: string;
	usdtInitialSupplyTxSig?: string;
	tokenFaucet?: {
		programId: string;
		faucetConfig: string;
		mintAuthority: string;
		initTxSig?: string;
	};
	state?: { pubkey: string; txSig?: string };
	ammCache?: { pubkey: string; txSig?: string };
	spotMarkets: Record<number, { pubkey: string; txSig?: string }>;
	pythLazerOracles: Record<number, { pubkey: string; txSig?: string }>;
	perpMarkets: Record<number, { pubkey: string; txSig?: string }>;
	lpPool?: {
		id: number;
		pubkey: string;
		mint: string;
		txSig?: string;
	};
	constituents: Record<number, { pubkey: string; txSig?: string }>;
	startedAt: string;
	finishedAt?: string;
};

const TOKEN_FAUCET_DEFAULT_PROGRAM_ID =
	'V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB';
const USDT_DECIMALS = 6;
const WRAPPED_SOL_MINT = new PublicKey(
	'So11111111111111111111111111111111111111112'
);
// Devnet hot-admin authorities. The native high-frequency cranks assert
// signer == State.hot_<role> before doing work, so each role must hold the key
// the corresponding bot/keeper signs with or the crank panics. Values are the
// non-mainnet-beta keys from drift-labs/protocol-v2 ids.rs (the velocity bots
// reuse them). Roles with no dedicated wallet there default to admin_hot_wallet.
const ADMIN_HOT_WALLET = '1ucYHAGrBbi1PaecC4Ptq5ocZLWGLBmbGWysoDGNB1N';
const MM_ORACLE_CRANK_WALLET = '8X35rQUK2u9hfn8rMPwwr6ZSEUhbmfDPEapp589XyoM1';
const LP_POOL_SWAP_WALLET = '25qbsE2oWri76c9a86ubn17NKKdo6Am4HXD2Jm8vT8K4';
const LP_POOL_HOT_WALLET = 'GP9qHLX8rx4BgRULGPV1poWQPdGuzbxGbvTB12DfmwFk';

// HotRole -> (decoded-State field, authority). Each pubkey overridable via env.
const HOT_ROLE_CONFIG: Array<{
	role: HotRole;
	field: string;
	pubkey: PublicKey;
}> = [
	{ role: HotRole.MmOracleCrank, field: 'hotMmOracleCrank', pubkey: new PublicKey(process.env.HOT_MM_ORACLE_CRANK ?? MM_ORACLE_CRANK_WALLET) },
	{ role: HotRole.AmmSpreadAdjust, field: 'hotAmmSpreadAdjust', pubkey: new PublicKey(process.env.HOT_AMM_SPREAD_ADJUST ?? ADMIN_HOT_WALLET) },
	{ role: HotRole.LpSwap, field: 'hotLpSwap', pubkey: new PublicKey(process.env.HOT_LP_SWAP ?? LP_POOL_SWAP_WALLET) },
	{ role: HotRole.LpCache, field: 'hotLpCache', pubkey: new PublicKey(process.env.HOT_LP_CACHE ?? LP_POOL_HOT_WALLET) },
	{ role: HotRole.LpSettle, field: 'hotLpSettle', pubkey: new PublicKey(process.env.HOT_LP_SETTLE ?? LP_POOL_HOT_WALLET) },
	{ role: HotRole.AmmCrank, field: 'hotAmmCrank', pubkey: new PublicKey(process.env.HOT_AMM_CRANK ?? ADMIN_HOT_WALLET) },
	{ role: HotRole.FeatureFlag, field: 'hotFeatureFlag', pubkey: new PublicKey(process.env.HOT_FEATURE_FLAG ?? ADMIN_HOT_WALLET) },
	{ role: HotRole.Fuel, field: 'hotFuel', pubkey: new PublicKey(process.env.HOT_FUEL ?? ADMIN_HOT_WALLET) },
	{ role: HotRole.UserFlag, field: 'hotUserFlag', pubkey: new PublicKey(process.env.HOT_USER_FLAG ?? ADMIN_HOT_WALLET) },
	{ role: HotRole.VaultDeposit, field: 'hotVaultDeposit', pubkey: new PublicKey(process.env.HOT_VAULT_DEPOSIT ?? ADMIN_HOT_WALLET) },
	{ role: HotRole.FeeWithdraw, field: 'hotFeeWithdraw', pubkey: new PublicKey(process.env.HOT_FEE_WITHDRAW ?? ADMIN_HOT_WALLET) },
];

function getFaucetConfigPda(
	programId: PublicKey,
	mint: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('faucet_config'), mint.toBuffer()],
		programId
	)[0];
}

function getFaucetMintAuthorityPda(
	programId: PublicKey,
	mint: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('mint_authority'), mint.toBuffer()],
		programId
	)[0];
}

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
	console.log(`\n[${ts}] ${title}${note ? ` — ${note}` : ''}`);
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

async function assertMint(connection: Connection, mint: PublicKey, label: string) {
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

function tryLoadExistingReceipt(receiptPath: string): Receipt | null {
	try {
		const raw = fs.readFileSync(receiptPath, 'utf8');
		return JSON.parse(raw) as Receipt;
	} catch {
		return null;
	}
}

async function main() {
	const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
	const adminPath = requireEnv('DEVNET_ADMIN');
	const solLazerFeedId = Number(requireEnv('SOL_LAZER_FEED_ID'));
	if (!Number.isFinite(solLazerFeedId) || solLazerFeedId < 0) {
		throw new Error('SOL_LAZER_FEED_ID must be a non-negative integer');
	}
	const usdtLazerFeedId = Number(process.env.USDT_LAZER_FEED_ID ?? 8);
	if (!Number.isFinite(usdtLazerFeedId) || usdtLazerFeedId < 0) {
		throw new Error('USDT_LAZER_FEED_ID must be a non-negative integer');
	}
	// Posting prices is required because non-quote spot markets and perp markets
	// validate `get_oracle_price` succeeds at init, and `update_spot_market_oracle`
	// rejects an oracle that can't be read. PYTH_LAZER_TOKEN is mandatory.
	const pythLazerToken = requireEnv('PYTH_LAZER_TOKEN');
	const pythLazerEndpoints = (
		process.env.PYTH_LAZER_ENDPOINTS ??
		'wss://pyth-lazer.dourolabs.app/v1/stream'
	)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const pythLazerWaitMs = Number(process.env.PYTH_LAZER_WAIT_MS ?? 30_000);
	const lpPoolId = Number(process.env.LP_POOL_ID ?? 1);
	const lpMaxAum = new BN(process.env.LP_MAX_AUM ?? '1000000').mul(
		QUOTE_PRECISION
	);
	const receiptPath =
		process.env.RECEIPT_PATH ?? 'deploy-scripts/out/devnet-deployment.json';
	const absReceiptPath = path.resolve(process.cwd(), receiptPath);
	fs.mkdirSync(path.dirname(absReceiptPath), { recursive: true });

	const connection = new Connection(rpcUrl, 'confirmed');
	const keypair = loadKeypair(adminPath);
	const wallet = new Wallet(keypair);
	const programId = new PublicKey(VELOCITY_DEVNET_PROGRAM_ID);
	const tokenFaucetProgramId = new PublicKey(
		process.env.TOKEN_FAUCET_PROGRAM_ID ?? TOKEN_FAUCET_DEFAULT_PROGRAM_ID
	);

	// Resolve the USDT mint up-front: env > prior receipt > will be created in Phase 0.
	const existingReceipt = tryLoadExistingReceipt(absReceiptPath);
	let usdtMint: PublicKey | null = null;
	let usdtMintKeypair: Keypair | null = null;
	const usdtMintKeypairPath =
		process.env.USDT_MINT_KEYPAIR ??
		path.join(path.dirname(absReceiptPath), 'usdt-mint.json');
	if (process.env.USDT_MINT) {
		usdtMint = new PublicKey(process.env.USDT_MINT);
	} else if (existingReceipt?.usdtMint) {
		usdtMint = new PublicKey(existingReceipt.usdtMint);
	} else if (fs.existsSync(usdtMintKeypairPath)) {
		usdtMintKeypair = loadKeypair(usdtMintKeypairPath);
		usdtMint = usdtMintKeypair.publicKey;
	}
	const willCreateUsdt = usdtMint === null;

	console.log(`velocity program: ${programId.toBase58()}`);
	console.log(`faucet prog:   ${tokenFaucetProgramId.toBase58()}`);
	console.log(`rpc:           ${rpcUrl}`);
	console.log(`admin:         ${keypair.publicKey.toBase58()}`);
	console.log(
		`usdt mint:     ${usdtMint ? usdtMint.toBase58() : '(will create in Phase 0)'}`
	);
	console.log(`sol lazer fid: ${solLazerFeedId}`);
	console.log(`usdt lazer fid:${usdtLazerFeedId}`);
	console.log(`lazer endpoints: ${pythLazerEndpoints.join(',')}`);
	console.log(`lp pool id:    ${lpPoolId}`);

	// === Pre-flight: verify program + mint are live, show admin balance ===
	logStep('pre-flight checks');
	const programInfo = await connection.getAccountInfo(programId, 'confirmed');
	if (!programInfo || !programInfo.executable) {
		throw new Error(
			`velocity program ${programId.toBase58()} is not deployed/executable on ${rpcUrl}. Run \`anchor deploy\` first.`
		);
	}
	const faucetInfo = await connection.getAccountInfo(
		tokenFaucetProgramId,
		'confirmed'
	);
	if (!faucetInfo || !faucetInfo.executable) {
		throw new Error(
			`token_faucet program ${tokenFaucetProgramId.toBase58()} is not deployed/executable on ${rpcUrl}. Run \`anchor deploy\` for it first.`
		);
	}
	if (usdtMint) await assertMint(connection, usdtMint, 'USDT mint');
	const adminLamports = await connection.getBalance(
		keypair.publicKey,
		'confirmed'
	);
	const adminSol = adminLamports / 1e9;

	const usdtInitialSupplyWhole = new BN(
		process.env.USDT_INITIAL_SUPPLY ?? '10000000'
	);

	await confirm('Proceed with this configuration?', [
		`cluster:        ${rpcUrl}`,
		`velocity program:  ${programId.toBase58()} (executable ✓)`,
		`faucet program: ${tokenFaucetProgramId.toBase58()} (executable ✓)`,
		`admin:          ${keypair.publicKey.toBase58()} (${adminSol.toFixed(4)} SOL)`,
		`USDT mint:      ${
			usdtMint ? `${usdtMint.toBase58()}${willCreateUsdt ? ' (to be created)' : ' (token mint ✓)'}` : '(to be created)'
		}`,
		`USDT supply:    ${usdtInitialSupplyWhole.toString()} tokens pre-mint to admin (before faucet takes authority)`,
		`SOL Lazer feed: ${solLazerFeedId}`,
		`USDT Lazer feed:${usdtLazerFeedId}`,
		`Lazer endpoints:${pythLazerEndpoints.join(',')}`,
		`LP pool id:     ${lpPoolId}`,
		`LP max AUM:     ${lpMaxAum.toString()} (raw, QUOTE_PRECISION units)`,
		`receipt path:   ${receiptPath}`,
		'',
		'NOTE: State.admin is set IMMUTABLY in Phase A. Verify the admin pubkey above.',
	]);

	const receipt: Receipt = {
		cluster: rpcUrl,
		programId: programId.toBase58(),
		admin: keypair.publicKey.toBase58(),
		usdtMint: usdtMint ? usdtMint.toBase58() : '',
		spotMarkets: {},
		pythLazerOracles: {},
		perpMarkets: {},
		constituents: {},
		startedAt: new Date().toISOString(),
	};

	// === Phase 0: dUSDT SPL mint + token_faucet distribution wiring ===
	// "dUSDT" is the on-chain ticker for the devnet quote token (controlled by us
	// via the token_faucet). Internal identifiers stay `usdt*` for brevity.
	await confirm(
		'Begin Phase 0 — create dUSDT SPL mint + initialize token_faucet?',
		[
			willCreateUsdt
				? `A fresh 6-decimal dUSDT mint will be created; keypair saved to ${usdtMintKeypairPath}`
				: `Using existing mint ${usdtMint!.toBase58()}`,
			`Admin will receive ${usdtInitialSupplyWhole.toString()} dUSDT (pre-faucet), then mint authority is transferred to the token_faucet PDA.`,
			'After Phase 0 anyone can call token_faucet.mint_to_user to receive devnet dUSDT.',
		]
	);

	if (willCreateUsdt) {
		if (!usdtMintKeypair) {
			if (fs.existsSync(usdtMintKeypairPath)) {
				usdtMintKeypair = loadKeypair(usdtMintKeypairPath);
			} else {
				usdtMintKeypair = Keypair.generate();
				fs.writeFileSync(
					usdtMintKeypairPath,
					JSON.stringify(Array.from(usdtMintKeypair.secretKey))
				);
				console.log(`saved USDT mint keypair: ${usdtMintKeypairPath}`);
			}
		}
		const existing = await connection.getAccountInfo(
			usdtMintKeypair.publicKey,
			'confirmed'
		);
		if (existing) {
			logStep(
				'dUSDT mint already on chain',
				usdtMintKeypair.publicKey.toBase58()
			);
		} else {
			logStep('create dUSDT SPL mint (6 decimals)');
			const mintPk = await createMint(
				connection,
				keypair,
				keypair.publicKey, // initial mint authority = admin (needed to pre-mint + initialize faucet)
				null, // no freeze authority
				USDT_DECIMALS,
				usdtMintKeypair
			);
			console.log(`  mint: ${mintPk.toBase58()}`);
		}
		usdtMint = usdtMintKeypair.publicKey;
		receipt.usdtMint = usdtMint.toBase58();
		receipt.usdtMintKeypairPath = usdtMintKeypairPath;
	}

	// Pre-mint initial supply to admin (so admin can seed vaults / test wallets
	// without going through the faucet). Safe to re-run: creates the ATA if
	// needed and mints only when current authority is still the admin.
	{
		const adminAta = await getAssociatedTokenAddress(
			usdtMint!,
			keypair.publicKey
		);
		const ataInfo = await connection.getAccountInfo(adminAta, 'confirmed');
		const mintInfo = await connection.getParsedAccountInfo(
			usdtMint!,
			'confirmed'
		);
		const mintAuthority =
			(mintInfo.value?.data as any)?.parsed?.info?.mintAuthority ?? null;
		const adminIsAuthority =
			mintAuthority === keypair.publicKey.toBase58();
		if (adminIsAuthority && usdtInitialSupplyWhole.gtn(0)) {
			const amount = usdtInitialSupplyWhole.mul(
				new BN(10).pow(new BN(USDT_DECIMALS))
			);
			const tx = new Transaction();
			if (!ataInfo) {
				tx.add(
					createAssociatedTokenAccountInstruction(
						keypair.publicKey,
						adminAta,
						keypair.publicKey,
						usdtMint!
					)
				);
			}
			tx.add(
				createMintToInstruction(
					usdtMint!,
					adminAta,
					keypair.publicKey,
					BigInt(amount.toString())
				)
			);
			logStep(
				`mint ${usdtInitialSupplyWhole.toString()} dUSDT to admin ATA`,
				adminAta.toBase58()
			);
			const sig = await connection.sendTransaction(tx, [keypair]);
			await connection.confirmTransaction(sig, 'confirmed');
			receipt.usdtInitialSupplyTxSig = sig;
		} else {
			logStep(
				'skip admin pre-mint',
				adminIsAuthority
					? 'USDT_INITIAL_SUPPLY is 0'
					: 'admin is no longer mint authority (already transferred to faucet)'
			);
		}
	}

	// Initialize the token_faucet over the USDT mint. This SetAuthorities the
	// mint to the faucet's `mint_authority` PDA so anyone can call mint_to_user.
	{
		const faucetConfigPk = getFaucetConfigPda(tokenFaucetProgramId, usdtMint!);
		const faucetMintAuthorityPk = getFaucetMintAuthorityPda(
			tokenFaucetProgramId,
			usdtMint!
		);
		receipt.tokenFaucet = {
			programId: tokenFaucetProgramId.toBase58(),
			faucetConfig: faucetConfigPk.toBase58(),
			mintAuthority: faucetMintAuthorityPk.toBase58(),
		};
		if (await pdaExists(connection, faucetConfigPk)) {
			logStep(
				'token_faucet already initialized for this mint',
				faucetConfigPk.toBase58()
			);
		} else {
			logStep('token_faucet.initialize (transfers mint authority to faucet PDA)');
			const provider = new AnchorProvider(connection, wallet as any, {
				commitment: 'confirmed',
			});
			// Anchor 1.0 Program(idl, provider). IDL must carry the program address;
			// override the address field on a clone so we honor $TOKEN_FAUCET_PROGRAM_ID.
			const idlWithAddress = {
				...(tokenFaucetIdl as any),
				address: tokenFaucetProgramId.toBase58(),
			} as Idl;
			const faucetProgram = new Program(idlWithAddress, provider);
			const sig = await (faucetProgram.methods as any)
				.initialize()
				.accounts({
					faucetConfig: faucetConfigPk,
					admin: keypair.publicKey,
					mintAccount: usdtMint!,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				})
				.rpc();
			receipt.tokenFaucet.initTxSig = sig;
		}
	}

	// Persist an intermediate receipt before Phase A so the mint/faucet are
	// recorded even if a later phase fails.
	fs.writeFileSync(absReceiptPath, JSON.stringify(receipt, null, 2));

	if (!usdtMint) throw new Error('usdtMint not resolved after Phase 0');
	const quoteMint: PublicKey = usdtMint;

	// === Phase K: fund keeper wallet(s) with dUSDT ===
	// The bid/ask-twap crank requires keepers to hold a minimum insurance-fund
	// stake (>=1000 dUSDT — CantUpdatePerpBidAskTwap in keeper.rs). Seed each
	// keeper authority from the admin's pre-minted supply so the keeper bot can
	// stake on startup (the mark-twap-crank bot self-stakes via its
	// `autoStakeIfBelowMin` config). Skipped when KEEPER_PUBKEYS is unset.
	// Idempotent: skips a keeper already holding >= the fund amount.
	const keeperPubkeys = (process.env.KEEPER_PUBKEYS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => new PublicKey(s));
	const keeperFundWhole = new BN(process.env.KEEPER_FUND_AMOUNT ?? '1000');
	if (keeperPubkeys.length > 0) {
		await confirm(
			`Begin Phase K — fund ${keeperPubkeys.length} keeper wallet(s) with ${keeperFundWhole.toString()} dUSDT each?`,
			[
				`source: admin ATA (${keypair.publicKey.toBase58()})`,
				...keeperPubkeys.map((k) => `keeper: ${k.toBase58()}`),
			]
		);
		const fundAmount = keeperFundWhole.mul(
			new BN(10).pow(new BN(USDT_DECIMALS))
		);
		const adminAta = await getAssociatedTokenAddress(
			quoteMint,
			keypair.publicKey
		);
		for (const keeper of keeperPubkeys) {
			const keeperAta = await getAssociatedTokenAddress(quoteMint, keeper);
			const existing = await connection.getAccountInfo(keeperAta, 'confirmed');
			if (existing) {
				const bal = await connection.getTokenAccountBalance(
					keeperAta,
					'confirmed'
				);
				if (new BN(bal.value.amount).gte(fundAmount)) {
					logStep(
						`keeper ${keeper.toBase58()} already funded`,
						`${bal.value.uiAmountString ?? bal.value.amount} dUSDT`
					);
					continue;
				}
			}
			const tx = new Transaction();
			if (!existing) {
				tx.add(
					createAssociatedTokenAccountInstruction(
						keypair.publicKey,
						keeperAta,
						keeper,
						quoteMint
					)
				);
			}
			tx.add(
				createTransferInstruction(
					adminAta,
					keeperAta,
					keypair.publicKey,
					BigInt(fundAmount.toString())
				)
			);
			logStep(
				`fund keeper ${keeper.toBase58()} with ${keeperFundWhole.toString()} dUSDT`,
				keeperAta.toBase58()
			);
			const sig = await connection.sendTransaction(tx, [keypair]);
			await connection.confirmTransaction(sig, 'confirmed');
		}
	}

	const client = new AdminClient({
		connection,
		wallet,
		programID: programId,
		env: 'devnet',
		accountSubscription: { type: 'websocket', commitment: 'confirmed' },
		perpMarketIndexes: [],
		spotMarketIndexes: [],
		oracleInfos: [],
		skipLoadUsers: true,
	});

	await confirm('Begin Phase A — global State + AmmCache?', [
		`State PDA will be derived; quote_asset_mint = ${quoteMint.toBase58()}`,
		'AmmCache pre-allocates room for 16 perp markets (required before any perp init).',
	]);
	// === Phase A.1: global State ===
	const statePk = await getVelocityStateAccountPublicKey(programId);
	if (await pdaExists(connection, statePk)) {
		logStep('State already initialized', statePk.toBase58());
		receipt.state = { pubkey: statePk.toBase58() };
	} else {
		logStep('initialize (global state)');
		const [txSig] = await client.initialize(quoteMint, false);
		receipt.state = { pubkey: statePk.toBase58(), txSig };
	}

	// subscribe now that State exists; AdminClient method-level code paths
	// expect this.getStateAccount() to be hydrated for subsequent calls.
	await client.subscribe();

	// === Phase A.1b: native-crank authorities + feature flags ===
	// Native high-frequency cranks assert against State before doing any work, so
	// a freshly-initialized State (all zero) makes every crank panic:
	//   - mm-oracle (dispatcher opcode 0): gated on feature_bit_flags bit0 AND
	//     signer == hot_mm_oracle_crank
	//   - the rest: gated on signer == State.hot_<role>
	// Set every hot role to its devnet keeper authority and enable the mm-oracle
	// feature. Idempotent: reads the decoded State and only sends a tx when the
	// on-chain value differs, so re-running is a no-op.
	{
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const stateAcc = client.getStateAccount() as unknown as Record<string, any>;
		if ((Number(stateAcc.featureBitFlags) & 1) === 0) {
			logStep('updateFeatureBitFlagsMMOracle(enable=true)');
			await client.updateFeatureBitFlagsMMOracle(true);
		} else {
			logStep('mm-oracle feature bit already enabled');
		}
		for (const { role, field, pubkey } of HOT_ROLE_CONFIG) {
			const current = stateAcc[field] as PublicKey | undefined;
			if (!current || !current.equals(pubkey)) {
				logStep(`updateHotAdmin(${role})`, pubkey.toBase58());
				await client.updateHotAdmin(role, pubkey);
			} else {
				logStep(`hot ${role} already set`, pubkey.toBase58());
			}
		}
	}

	// === Phase A.2: AmmCache ===
	const ammCachePk = getAmmCachePublicKey(programId);
	if (await pdaExists(connection, ammCachePk)) {
		logStep('AmmCache already initialized', ammCachePk.toBase58());
		receipt.ammCache = { pubkey: ammCachePk.toBase58() };
	} else {
		logStep('initializeAmmCache');
		const txSig = await client.initializeAmmCache();
		receipt.ammCache = { pubkey: ammCachePk.toBase58(), txSig };
	}

	await confirm('Begin Phase B — dUSDT spot market at index 0?', [
		`mint = ${quoteMint.toBase58()}`,
		'oracleSource = QUOTE_ASSET, assetTier = COLLATERAL, name = "dUSDT"',
		'Creates spot_market_vault and insurance_fund_vault owned by velocity_signer.',
	]);
	// === Phase B: dUSDT spot market at index 0 ===
	const spot0Pk = await getSpotMarketPublicKey(programId, 0);
	if (await pdaExists(connection, spot0Pk)) {
		logStep('Spot market 0 (dUSDT) already initialized', spot0Pk.toBase58());
		receipt.spotMarkets[0] = { pubkey: spot0Pk.toBase58() };
	} else {
		logStep('initializeSpotMarket dUSDT @ index 0');
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
			ZERO,
			ZERO,
			new BN(1), // orderTickSize
			new BN(1), // orderStepSize
			0, // ifTotalFactor
			'dUSDT',
			0 // marketIndex
		);
		receipt.spotMarkets[0] = { pubkey: spot0Pk.toBase58(), txSig };
		await client.fetchAccounts();
	}

	await confirm('Begin Phase C — Pyth Lazer SOL + USDT oracles?', [
		`SOL feed id  = ${solLazerFeedId}`,
		`USDT feed id = ${usdtLazerFeedId} (used after init to switch dUSDT spot market)`,
		'Both PDAs are created empty here; prices are posted in the next phase.',
	]);
	// === Phase C: Pyth Lazer oracle PDAs (SOL + USDT) ===
	const lazerPk = getPythLazerOraclePublicKey(programId, solLazerFeedId);
	const usdtLazerPk = getPythLazerOraclePublicKey(programId, usdtLazerFeedId);
	for (const [feedId, pk, label] of [
		[solLazerFeedId, lazerPk, 'SOL'],
		[usdtLazerFeedId, usdtLazerPk, 'USDT'],
	] as const) {
		if (await pdaExists(connection, pk)) {
			logStep(
				`Pyth Lazer oracle (${label} feed ${feedId}) already initialized`,
				pk.toBase58()
			);
			receipt.pythLazerOracles[feedId] = { pubkey: pk.toBase58() };
		} else {
			logStep(`initializePythLazerOracle ${label} feed=${feedId}`);
			const txSig = await client.initializePythLazerOracle(feedId);
			receipt.pythLazerOracles[feedId] = {
				pubkey: pk.toBase58(),
				txSig,
			};
		}
	}

	// === Phase C+: post initial Pyth Lazer prices to both oracles ===
	// Required because:
	//   - Phase C2 (SOL spot market) calls `get_oracle_price` on the SOL oracle.
	//   - Phase D  (SOL-PERP)        calls `get_oracle_price` on the SOL oracle.
	//   - Phase E  (dUSDT switch)    calls `get_oracle_price` on the USDT oracle.
	// All three fail if the oracle account has no published price yet.
	await confirm(
		'Begin Phase C+ — post initial Pyth Lazer prices for SOL + USDT?',
		[
			`feeds = [${solLazerFeedId}, ${usdtLazerFeedId}]`,
			`subscribing to ${pythLazerEndpoints.join(', ')}`,
			`waiting up to ${pythLazerWaitMs}ms for first signed message`,
			'Posts a single tx that updates both PythLazerOracle PDAs.',
		]
	);
	{
		const feedIds = [solLazerFeedId, usdtLazerFeedId];
		// IMPORTANT: must include `feedUpdateTimestamp`. The on-chain
		// post_pyth_lazer_oracle_update silently skips messages without it
		// ("Skipping lazer price update. next_timestamp is None"). bestBid/Ask
		// feed the on-chain conf calculation; falls back to 20bps if absent.
		const subscriber = new PythLazerSubscriber(
			pythLazerEndpoints,
			pythLazerToken,
			[{ priceFeedIds: feedIds }],
			'devnet',
			2000,
			false,
			[
				'price',
				'bestAskPrice',
				'bestBidPrice',
				'exponent',
				'feedUpdateTimestamp',
			]
		);
		logStep('PythLazerSubscriber.subscribe()');
		await subscriber.subscribe();

		const deadline = Date.now() + pythLazerWaitMs;
		let messageHex: string | undefined;
		while (Date.now() < deadline) {
			const messages = Array.from(
				subscriber.feedIdChunkToPriceMessage.values()
			);
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
				`Timed out waiting ${pythLazerWaitMs}ms for a Pyth Lazer signed message for feeds [${feedIds.join(
					', '
				)}]. Check PYTH_LAZER_TOKEN and that ${pythLazerEndpoints.join(', ')} accepts it.`
			);
		}

		logStep(
			`postPythLazerOracleUpdate feeds=[${feedIds.join(',')}]`,
			`message length = ${messageHex.length / 2}b`
		);
		const postSig = await client.postPythLazerOracleUpdate(feedIds, messageHex);
		console.log(`  tx: ${postSig}`);
	}

	const skipPhaseC2 = process.env.SKIP_PHASE_C2 === '1';
	await confirm('Begin Phase C2 — SOL spot market at index 1?', [
		`mint = ${WRAPPED_SOL_MINT.toBase58()} (wSOL, 9 decimals)`,
		`oracle = ${lazerPk.toBase58()} (same PythLazerOracle PDA as SOL-PERP)`,
		'oracleSource = PYTH_LAZER, assetTier = CROSS, name = "SOL"',
		'weights: initAsset 80% / maintAsset 90% / initLiab 120% / maintLiab 110%',
		skipPhaseC2 ? '*** SKIP_PHASE_C2=1 set — phase will be SKIPPED ***' : '',
	]);
	// === Phase C2: SOL spot market at index 1 ===
	const spot1Pk = await getSpotMarketPublicKey(programId, 1);
	if (skipPhaseC2) {
		logStep(
			'Spot market 1 (SOL) SKIPPED via SKIP_PHASE_C2=1',
			spot1Pk.toBase58()
		);
	} else if (await pdaExists(connection, spot1Pk)) {
		logStep('Spot market 1 (SOL) already initialized', spot1Pk.toBase58());
		receipt.spotMarkets[1] = { pubkey: spot1Pk.toBase58() };
	} else {
		logStep('initializeSpotMarket SOL @ index 1 (Pyth Lazer)');
		const txSig = await client.initializeSpotMarket(
			WRAPPED_SOL_MINT,
			SPOT_MARKET_RATE_PRECISION.divn(2).toNumber(), // optimalUtilization 50%
			SPOT_MARKET_RATE_PRECISION.toNumber(), // optimalRate 100%
			SPOT_MARKET_RATE_PRECISION.toNumber(), // maxRate 100%
			lazerPk, // oracle = same PythLazerOracle PDA used by SOL-PERP
			OracleSource.PYTH_LAZER,
			SPOT_MARKET_WEIGHT_PRECISION.muln(8).divn(10).toNumber(), // initialAssetWeight 80%
			SPOT_MARKET_WEIGHT_PRECISION.muln(9).divn(10).toNumber(), // maintenanceAssetWeight 90%
			SPOT_MARKET_WEIGHT_PRECISION.muln(12).divn(10).toNumber(), // initialLiabilityWeight 120%
			SPOT_MARKET_WEIGHT_PRECISION.muln(11).divn(10).toNumber(), // maintenanceLiabilityWeight 110%
			0, // imfFactor
			0, // liquidatorFee
			0, // ifLiquidationFee
			true, // activeStatus
			AssetTier.CROSS as any,
			ZERO,
			ZERO,
			new BN(100), // orderTickSize
			new BN(1_000_000), // orderStepSize (0.001 SOL @ 9 decimals)
			0, // ifTotalFactor
			'SOL',
			1 // marketIndex
		);
		receipt.spotMarkets[1] = { pubkey: spot1Pk.toBase58(), txSig };
		await client.fetchAccounts();
	}

	const skipPhaseD = process.env.SKIP_PHASE_D === '1';
	await confirm('Begin Phase D — SOL-PERP at index 0?', [
		`oracle = ${lazerPk.toBase58()} (PythLazerOracle PDA)`,
		'AMM seed reserves = 1000 * AMM_RESERVE_PRECISION (placeholder; tune pre-mainnet).',
		'marginRatioInitial = 20%, marginRatioMaintenance = 5%, contractTier = SPECULATIVE.',
		'lpPoolId = 0 (not in a pool yet).',
		skipPhaseD ? '*** SKIP_PHASE_D=1 set — phase will be SKIPPED ***' : '',
	]);
	// === Phase D: SOL-PERP at index 0 ===
	const perp0Pk = await getPerpMarketPublicKey(programId, 0);
	if (skipPhaseD) {
		logStep(
			'Perp market 0 (SOL-PERP) SKIPPED via SKIP_PHASE_D=1',
			perp0Pk.toBase58()
		);
	} else if (await pdaExists(connection, perp0Pk)) {
		logStep('Perp market 0 (SOL-PERP) already initialized', perp0Pk.toBase58());
		receipt.perpMarkets[0] = { pubkey: perp0Pk.toBase58() };
	} else {
		logStep('initializePerpMarket SOL-PERP @ index 0 (Pyth Lazer)');
		const txSig = await client.initializePerpMarket(
			0,
			lazerPk,
			AMM_RESERVE_PRECISION.muln(1000), // baseAssetReserve — placeholder; tune pre-mainnet
			AMM_RESERVE_PRECISION.muln(1000), // quoteAssetReserve
			new BN(60 * 60), // periodicity: 1 hour
			PEG_PRECISION,
			OracleSource.PYTH_LAZER,
			ContractTier.SPECULATIVE,
			2000, // marginRatioInitial 20%
			500, // marginRatioMaintenance 5%
			0, // liquidatorFee
			10000, // ifLiquidatorFee
			0, // imfFactor
			true, // activeStatus
			0, // baseSpread
			142500, // maxSpread
			ZERO, // maxOpenInterest (0 = unlimited)
			ZERO, // maxRevenueWithdrawPerPeriod
			ZERO, // quoteMaxInsurance
			BASE_PRECISION.divn(10000),
			PRICE_PRECISION.divn(100000),
			BASE_PRECISION.divn(10000),
			undefined, // concentrationCoefScale -> default ONE
			0, // curveUpdateIntensity
			0, // ammJitIntensity
			'SOL-PERP',
			0 // lpPoolId (not in a pool)
		);
		receipt.perpMarkets[0] = { pubkey: perp0Pk.toBase58(), txSig };
		await client.fetchAccounts();
	}

	// === Phase D2: repeg SOL-PERP to the oracle price ===
	// Phase D seeds the AMM with placeholder reserves -> mark price = $1. The
	// program blocks funding updates when mark diverges too far from the oracle
	// (math/oracle.rs block_operation -> FundingWasNotUpdated / 6251). Repeg the
	// curve so mark ≈ oracle. With base==quote reserves mark == peg; in general
	// peg = oracle * base / quote yields mark == oracle. Idempotent (skips when
	// already within 1%), and runs whether the market was just created or already
	// existed — so a rerun fixes a live placeholder market.
	if (!skipPhaseD) {
		await confirm('Begin Phase D2 — repeg SOL-PERP to oracle price?', [
			'Reads the SOL oracle and repegs the AMM so mark ≈ oracle.',
			'No-op if mark is already within 1% of the oracle.',
		]);
		await client.unsubscribe();
		const repegClient = new AdminClient({
			connection,
			wallet,
			programID: programId,
			env: 'devnet',
			accountSubscription: { type: 'websocket', commitment: 'confirmed' },
			perpMarketIndexes: [0],
			spotMarketIndexes: [],
			oracleInfos: [{ publicKey: lazerPk, source: OracleSource.PYTH_LAZER }],
			skipLoadUsers: true,
		});
		await repegClient.subscribe();
		const pm = repegClient.getPerpMarketAccount(0);
		if (!pm) {
			throw new Error('perp market 0 not found after subscribe');
		}
		const oraclePrice = repegClient.getOracleDataForPerpMarket(0).price;
		const markPrice = pm.amm.quoteAssetReserve
			.mul(pm.amm.pegMultiplier)
			.div(pm.amm.baseAssetReserve);
		const tolerance = oraclePrice.divn(100); // 1%
		if (oraclePrice.lten(0)) {
			logStep('Phase D2 skipped — oracle price unavailable/zero');
		} else if (markPrice.sub(oraclePrice).abs().lte(tolerance)) {
			logStep(
				'SOL-PERP mark already within 1% of oracle; skip repeg',
				`mark=${markPrice.toString()} oracle=${oraclePrice.toString()}`
			);
		} else {
			const newPeg = oraclePrice
				.mul(pm.amm.baseAssetReserve)
				.div(pm.amm.quoteAssetReserve);
			logStep(
				'repegAmmCurve SOL-PERP -> oracle',
				`newPeg=${newPeg.toString()} (oracle=${oraclePrice.toString()}, oldPeg=${pm.amm.pegMultiplier.toString()}, mark=${markPrice.toString()})`
			);
			const sig = await repegClient.repegAmmCurve(newPeg, 0);
			console.log(`  tx: ${sig}`);
		}
		await repegClient.unsubscribe();
		await client.subscribe();
	}

	// === Phase E: switch dUSDT spot market oracle to PythLazerStableCoin ===
	// The program forces quote spot market init with OracleSource::QuoteAsset
	// (admin.rs:217-228). After init we switch via update_spot_market_oracle so
	// downstream code paths that expect a stable-coin oracle work. Required for
	// a functional dUSDT spot market — run immediately after Phase D so the
	// optional Phases F–H below operate against the final oracle config.
	// Idempotent: re-runs detect the existing source and skip.
	const skipPhaseE = process.env.SKIP_PHASE_E === '1';
	await confirm(
		'Begin Phase E — switch dUSDT spot market oracle to PythLazerStableCoin?',
		[
			`new oracle = ${usdtLazerPk.toBase58()} (USDT Pyth Lazer PDA, feed ${usdtLazerFeedId})`,
			'oracleSource = PYTH_LAZER_STABLE_COIN',
			'Required because the program forces QuoteAsset at init for spot[0]; this is the post-init swap.',
			skipPhaseE ? '*** SKIP_PHASE_E=1 set — phase will be SKIPPED ***' : '',
		]
	);
	if (skipPhaseE) {
		logStep('dUSDT oracle switch SKIPPED via SKIP_PHASE_E=1');
	} else {
		// `client` was constructed with spotMarketIndexes=[], so it doesn't carry
		// the spot[0] account we need to read `oracleSource`/`oracle` from. Spin up
		// a one-shot client subscribed to spot[0] (mirrors Phase F.2's pattern).
		await client.unsubscribe();
		const phaseEClient = new AdminClient({
			connection,
			wallet,
			programID: programId,
			env: 'devnet',
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
		// OracleSource is a tagged variant; pythLazerStableCoin tag means already-switched.
		const alreadySwitched =
			(spot0.oracleSource as any)?.pythLazerStableCoin !== undefined &&
			spot0.oracle.equals(usdtLazerPk);
		if (alreadySwitched) {
			logStep(
				'dUSDT oracle already PythLazerStableCoin',
				spot0.oracle.toBase58()
			);
		} else {
			logStep(
				'updateSpotMarketOracle spot=0 -> PythLazerStableCoin',
				usdtLazerPk.toBase58()
			);
			const txSig = await phaseEClient.updateSpotMarketOracle(
				0,
				usdtLazerPk,
				OracleSource.PYTH_LAZER_STABLE_COIN
			);
			console.log(`  tx: ${txSig}`);
		}
		await phaseEClient.unsubscribe();
		await client.subscribe();
	}

	// Phase F below is an optional follow-on. A minimal devnet deploy is
	// complete after Phase E. Set SKIP_PHASE_F=1 to bypass it; the receipt
	// still gets written.

	const skipPhaseF = process.env.SKIP_PHASE_F === '1';
	await confirm('Begin Phase F — LP pool + USDT constituent? (optional)', [
		`lpPoolId = ${lpPoolId}`,
		`maxAum = ${lpMaxAum.toString()} (raw, QUOTE_PRECISION units)`,
		'A fresh 6-decimal LP token mint is generated; authority = LP pool PDA.',
		'USDT (spot index 0) is added as the first constituent.',
		skipPhaseF ? '*** SKIP_PHASE_F=1 set — phase will be SKIPPED ***' : '',
	]);
	// === Phase F.1: LpPool (optional) ===
	const lpPoolPk = getLpPoolPublicKey(programId, lpPoolId);
	let lpMintPk: PublicKey | null = null;
	if (skipPhaseF) {
		logStep(`LpPool SKIPPED via SKIP_PHASE_F=1`, lpPoolPk.toBase58());
	} else if (await pdaExists(connection, lpPoolPk)) {
		logStep(`LpPool ${lpPoolId} already initialized`, lpPoolPk.toBase58());
		// recover the mint pubkey from the on-chain account so the receipt stays
		// correct on re-runs.
		try {
			const acct = await (client.program.account as any).lpPool.fetch(lpPoolPk);
			lpMintPk = acct.mint as PublicKey;
		} catch (_) {
			/* leave null if fetch fails */
		}
		receipt.lpPool = {
			id: lpPoolId,
			pubkey: lpPoolPk.toBase58(),
			mint: lpMintPk ? lpMintPk.toBase58() : '',
		};
	} else {
		const mintKp = Keypair.generate();
		lpMintPk = mintKp.publicKey;
		logStep(
			`initializeLpPool id=${lpPoolId}`,
			`lp mint=${mintKp.publicKey.toBase58()}`
		);
		const txSig = await client.initializeLpPool(
			lpPoolId,
			ZERO, // minMintFee
			lpMaxAum, // maxAum (QUOTE_PRECISION units)
			ZERO, // maxSettleQuoteAmountPerMarket (0 = no per-market cap)
			mintKp
		);
		receipt.lpPool = {
			id: lpPoolId,
			pubkey: lpPoolPk.toBase58(),
			mint: mintKp.publicKey.toBase58(),
			txSig,
		};
	}

	// === Phase F.2: dUSDT constituent (spot index 0) (optional) ===
	const constituent0Pk = getConstituentPublicKey(programId, lpPoolPk, 0);
	if (skipPhaseF) {
		logStep(
			`Constituent (pool=${lpPoolId}, spot=0) SKIPPED via SKIP_PHASE_F=1`,
			constituent0Pk.toBase58()
		);
	} else if (await pdaExists(connection, constituent0Pk)) {
		logStep(
			`Constituent (pool=${lpPoolId}, spot=0) already initialized`,
			constituent0Pk.toBase58()
		);
		receipt.constituents[0] = { pubkey: constituent0Pk.toBase58() };
	} else {
		// initializeConstituent reads spot market 0 from the websocket cache;
		// the initial subscribe used spotMarketIndexes=[] (markets didn't exist
		// yet) and the subscriber map is built at construction. Spin up a
		// fresh AdminClient with [0] for this call only.
		await client.unsubscribe();
		const constituentClient = new AdminClient({
			connection,
			wallet,
			programID: programId,
			env: 'devnet',
			accountSubscription: { type: 'websocket', commitment: 'confirmed' },
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			oracleInfos: [],
			skipLoadUsers: true,
		});
		await constituentClient.subscribe();
		logStep(`initializeConstituent pool=${lpPoolId} spot=0 (dUSDT)`);
		// param shape mirrors tests/lpPool.ts:392-404 (first constituent = USDT quote).
		const params: InitializeConstituentParams = {
			spotMarketIndex: 0,
			decimals: 6,
			maxWeightDeviation: new BN(10).mul(PERCENTAGE_PRECISION),
			swapFeeMin: new BN(1).mul(PERCENTAGE_PRECISION),
			swapFeeMax: new BN(2).mul(PERCENTAGE_PRECISION),
			maxBorrowTokenAmount: new BN(1_000_000).muln(10 ** 6),
			oracleStalenessThreshold: new BN(400),
			costToTrade: 1,
			derivativeWeight: ZERO,
			volatility: ZERO,
			constituentCorrelations: [], // no prior constituents to correlate against
		};
		const txSig = await constituentClient.initializeConstituent(
			lpPoolId,
			params
		);
		receipt.constituents[0] = { pubkey: constituent0Pk.toBase58(), txSig };
		await constituentClient.unsubscribe();
		await client.subscribe();
	}

	// === Persist receipt ===
	receipt.finishedAt = new Date().toISOString();
	fs.writeFileSync(absReceiptPath, JSON.stringify(receipt, null, 2));
	console.log(`\nreceipt written: ${absReceiptPath}`);

	await client.unsubscribe();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
