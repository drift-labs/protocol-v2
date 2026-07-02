import { Command } from 'commander';
import {
	Connection,
	Keypair,
	PublicKey,
	SystemProgram,
	SYSVAR_CLOCK_PUBKEY,
	SYSVAR_RENT_PUBKEY,
	Transaction,
	TransactionInstruction,
	TransactionMessage,
} from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as multisig from '@sqds/multisig';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient, buildProvider } from '../lib/provider';
import { reportDispatch, sendOrPropose } from '../lib/squads';

/** BPFLoaderUpgradeab1e11111111111111111111111 — Solana's upgradeable loader. */
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
	'BPFLoaderUpgradeab1e11111111111111111111111'
);

/**
 * ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S — the on-chain program-metadata
 * program (SIMD-0208). Our release pipeline publishes each program's IDL as a
 * program-metadata *buffer* owned by this program, alongside the BPF program
 * buffer; both need closing to reclaim rent.
 */
const PROGRAM_METADATA_PROGRAM_ID = new PublicKey(
	'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S'
);

/**
 * `UpgradeableLoaderState::Buffer` header: 4-byte enum tag + 1-byte `Option`
 * discriminant + 32-byte authority Pubkey = 37 bytes ahead of the bytecode.
 */
const BUFFER_HEADER_SIZE = 37;

/** Loader instruction discriminators (4-byte LE enum tags). */
const IX_INITIALIZE_BUFFER = Buffer.from([0, 0, 0, 0]);
const IX_WRITE = Buffer.from([1, 0, 0, 0]);
const IX_UPGRADE = Buffer.from([3, 0, 0, 0]);
const IX_SET_AUTHORITY = Buffer.from([4, 0, 0, 0]);
const IX_CLOSE = Buffer.from([5, 0, 0, 0]);

/** program-metadata `Close` instruction discriminator (single u8). */
const IX_METADATA_CLOSE = Buffer.from([6]);

/**
 * `UpgradeableLoaderState::Buffer` account layout, for a `getProgramAccounts`
 * memcmp: 4-byte enum tag `[1,0,0,0]` at offset 0, then `Option<Pubkey>`
 * authority — a 1-byte `Some`/`None` discriminant at offset 4, the 32-byte
 * authority Pubkey at offset 5.
 */
const BPF_BUFFER_TAG = Buffer.from([1, 0, 0, 0]);
const BPF_BUFFER_AUTHORITY_OFFSET = 5;

/**
 * program-metadata `Buffer` account layout: 1-byte `AccountDiscriminator`
 * (`Buffer` = 1) at offset 0, a 32-byte `Option<Address> program` (zeroes when
 * `None`) at offset 1, then the 32-byte `Option<Address> authority` at offset
 * 33.
 */
const METADATA_BUFFER_TAG = Buffer.from([1]);
const METADATA_BUFFER_AUTHORITY_OFFSET = 33;

/**
 * Outer-transaction size budget for a single Squads `vaultTransactionCreate` +
 * `proposalCreate`. The Solana packet limit is 1232 bytes; we pack close
 * instructions greedily until the measured outer tx would exceed this, then cut
 * a new proposal. Kept a touch under 1232 for signature/blockhash headroom.
 */
const OUTER_TX_SIZE_BUDGET = 1180;

/**
 * deanmlittle/sbpf-asm-abort `deploy/sbpf-asm-abort.so` (352 bytes). Replaces
 * the target program's bytecode so every subsequent invocation returns
 * `ProgramFailedToComplete`. Reproducible: pin this string to the upstream
 * `.so` SHA via `curl ... | base64`.
 */
const SBPF_ABORT_BASE64 =
	'f0VMRgIBAQAAAAAAAAAAAAMABwEBAAAAeAAAAAAAAABAAAAAAAAAAKAAAAAAAAAAAAAAAEAAOAABAEAAAwACAAEAAAAFAAAAeAAAAAAAAAB4AAAAAAAAAHgAAAAAAAAAGAAAAAAAAAAYAAAAAAAAAAgAAAAAAAAAGAAAAAEAAAAAAAAAAAAAAJUAAAAAAAAAAC50ZXh0AC5zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAQAAAAYAAAAAAAAAeAAAAAAAAAB4AAAAAAAAABgAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABwAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAkAAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAA==';

/** Max bytes per `Write` ix payload. Tx limit is 1232 B; reserve headroom. */
const WRITE_CHUNK_BYTES = 800;

