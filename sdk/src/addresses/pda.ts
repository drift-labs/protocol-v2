import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';

export async function getDriftStateAccountPublicKeyAndNonce(
	programId: PublicKey
): Promise<[PublicKey, number]> {
	return PublicKey.findProgramAddress(
		[Buffer.from(anchor.utils.bytes.utf8.encode('drift_state'))],
		programId
	);
}

export async function getDriftStateAccountPublicKey(
	programId: PublicKey
): Promise<PublicKey> {
	return (await getDriftStateAccountPublicKeyAndNonce(programId))[0];
}

export async function getUserAccountPublicKeyAndNonce(
	programId: PublicKey,
	authority: PublicKey,
	subAccountId = 0
): Promise<[PublicKey, number]> {
	return PublicKey.findProgramAddress(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('user')),
			authority.toBuffer(),
			new anchor.BN(subAccountId).toArrayLike(Buffer, 'le', 2),
		],
		programId
	);
}

export async function getUserAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey,
	subAccountId = 0
): Promise<PublicKey> {
	return (
		await getUserAccountPublicKeyAndNonce(programId, authority, subAccountId)
	)[0];
}

export function getUserAccountPublicKeySync(
	programId: PublicKey,
	authority: PublicKey,
	subAccountId = 0
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('user')),
			authority.toBuffer(),
			new anchor.BN(subAccountId).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getUserStatsAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('user_stats')),
			authority.toBuffer(),
		],
		programId
	)[0];
}

export async function getPerpMarketPublicKey(
	programId: PublicKey,
	marketIndex: number
): Promise<PublicKey> {
	return (
		await PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('perp_market')),
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
		await PublicKey.findProgramAddress(
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
		await PublicKey.findProgramAddress(
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
		await PublicKey.findProgramAddress(
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
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('insurance_fund_stake')),
			authority.toBuffer(),
			new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getDriftSignerPublicKey(programId: PublicKey): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from(anchor.utils.bytes.utf8.encode('drift_signer'))],
		programId
	)[0];
}

export function getSerumOpenOrdersPublicKey(
	programId: PublicKey,
	market: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
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
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('serum_fulfillment_config')),
			market.toBuffer(),
		],
		programId
	)[0];
}

export function getPhoenixFulfillmentConfigPublicKey(
	programId: PublicKey,
	market: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('phoenix_fulfillment_config')),
			market.toBuffer(),
		],
		programId
	)[0];
}

export function getReferrerNamePublicKeySync(
	programId: PublicKey,
	nameBuffer: number[]
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('referrer_name')),
			Buffer.from(nameBuffer),
		],
		programId
	)[0];
}
