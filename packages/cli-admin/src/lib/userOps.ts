import { PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { GlobalOpts, loadKeypair } from './provider';

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
	'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

/**
 * Resolve the user authority for user-scoped commands (deposit / withdraw /
 * IF stake).
 *
 * Priority: explicit `--authority` flag, then the multisig's vault 0 PDA when
 * proposing via `--multisig` (the vault is the signer that executes the
 * proposal, so it must be the authority), then the local signer keypair.
 */
export function resolveAuthority(
	opts: GlobalOpts,
	explicit?: string
): PublicKey {
	if (explicit) {
		return new PublicKey(explicit);
	}
	if (opts.multisig) {
		const [vaultPda] = multisig.getVaultPda({
			multisigPda: new PublicKey(opts.multisig),
			index: 0,
		});
		return vaultPda;
	}
	return loadKeypair(opts.keypair).publicKey;
}

/**
 * Associated token account for `owner` (off-curve allowed, so PDAs like a
 * Squads vault work).
 */
export function deriveAssociatedTokenAccount(
	mint: PublicKey,
	owner: PublicKey,
	tokenProgram: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
		ASSOCIATED_TOKEN_PROGRAM_ID
	)[0];
}