function buildInitializeBufferIx(args: {
	buffer: PublicKey;
	authority: PublicKey;
}): TransactionInstruction {
	return new TransactionInstruction({
		programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
		keys: [
			{ pubkey: args.buffer, isSigner: false, isWritable: true },
			{ pubkey: args.authority, isSigner: false, isWritable: false },
		],
		data: IX_INITIALIZE_BUFFER,
	});
}

function buildWriteIx(args: {
	buffer: PublicKey;
	authority: PublicKey;
	offset: number;
	bytes: Buffer;
}): TransactionInstruction {
	const offset = Buffer.alloc(4);
	offset.writeUInt32LE(args.offset, 0);
	const len = Buffer.alloc(4);
	len.writeUInt32LE(args.bytes.length, 0);
	return new TransactionInstruction({
		programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
		keys: [
			{ pubkey: args.buffer, isSigner: false, isWritable: true },
			{ pubkey: args.authority, isSigner: true, isWritable: false },
		],
		data: Buffer.concat([IX_WRITE, offset, len, args.bytes]),
	});
}

function buildSetBufferAuthorityIx(args: {
	buffer: PublicKey;
	currentAuthority: PublicKey;
	newAuthority: PublicKey;
}): TransactionInstruction {
	return new TransactionInstruction({
		programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
		keys: [
			{ pubkey: args.buffer, isSigner: false, isWritable: true },
			{ pubkey: args.currentAuthority, isSigner: true, isWritable: false },
			{ pubkey: args.newAuthority, isSigner: false, isWritable: false },
		],
		data: IX_SET_AUTHORITY,
	});
}

