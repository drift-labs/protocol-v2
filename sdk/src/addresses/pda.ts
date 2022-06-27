import { PublicKey } from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import { BN } from '@project-serum/anchor';

export async function getClearingHouseStateAccountPublicKeyAndNonce(
	programId: PublicKey
): Promise<[PublicKey, number]> {
	return anchor.web3.PublicKey.findProgramAddress(
		[Buffer.from(anchor.utils.bytes.utf8.encode('clearing_house'))],
		programId
	);
}

export async function getOrderStateAccountPublicKey(
	programId: PublicKey
): Promise<PublicKey> {
	return (await getOrderStateAccountPublicKeyAndNonce(programId))[0];
}

export async function getOrderStateAccountPublicKeyAndNonce(
	programId: PublicKey
): Promise<[PublicKey, number]> {
	return anchor.web3.PublicKey.findProgramAddress(
		[Buffer.from(anchor.utils.bytes.utf8.encode('order_state'))],
		programId
	);
}

export async function getClearingHouseStateAccountPublicKey(
	programId: PublicKey
): Promise<PublicKey> {
	return (await getClearingHouseStateAccountPublicKeyAndNonce(programId))[0];
}

export async function getUserAccountPublicKeyAndNonce(
	programId: PublicKey,
	authority: PublicKey,
	userId = 0
): Promise<[PublicKey, number]> {
	return anchor.web3.PublicKey.findProgramAddress(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('user')),
			authority.toBuffer(),
			Uint8Array.from([userId]),
		],
		programId
	);
}

export async function getUserAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey,
	userId = 0
): Promise<PublicKey> {
	return (
		await getUserAccountPublicKeyAndNonce(programId, authority, userId)
	)[0];
}

export function getUserAccountPublicKeySync(
	programId: PublicKey,
	authority: PublicKey,
	userId = 0
): PublicKey {
	return anchor.web3.PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('user')),
			authority.toBuffer(),
			Uint8Array.from([userId]),
		],
		programId
	)[0];
}

export async function getMarketPublicKey(
	programId: PublicKey,
	marketIndex: BN
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('market')),
				marketIndex.toArrayLike(Buffer, 'le', 8),
			],
			programId
		)
	)[0];
}

export async function getBankPublicKey(
	programId: PublicKey,
	bankIndex: BN
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('bank')),
				bankIndex.toArrayLike(Buffer, 'le', 8),
			],
			programId
		)
	)[0];
}

export async function getBankVaultPublicKey(
	programId: PublicKey,
	bankIndex: BN
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('bank_vault')),
				bankIndex.toArrayLike(Buffer, 'le', 8),
			],
			programId
		)
	)[0];
}

export async function getBankVaultAuthorityPublicKey(
	programId: PublicKey,
	bankIndex: BN
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('bank_vault_authority')),
				bankIndex.toArrayLike(Buffer, 'le', 8),
			],
			programId
		)
	)[0];
}
