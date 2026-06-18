/**
 * Devnet escape hatch: closes velocity-owned PDAs whose on-chain layout no
 * longer matches the program (e.g. after a layout-breaking upgrade). Calls
 * the `force_wipe_accounts_devnet` ix, which:
 *   - reads State's first pubkey field at raw bytes 8..40 to gate on admin
 *     (works regardless of which State layout is currently on chain)
 *   - drains lamports out of every account passed in `remaining_accounts`
 *     (velocity-owned only), so the runtime garbage-collects them at end of tx.
 *
 * The ix is compiled into devnet builds only (`cfg(not(feature = "mainnet-beta"))`).
 *
 * Required env:
 *   DEVNET_ADMIN     path to admin keypair (must match the (cold_)admin recorded in State)
 * Optional env:
 *   RPC_URL          default https://api.devnet.solana.com
 *   RECEIPT_PATH     default deploy-scripts/out/devnet-deployment.json
 *   EXTRA_TARGETS    comma-separated pubkeys to also wipe (e.g. stray user accounts)
 *   DRY_RUN=1        print the targets that would be wiped and exit
 *   NON_INTERACTIVE=1 / YES=1  skip the confirmation prompt
 *
 * Re-run `init-devnet.sh` afterwards to recreate the state in the new layout.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
	Connection,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import velocityIdl from '../packages/sdk/src/idl/velocity.json';
import { Wallet, loadKeypair } from '../packages/sdk/src';

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const RECEIPT_PATH =
	process.env.RECEIPT_PATH ??
	path.join(__dirname, 'out', 'devnet-deployment.json');
const ADMIN_KEY = process.env.DEVNET_ADMIN;
const DRY_RUN = process.env.DRY_RUN === '1';
const NON_INTERACTIVE =
	process.env.NON_INTERACTIVE === '1' || process.env.YES === '1';

async function confirm(prompt: string): Promise<boolean> {
	if (NON_INTERACTIVE) {
		console.log(`${prompt} (NON_INTERACTIVE — proceeding)`);
		return true;
	}
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const ans = await new Promise<string>((res) =>
		rl.question(`${prompt} [y/N] `, res)
	);
	rl.close();
	return /^y(es)?$/i.test(ans.trim());
}

function collectReceiptTargets(
	receipt: Record<string, unknown>,
	programId: PublicKey
): { label: string; pubkey: PublicKey }[] {
	const out: { label: string; pubkey: PublicKey }[] = [];
	const pushIfPresent = (label: string, raw?: unknown) => {
		if (typeof raw === 'string' && raw.length > 0) {
			out.push({ label, pubkey: new PublicKey(raw) });
		}
	};

	pushIfPresent('state', (receipt.state as any)?.pubkey);
	pushIfPresent('ammCache', (receipt.ammCache as any)?.pubkey);
	pushIfPresent('lpPool', (receipt.lpPool as any)?.pubkey);
	pushIfPresent(
		'protectedMakerModeConfig',
		(receipt.protectedMakerModeConfig as any)?.pubkey
	);

	const perp =
		(receipt.perpMarkets as Record<string, { pubkey?: string }>) ?? {};
	for (const [idx, m] of Object.entries(perp)) {
		pushIfPresent(`perpMarket[${idx}]`, m?.pubkey);
	}
	const spot =
		(receipt.spotMarkets as Record<string, { pubkey?: string }>) ?? {};
	for (const [idx, m] of Object.entries(spot)) {
		pushIfPresent(`spotMarket[${idx}]`, m?.pubkey);
		// Each spot market also has two token-program-owned vaults (spot +
		// insurance fund) that survive a velocity-only wipe and block re-init.
		const idxLe = Buffer.from(new Uint16Array([Number(idx)]).buffer);
		const [spotVault] = PublicKey.findProgramAddressSync(
			[Buffer.from('spot_market_vault'), idxLe],
			programId
		);
		const [ifVault] = PublicKey.findProgramAddressSync(
			[Buffer.from('insurance_fund_vault'), idxLe],
			programId
		);
		out.push({ label: `spotMarketVault[${idx}]`, pubkey: spotVault });
		out.push({ label: `insuranceFundVault[${idx}]`, pubkey: ifVault });
	}
	const constituents =
		(receipt.constituents as Record<string, { pubkey?: string }>) ?? {};
	for (const [idx, c] of Object.entries(constituents)) {
		pushIfPresent(`constituent[${idx}]`, c?.pubkey);
	}
	const lazer =
		(receipt.pythLazerOracles as Record<string, { pubkey?: string }>) ?? {};
	for (const [feed, o] of Object.entries(lazer)) {
		pushIfPresent(`pythLazerOracle[feed=${feed}]`, o?.pubkey);
	}

	return out;
}

// Merge the live receipt with any archived `.wiped-*.json` siblings — those
// carry spot-market indices we already wiped but whose token vaults still leak.
function loadAllReceipts(activePath: string): Record<string, unknown>[] {
	const dir = path.dirname(activePath);
	const base = path.basename(activePath, '.json');
	const receipts: Record<string, unknown>[] = [];
	if (fs.existsSync(activePath)) {
		receipts.push(JSON.parse(fs.readFileSync(activePath, 'utf8')));
	}
	if (fs.existsSync(dir)) {
		for (const name of fs.readdirSync(dir)) {
			if (
				name.startsWith(`${base}.wiped-`) &&
				name.endsWith('.json') &&
				fs.statSync(path.join(dir, name)).isFile()
			) {
				try {
					receipts.push(
						JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
					);
				} catch {
					// ignore unparseable archives
				}
			}
		}
	}
	return receipts;
}

async function main() {
	if (!ADMIN_KEY) throw new Error('DEVNET_ADMIN env var required');
	if (!fs.existsSync(RECEIPT_PATH)) {
		throw new Error(`Receipt not found at ${RECEIPT_PATH}`);
	}
	const allReceipts = loadAllReceipts(RECEIPT_PATH);
	const activeReceipt = allReceipts[0];
	const programId = new PublicKey(activeReceipt.programId as string);

	const admin = loadKeypair(ADMIN_KEY);
	const connection = new Connection(RPC_URL, 'confirmed');
	const provider = new AnchorProvider(connection, new Wallet(admin), {
		commitment: 'confirmed',
	});
	const program = new Program(velocityIdl as Idl, provider);

	// velocity_signer PDA + nonce — needed to authorize SPL CloseAccount CPI.
	const [velocitySigner, velocitySignerNonce] = PublicKey.findProgramAddressSync(
		[Buffer.from('velocity_signer')],
		programId
	);

	// State for the admin gate. If the live receipt has it use that; otherwise
	// derive from PDA (same address across layouts).
	const statePubkey = (activeReceipt.state as any)?.pubkey
		? new PublicKey((activeReceipt.state as any).pubkey)
		: PublicKey.findProgramAddressSync(
				[Buffer.from('velocity_state')],
				programId
		  )[0];

	const seen = new Set<string>();
	const candidates: { label: string; pubkey: PublicKey }[] = [];
	for (const r of allReceipts) {
		for (const t of collectReceiptTargets(r, programId)) {
			if (!seen.has(t.pubkey.toBase58())) {
				seen.add(t.pubkey.toBase58());
				candidates.push(t);
			}
		}
	}

	const extra = (process.env.EXTRA_TARGETS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => ({ label: 'extra', pubkey: new PublicKey(s) }));
	candidates.push(...extra);

	// Filter: skip already-empty accounts. Token-program-owned vaults are
	// closed via CPI (after burning any token balance); velocity-owned accounts
	// are drained. Token vaults must be passed paired with their mint.
	const tokenVaults: {
		label: string;
		pubkey: PublicKey;
		mint: PublicKey;
	}[] = [];
	const velocityPdas: { label: string; pubkey: PublicKey }[] = [];
	for (const c of candidates) {
		const info = await connection.getAccountInfo(c.pubkey);
		if (!info) {
			console.log(`skip ${c.label} ${c.pubkey.toBase58()} (not on chain)`);
			continue;
		}
		if (info.owner.equals(TOKEN_PROGRAM_ID)) {
			// SPL token account: mint pubkey is bytes 0..32 of account data.
			const mint = new PublicKey(info.data.subarray(0, 32));
			tokenVaults.push({ label: c.label, pubkey: c.pubkey, mint });
			continue;
		}
		if (info.owner.equals(programId)) {
			velocityPdas.push({ label: c.label, pubkey: c.pubkey });
			continue;
		}
		console.log(
			`skip ${
				c.label
			} ${c.pubkey.toBase58()} (owned by ${info.owner.toBase58()}, not velocity or token program)`
		);
	}

	console.log('');
	console.log(`=== devnet wipe ===`);
	console.log(`  rpc        : ${RPC_URL}`);
	console.log(`  program    : ${programId.toBase58()}`);
	console.log(`  state      : ${statePubkey.toBase58()}`);
	console.log(`  admin      : ${admin.publicKey.toBase58()}`);
	console.log(`  token vaults (will burn + close):`);
	for (const t of tokenVaults) {
		console.log(
			`    - ${t.label.padEnd(
				28
			)} ${t.pubkey.toBase58()}  mint=${t.mint.toBase58()}`
		);
	}
	console.log(`  velocity PDAs (will drain lamports):`);
	for (const t of velocityPdas) {
		console.log(`    - ${t.label.padEnd(28)} ${t.pubkey.toBase58()}`);
	}

	if (tokenVaults.length === 0 && velocityPdas.length === 0) {
		console.log('Nothing to wipe.');
		return;
	}
	if (DRY_RUN) {
		console.log('DRY_RUN=1, exiting.');
		return;
	}
	if (!(await confirm('Wipe all targets above?'))) {
		console.log('aborted.');
		process.exit(1);
	}

	// Ix expects remaining_accounts as: (vault, mint), (vault, mint), …,
	// then velocity-owned PDAs. ~30 writable accounts fit in one legacy tx.
	type Rem = { pubkey: PublicKey; isSigner: false; isWritable: boolean };
	const remaining: Rem[] = [];
	for (const v of tokenVaults) {
		remaining.push({ pubkey: v.pubkey, isSigner: false, isWritable: true });
		remaining.push({ pubkey: v.mint, isSigner: false, isWritable: true });
	}
	for (const p of velocityPdas) {
		remaining.push({ pubkey: p.pubkey, isSigner: false, isWritable: true });
	}

	// One tx for now; expand to batching only if we ever exceed account limits.
	{
		const ix = await program.methods
			.forceWipeAccountsDevnet(velocitySignerNonce)
			.accountsStrict({
				admin: admin.publicKey,
				state: statePubkey,
				velocitySigner: velocitySigner,
				tokenProgram: TOKEN_PROGRAM_ID,
			})
			.remainingAccounts(remaining)
			.instruction();
		console.log(`  ix accounts (${ix.keys.length}):`);
		ix.keys.forEach((k, i) =>
			console.log(
				`    [${i}] ${k.pubkey.toBase58()}  w=${k.isWritable} s=${k.isSigner}`
			)
		);

		const recent = await connection.getLatestBlockhash('confirmed');
		const msg = new TransactionMessage({
			payerKey: admin.publicKey,
			recentBlockhash: recent.blockhash,
			instructions: [
				ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
				ix,
			],
		}).compileToV0Message();
		const tx = new VersionedTransaction(msg);
		tx.sign([admin]);

		console.log(
			`\nwiping ${tokenVaults.length} token vault(s) + ${velocityPdas.length} velocity PDA(s)…`
		);
		const sig = await connection.sendRawTransaction(tx.serialize(), {
			skipPreflight: false,
		});
		console.log(`  tx: ${sig}`);
		const conf = await connection.confirmTransaction(
			{ signature: sig, ...recent },
			'confirmed'
		);
		if (conf.value.err) {
			throw new Error(`wipe tx failed: ${JSON.stringify(conf.value.err)}`);
		}
		console.log(`  ✓ confirmed`);
	}

	// Sanity confirm: every target now has no on-chain account.
	console.log('\nverifying targets are gone…');
	for (const t of [...tokenVaults, ...velocityPdas]) {
		const info = await connection.getAccountInfo(t.pubkey);
		const status = info ? `STILL EXISTS (${info.lamports} lamports)` : 'gone';
		console.log(`  ${t.label.padEnd(28)} ${t.pubkey.toBase58()} — ${status}`);
	}

	// Archive the receipt — next init run will create a fresh one.
	const archived = RECEIPT_PATH.replace(
		/\.json$/,
		`.wiped-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
	);
	fs.renameSync(RECEIPT_PATH, archived);
	console.log(`\nReceipt archived → ${archived}`);
	console.log('Run deploy-scripts/init-devnet.sh to recreate state.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