function buildUpgradeIx(args: {
	programId: PublicKey;
	buffer: PublicKey;
	authority: PublicKey;
	spill: PublicKey;
}): TransactionInstruction {
	const [programData] = PublicKey.findProgramAddressSync(
		[args.programId.toBuffer()],
		BPF_LOADER_UPGRADEABLE_PROGRAM_ID
	);
	return new TransactionInstruction({
		programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
		keys: [
			{ pubkey: programData, isSigner: false, isWritable: true },
			{ pubkey: args.programId, isSigner: false, isWritable: true },
			{ pubkey: args.buffer, isSigner: false, isWritable: true },
			{ pubkey: args.spill, isSigner: false, isWritable: true },
			{ pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
			{ pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
			{ pubkey: args.authority, isSigner: true, isWritable: false },
		],
		data: IX_UPGRADE,
	});
}

/**
 * BPFLoaderUpgradeable `Close` for a *buffer* account (3 accounts, no program
 * account). Sends the buffer's rent lamports to `recipient` and zeroes it.
 * `authority` must be the buffer's current authority and signs.
 */
function buildCloseBufferIx(args: {
	buffer: PublicKey;
	recipient: PublicKey;
	authority: PublicKey;
}): TransactionInstruction {
	return new TransactionInstruction({
		programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
		keys: [
			{ pubkey: args.buffer, isSigner: false, isWritable: true },
			{ pubkey: args.recipient, isSigner: false, isWritable: true },
			{ pubkey: args.authority, isSigner: true, isWritable: false },
		],
		data: IX_CLOSE,
	});
}

/**
 * program-metadata `Close` for a standalone metadata *buffer*. The `program`
 * and `programData` accounts are optional and only supplied when closing a
 * canonical (program-associated) metadata PDA; for a loose buffer they are
 * omitted, which the program-metadata client encodes as the program address
 * itself in those two slots. `authority` signs.
 */
function buildCloseMetadataBufferIx(args: {
	buffer: PublicKey;
	recipient: PublicKey;
	authority: PublicKey;
}): TransactionInstruction {
	return new TransactionInstruction({
		programId: PROGRAM_METADATA_PROGRAM_ID,
		keys: [
			{ pubkey: args.buffer, isSigner: false, isWritable: true },
			{ pubkey: args.authority, isSigner: true, isWritable: false },
			// program / programData placeholders (None) — the program id itself.
			{
				pubkey: PROGRAM_METADATA_PROGRAM_ID,
				isSigner: false,
				isWritable: false,
			},
			{
				pubkey: PROGRAM_METADATA_PROGRAM_ID,
				isSigner: false,
				isWritable: false,
			},
			{ pubkey: args.recipient, isSigner: false, isWritable: true },
		],
		data: IX_METADATA_CLOSE,
	});
}

/** A single buffer discovered on-chain, with its type and reclaimable rent. */
type DiscoveredBuffer = {
	address: PublicKey;
	kind: 'program' | 'metadata';
	lamports: number;
};

/**
 * Find every buffer of `kind` whose authority is `authority`, via a
 * `getProgramAccounts` memcmp. `dataSlice` length 0 keeps us from downloading
 * multi-MB bytecode — we only need each buffer's address and lamports.
 */
async function findBuffers(
	connection: Connection,
	kind: 'program' | 'metadata',
	authority: PublicKey
): Promise<DiscoveredBuffer[]> {
	const programId =
		kind === 'program'
			? BPF_LOADER_UPGRADEABLE_PROGRAM_ID
			: PROGRAM_METADATA_PROGRAM_ID;
	const tag = kind === 'program' ? BPF_BUFFER_TAG : METADATA_BUFFER_TAG;
	const authorityOffset =
		kind === 'program'
			? BPF_BUFFER_AUTHORITY_OFFSET
			: METADATA_BUFFER_AUTHORITY_OFFSET;

	const accounts = await connection.getProgramAccounts(programId, {
		dataSlice: { offset: 0, length: 0 },
		filters: [
			{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(tag) } },
			{ memcmp: { offset: authorityOffset, bytes: authority.toBase58() } },
		],
	});

	return accounts.map(({ pubkey, account }) => ({
		address: pubkey,
		kind,
		lamports: account.lamports,
	}));
}

export function registerProgram(parent: Command): void {
	const prog = parent
		.command('program')
		.description(
			'Manage the on-chain velocity program itself (upgrade authority operations).'
		);

	withGlobalOptions(
		prog
			.command('halt')
			.description(
				[
					'Emergency-halt: deploy sbpf-asm-abort.so to a fresh buffer and propose',
					'a BPFLoaderUpgradeable::upgrade swapping velocity bytecode for it.',
					'After execution every velocity instruction fails with',
					'ProgramFailedToComplete until the upgrade authority redeploys real',
					'bytecode.',
					'',
					'Flow (the wallet pays rent for buffer setup; only the upgrade itself',
					'is multisig-gated):',
					'  1) create + initialize buffer (wallet signs, wallet is initial buffer authority)',
					'  2) write the 352-byte abort bytecode (wallet signs)',
					'  3) if --multisig: transfer buffer authority to the vault PDA so the',
					'     proposed upgrade can sign as it (wallet signs)',
					'  4) propose / send the upgrade ix (multisig vault or wallet signs)',
					'',
					'The buffer keypair is written to ./halt-buffer-<short>.json so it can be',
					'closed for rent recovery later.',
				].join('\n')
			)
			.option(
				'--so <path>',
				'override the bundled sbpf-asm-abort.so with a local .so file'
			)
			.option(
				'--upgrade-authority <pubkey>',
				'overrides the upgrade authority signer (defaults to the multisig vault, or the wallet when --multisig is absent)'
			)
			.option(
				'--spill <pubkey>',
				'recipient for reclaimed buffer rent on upgrade (defaults to the upgrade authority)'
			)
			.option(
				'--buffer-out <path>',
				'where to write the new buffer keypair (defaults to ./halt-buffer-<short>.json in cwd)'
			)
	).action(async (_flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const local = cmd.opts() as {
			so?: string;
			upgradeAuthority?: string;
			spill?: string;
			bufferOut?: string;
		};
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts);
		try {
			const programId = client.program.programId;

			const bytecode = local.so
				? fs.readFileSync(path.resolve(local.so))
				: Buffer.from(SBPF_ABORT_BASE64, 'base64');
			if (bytecode.length === 0) {
				throw new Error('bytecode is empty');
			}

			// Final upgrade-authority signer (whoever signs the proposed/sent upgrade ix).
			let upgradeAuthority: PublicKey;
			if (local.upgradeAuthority) {
				upgradeAuthority = new PublicKey(local.upgradeAuthority);
			} else if (opts.multisig) {
				[upgradeAuthority] = multisig.getVaultPda({
					multisigPda: new PublicKey(opts.multisig),
					index: 0,
				});
			} else {
				upgradeAuthority = provider.wallet.publicKey;
			}
			const spill = local.spill ? new PublicKey(local.spill) : upgradeAuthority;

			// 1) Create buffer + initialize. Wallet is the initial buffer authority so
			//    it can sign the Write ixs in step 2.
			const bufferKp = Keypair.generate();
			const bufferSize = BUFFER_HEADER_SIZE + bytecode.length;
			const rent = await provider.connection.getMinimumBalanceForRentExemption(
				bufferSize
			);

			const bufferOutPath =
				local.bufferOut ??
				path.join(
					process.cwd(),
					`halt-buffer-${bufferKp.publicKey.toBase58().slice(0, 8)}.json`
				);
			fs.writeFileSync(
				bufferOutPath,
				JSON.stringify(Array.from(bufferKp.secretKey))
			);
			console.log(
				`buffer keypair written to ${bufferOutPath} (close later to reclaim ${(
					rent / 1e9
				).toFixed(6)} SOL rent)`
			);

			const createTx = new Transaction().add(
				SystemProgram.createAccount({
					fromPubkey: provider.wallet.publicKey,
					newAccountPubkey: bufferKp.publicKey,
					lamports: rent,
					space: bufferSize,
					programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
				}),
				buildInitializeBufferIx({
					buffer: bufferKp.publicKey,
					authority: provider.wallet.publicKey,
				})
			);
			const createSig = await provider.sendAndConfirm(createTx, [bufferKp]);
			console.log(
				`  ✓ buffer ${bufferKp.publicKey.toBase58()} initialized (${createSig})`
			);

			// 2) Write the bytecode in chunks. Each Write ix is its own tx.
			for (
				let offset = 0;
				offset < bytecode.length;
				offset += WRITE_CHUNK_BYTES
			) {
				const chunk = bytecode.subarray(
					offset,
					Math.min(offset + WRITE_CHUNK_BYTES, bytecode.length)
				);
				const writeTx = new Transaction().add(
					buildWriteIx({
						buffer: bufferKp.publicKey,
						authority: provider.wallet.publicKey,
						offset,
						bytes: chunk,
					})
				);
				await provider.sendAndConfirm(writeTx);
				console.log(
					`  ✓ wrote ${chunk.length} bytes @ offset ${offset} / ${bytecode.length}`
				);
			}

			// 3) If the upgrade authority differs from the wallet, transfer buffer
			//    authority to it. The loader requires buffer.authority ==
			//    program.upgrade_authority for `Upgrade` to succeed.
			if (!upgradeAuthority.equals(provider.wallet.publicKey)) {
				const setAuthTx = new Transaction().add(
					buildSetBufferAuthorityIx({
						buffer: bufferKp.publicKey,
						currentAuthority: provider.wallet.publicKey,
						newAuthority: upgradeAuthority,
					})
				);
				const setAuthSig = await provider.sendAndConfirm(setAuthTx);
				console.log(
					`  ✓ buffer authority transferred to ${upgradeAuthority.toBase58()} (${setAuthSig})`
				);
			}

			// 4) Propose / send the upgrade itself.
			const ix = buildUpgradeIx({
				programId,
				buffer: bufferKp.publicKey,
				authority: upgradeAuthority,
				spill,
			});
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				`velocity-admin program halt buffer=${bufferKp.publicKey.toBase58()}`
			);
			reportDispatch(
				`program halt — upgrading ${programId.toBase58()} with buffer ${bufferKp.publicKey.toBase58()} (authority=${upgradeAuthority.toBase58()}, spill=${spill.toBase58()})`,
				result
			);
		} finally {
			await client.unsubscribe();
		}
	});

	withGlobalOptions(
		prog
			.command('close-buffers')
			.description(
				[
					'Close orphaned program + IDL (program-metadata) buffers and reclaim',
					'their rent. A failed/partial release leaves a ~5 MB BPF program buffer',
					'(~36 SOL) and its metadata buffer stranded under the multisig vault',
					'authority; this discovers every buffer owned by that authority and',
					'batches BPFLoaderUpgradeable::Close + program-metadata::Close into as',
					'few Squads proposals as fit the tx size limit.',
					'',
					'Authority defaults to the multisig vault (with --multisig) or the wallet',
					'(without). Rent goes to --recipient (default: the authority itself).',
					'',
					'WARNING: this also matches the buffers of any *pending, not-yet-executed*',
					'upgrade proposal (they too are owned by the vault). Review the listed',
					'buffers — or use --dry-run first — before approving the close proposal.',
				].join('\n')
			)
			.option(
				'--authority <pubkey>',
				'buffer authority to search for (defaults to the multisig vault, or the wallet when --multisig is absent)'
			)
			.option(
				'--recipient <pubkey>',
				'rent recipient (defaults to the authority)'
			)
			.option('--program-only', 'only close BPF program buffers')
			.option('--metadata-only', 'only close program-metadata (IDL) buffers')
			.option(
				'--dry-run',
				'list the buffers that would be closed and exit without proposing'
			)
	).action(async (_flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const local = cmd.opts() as {
			authority?: string;
			recipient?: string;
			programOnly?: boolean;
			metadataOnly?: boolean;
			dryRun?: boolean;
		};
		if (local.programOnly && local.metadataOnly) {
			throw new Error(
				'--program-only and --metadata-only are mutually exclusive'
			);
		}
		const provider = buildProvider(opts);
		const connection = provider.connection;
		const multisigPda = opts.multisig
			? new PublicKey(opts.multisig)
			: undefined;

		// Authority currently owning the buffers (vault under --multisig, else wallet).
		let authority: PublicKey;
		if (local.authority) {
			authority = new PublicKey(local.authority);
		} else if (multisigPda) {
			[authority] = multisig.getVaultPda({ multisigPda, index: 0 });
		} else {
			authority = provider.wallet.publicKey;
		}
		const recipient = local.recipient
			? new PublicKey(local.recipient)
			: authority;

		const kinds: ('program' | 'metadata')[] = local.programOnly
			? ['program']
			: local.metadataOnly
			? ['metadata']
			: ['program', 'metadata'];

		const discovered = (
			await Promise.all(kinds.map((k) => findBuffers(connection, k, authority)))
		).flat();

		if (discovered.length === 0) {
			console.log(`no buffers found with authority ${authority.toBase58()}`);
			return;
		}

		const totalLamports = discovered.reduce((s, b) => s + b.lamports, 0);
		console.log(
			`found ${
				discovered.length
			} buffer(s) with authority ${authority.toBase58()} — reclaimable ${(
				totalLamports / 1e9
			).toFixed(6)} SOL:`
		);
		for (const b of discovered) {
			console.log(
				`  [${
					b.kind === 'program' ? 'program ' : 'metadata'
				}] ${b.address.toBase58()}  ${(b.lamports / 1e9).toFixed(6)} SOL`
			);
		}
		console.log(`  rent recipient: ${recipient.toBase58()}`);

		if (local.dryRun) {
			console.log('--dry-run: not proposing.');
			return;
		}

		const closeIxs = discovered.map((b) =>
			b.kind === 'program'
				? buildCloseBufferIx({ buffer: b.address, recipient, authority })
				: buildCloseMetadataBufferIx({
						buffer: b.address,
						recipient,
						authority,
				  })
		);

		// Greedily pack closes into batches that stay under the tx size limit.
		// Measure the actual outer transaction sendOrPropose would submit (a
		// Squads vaultTransactionCreate + proposalCreate, or a plain tx when
		// sending directly) so every proposal is guaranteed to fit.
		const { blockhash } = await connection.getLatestBlockhash();
		const outerTxSize = (ixs: TransactionInstruction[]): number => {
			let tx: Transaction;
			if (multisigPda) {
				const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
				const transactionMessage = new TransactionMessage({
					payerKey: vaultPda,
					recentBlockhash: blockhash,
					instructions: ixs,
				});
				const createIx = multisig.instructions.vaultTransactionCreate({
					multisigPda,
					transactionIndex: BigInt(1),
					creator: provider.wallet.publicKey,
					vaultIndex: 0,
					ephemeralSigners: 0,
					transactionMessage,
					memo: 'velocity-admin close-buffers',
				});
				const proposeIx = multisig.instructions.proposalCreate({
					multisigPda,
					transactionIndex: BigInt(1),
					creator: provider.wallet.publicKey,
				});
				tx = new Transaction().add(createIx, proposeIx);
			} else {
				tx = new Transaction().add(...ixs);
			}
			tx.recentBlockhash = blockhash;
			tx.feePayer = provider.wallet.publicKey;
			return tx.serialize({
				requireAllSignatures: false,
				verifySignatures: false,
			}).length;
		};

		const batches: TransactionInstruction[][] = [];
		let current: TransactionInstruction[] = [];
		for (const ix of closeIxs) {
			const trial = [...current, ix];
			if (current.length > 0 && outerTxSize(trial) > OUTER_TX_SIZE_BUDGET) {
				batches.push(current);
				current = [ix];
			} else {
				current = trial;
			}
		}
		if (current.length > 0) {
			batches.push(current);
		}

		for (let i = 0; i < batches.length; i++) {
			const result = await sendOrPropose(
				provider,
				batches[i],
				multisigPda,
				`velocity-admin close-buffers (${i + 1}/${batches.length})`
			);
			reportDispatch(
				`close-buffers batch ${i + 1}/${batches.length} — ${
					batches[i].length
				} buffer(s)`,
				result
			);
		}
	});
}
