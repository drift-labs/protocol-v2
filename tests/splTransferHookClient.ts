import {
	Connection,
	PublicKey,
	Transaction,
	SystemProgram,
	Keypair,
	TransactionInstruction as _TransactionInstruction,
	SystemInstruction as _SystemInstruction,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import { Wallet as _Wallet } from '@coral-xyz/anchor';
import { hash as _hash } from '@coral-xyz/anchor/dist/cjs/utils/sha256';
import { TOKEN_2022_PROGRAM_ID as _TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

export function calculateDiscriminator(methodName: string): Buffer {
	// return Buffer.from(hash(methodName)).slice(0, 8);

	// Use SHA256 to match solana_program::hash::hashv
	const hash = createHash('sha256');
	hash.update(methodName);
	return hash.digest().slice(0, 8);
}

// You'll need to define these types based on the Rust interface
export interface CustomExtraAccountMeta {
	// This would need to match the Rust struct exactly
	// For simplicity, showing basic structure
	addressConfig: PublicKey; // Just use PublicKey directly
	isSigner: boolean;
	isWritable: boolean;
}

export async function initializeExtraAccountMetaList(
	connection: Connection,
	transferHookProgramId: PublicKey,
	mintAddress: PublicKey,
	mintAuthority: Keypair,
	payer: Keypair,
	extraAccountMetas: CustomExtraAccountMeta[]
): Promise<string> {
	// 1. Derive the PDA where extra account metadata will be stored
	const [extraAccountMetasAddress] = PublicKey.findProgramAddressSync(
		[Buffer.from('extra-account-metas'), mintAddress.toBuffer()],
		transferHookProgramId
	);

	// 2. Serialize the extra account metas for instruction data
	const serializedMetas = Buffer.concat(
		extraAccountMetas.map((meta) => serializeExtraAccountMeta(meta))
	);

	// 3. Build instruction data: discriminator + length + serialized metas
	const instructionData = Buffer.concat([
		calculateDiscriminator(
			'spl-transfer-hook-interface:initialize-extra-account-metas'
		),
		Buffer.from(new Uint32Array([extraAccountMetas.length]).buffer), // length as u32 little endian
		serializedMetas,
	]);

	// 4. Build the transaction with CORRECT account order
	const transaction = new Transaction().add(
		SystemProgram.transfer({
			fromPubkey: payer.publicKey,
			toPubkey: extraAccountMetasAddress,
			lamports: LAMPORTS_PER_SOL / 10,
		}),
		SystemProgram.transfer({
			fromPubkey: payer.publicKey,
			toPubkey: extraAccountMetas[0].addressConfig,
			lamports: LAMPORTS_PER_SOL / 10,
		}),
		{
			programId: transferHookProgramId,
			keys: [
				{ pubkey: extraAccountMetasAddress, isSigner: false, isWritable: true }, // [w] Account with extra account metas
				{ pubkey: mintAddress, isSigner: false, isWritable: false }, // [] Mint
				{ pubkey: mintAuthority.publicKey, isSigner: true, isWritable: false }, // [s] Mint authority (MUST BE SIGNER!)
				{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // [] System program
				...extraAccountMetas.map((meta) => ({
					pubkey: meta.addressConfig,
					isSigner: meta.isSigner,
					isWritable: meta.isWritable,
				})),
			],
			data: instructionData,
		}
	);

	transaction.feePayer = payer.publicKey;
	transaction.recentBlockhash = (
		await connection.getLatestBlockhash()
	).blockhash;

	// 5. Sign with BOTH payer and mint authority
	transaction.sign(payer, mintAuthority);

	// 6. Send transaction
	return await connection.sendTransaction(transaction, [payer, mintAuthority]);
}

export function serializeExtraAccountMeta(
	meta: CustomExtraAccountMeta
): Buffer {
	// ExtraAccountMeta layout (from Rust):
	// - 1 byte: discriminator (0 = AccountMeta/Pubkey, 1 = Seed)
	// - 32 bytes: pubkey
	// - 1 byte: is_signer
	// - 1 byte: is_writable

	const buffer = Buffer.alloc(35);
	let offset = 0;

	// Write discriminator (0 for AccountMeta/Pubkey variant)
	buffer.writeUInt8(0, offset);
	offset += 1;

	// Write pubkey (32 bytes)
	meta.addressConfig.toBuffer().copy(buffer, offset);
	offset += 32;

	// Write is_signer boolean (1 byte)
	buffer.writeUInt8(meta.isSigner ? 1 : 0, offset);
	offset += 1;

	// Write is_writable boolean (1 byte)
	buffer.writeUInt8(meta.isWritable ? 1 : 0, offset);

	return buffer;
}

export function calculateExtraAccountMetaListSize(numMetas: number): number {
	// Calculate based on Rust ExtraAccountMetaList::size_of()
	// This would need to match the exact calculation from the Rust code
	return 8 + 4 + numMetas * 35; // Rough estimate
}
