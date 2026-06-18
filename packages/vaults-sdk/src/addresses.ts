import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';

export function getVaultAddressSync(
	programId: PublicKey,
	encodedName: number[]
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('vault')),
			Buffer.from(encodedName),
		],
		programId
	)[0];
}

export function getVaultDepositorAddressSync(
	programId: PublicKey,
	vault: PublicKey,
	authority: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('vault_depositor')),
			vault.toBuffer(),
			authority.toBuffer(),
		],
		programId
	)[0];
}

export function getTokenVaultAddressSync(
	programId: PublicKey,
	vault: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('vault_token_account')),
			vault.toBuffer(),
		],
		programId
	)[0];
}

export function getInsuranceFundTokenVaultAddressSync(
	programId: PublicKey,
	vault: PublicKey,
	marketIndex: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('vault_token_account')),
			vault.toBuffer(),
			new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getVaultProtocolAddressSync(
	programId: PublicKey,
	vault: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('vault_protocol')),
			vault.toBuffer(),
		],
		programId
	)[0];
}

export function getTokenizedVaultAddressSync(
	programId: PublicKey,
	vault: PublicKey,
	sharesBase: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('tokenized_vault_depositor')),
			vault.toBuffer(),
			Buffer.from(anchor.utils.bytes.utf8.encode(sharesBase.toString())),
		],
		programId
	)[0];
}

export function getTokenizedVaultMintAddressSync(
	programId: PublicKey,
	vault: PublicKey,
	sharesBase: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('mint')),
			vault.toBuffer(),
			Buffer.from(anchor.utils.bytes.utf8.encode(sharesBase.toString())),
		],
		programId
	)[0];
}

export function getFeeUpdateAddressSync(
	programId: PublicKey,
	vault: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('fee_update')),
			vault.toBuffer(),
		],
		programId
	)[0];
}
