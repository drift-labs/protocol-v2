import { Command } from 'commander';
import {
	Keypair,
	PublicKey,
	SystemProgram,
	SYSVAR_CLOCK_PUBKEY,
	SYSVAR_RENT_PUBKEY,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';
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
 * `UpgradeableLoaderState::Buffer` header: 4-byte enum tag + 1-byte `Option`
 * discriminant + 32-byte authority Pubkey = 37 bytes ahead of the bytecode.
 */
const BUFFER_HEADER_SIZE = 37;

/** Loader instruction discriminators (4-byte LE enum tags). */
const IX_INITIALIZE_BUFFER = Buffer.from([0, 0, 0, 0]);
const IX_WRITE = Buffer.from([1, 0, 0, 0]);
const IX_UPGRADE = Buffer.from([3, 0, 0, 0]);
const IX_SET_AUTHORITY = Buffer.from([4, 0, 0, 0]);

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
}
