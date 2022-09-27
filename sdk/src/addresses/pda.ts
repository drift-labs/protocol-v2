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

export function getUserStatsAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): PublicKey {
	return anchor.web3.PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('user_stats')),
			authority.toBuffer(),
		],
		programId
	)[0];
}

export async function getMarketPublicKey(
	programId: PublicKey,
	marketIndex: number
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('market')),
				new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
			],
			programId
		)
	)[0];
}

export async function getSpotMarketPublicKey(
	programId: PublicKey,
	marketIndex: number
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('spot_market')),
				new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
			],
			programId
		)
	)[0];
}

export async function getSpotMarketVaultPublicKey(
	programId: PublicKey,
	marketIndex: number
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('spot_market_vault')),
				new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
			],
			programId
		)
	)[0];
}

export async function getInsuranceFundVaultPublicKey(
	programId: PublicKey,
	marketIndex: number
): Promise<PublicKey> {
	return (
		await anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('insurance_fund_vault')),
				new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
			],
			programId
		)
	)[0];
}

export function getInsuranceFundStakeAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey,
	marketIndex: number
): PublicKey {
	return anchor.web3.PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('insurance_fund_stake')),
			authority.toBuffer(),
			new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getClearingHouseSignerPublicKey(
	programId: PublicKey
): PublicKey {
	return anchor.web3.PublicKey.findProgramAddressSync(
		[Buffer.from(anchor.utils.bytes.utf8.encode('clearing_house_signer'))],
		programId
	)[0];
}

export function getSerumOpenOrdersPublicKey(
	programId: PublicKey,
	market: PublicKey
): PublicKey {
	return anchor.web3.PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('serum_open_orders')),
			market.toBuffer(),
		],
		programId
	)[0];
}

export function getSerumSignerPublicKey(
	programId: PublicKey,
	market: PublicKey,
	nonce: BN
): PublicKey {
	return anchor.web3.PublicKey.createProgramAddressSync(
		[market.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
		programId
	);
}

export function getSerumFulfillmentConfigPublicKey(
	programId: PublicKey,
	market: PublicKey
): PublicKey {
	return anchor.web3.PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('serum_fulfillment_config')),
			market.toBuffer(),
		],
		programId
	)[0];
}
