import { PublicKey } from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';

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
	authority: PublicKey
): Promise<[PublicKey, number]> {
	return anchor.web3.PublicKey.findProgramAddress(
		[Buffer.from(anchor.utils.bytes.utf8.encode('user')), authority.toBuffer()],
		programId
	);
}

export async function getUserAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): Promise<PublicKey> {
	return (await getUserAccountPublicKeyAndNonce(programId, authority))[0];
}

export async function getUserOrdersAccountPublicKeyAndNonce(
	programId: PublicKey,
	userAccount: PublicKey
): Promise<[PublicKey, number]> {
	return anchor.web3.PublicKey.findProgramAddress(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('user_orders')),
			userAccount.toBuffer(),
		],
		programId
	);
}

export async function getUserOrdersAccountPublicKey(
	programId: PublicKey,
	userAccount: PublicKey
): Promise<PublicKey> {
	return (
		await getUserOrdersAccountPublicKeyAndNonce(programId, userAccount)
	)[0];
}
