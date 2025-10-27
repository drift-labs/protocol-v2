import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import {
	getAssociatedTokenAddress,
	TOKEN_2022_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { SpotMarketAccount, TokenProgramFlag } from '../types';

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

export function getFuelOverflowAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('fuel_overflow')),
			authority.toBuffer(),
		],
		programId
	)[0];
}

export function getSignedMsgUserAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('SIGNED_MSG')),
			authority.toBuffer(),
		],
		programId
	)[0];
}

export function getSignedMsgWsDelegatesAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('SIGNED_MSG_WS')),
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

export function getPerpMarketPublicKeySync(
	programId: PublicKey,
	marketIndex: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('perp_market')),
			new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
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

export function getSpotMarketPublicKeySync(
	programId: PublicKey,
	marketIndex: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('spot_market')),
			new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
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

export function getOpenbookV2FulfillmentConfigPublicKey(
	programId: PublicKey,
	market: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(
				anchor.utils.bytes.utf8.encode('openbook_v2_fulfillment_config')
			),
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

export function getProtocolIfSharesTransferConfigPublicKey(
	programId: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from(anchor.utils.bytes.utf8.encode('if_shares_transfer_config'))],
		programId
	)[0];
}

export function getPrelaunchOraclePublicKey(
	programId: PublicKey,
	marketIndex: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('prelaunch_oracle')),
			new anchor.BN(marketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getPythPullOraclePublicKey(
	progarmId: PublicKey,
	feedId: Uint8Array
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('pyth_pull')),
			Buffer.from(feedId),
		],
		progarmId
	)[0];
}

export function getPythLazerOraclePublicKey(
	progarmId: PublicKey,
	feedId: number
): PublicKey {
	const buffer = new ArrayBuffer(4);
	const view = new DataView(buffer);
	view.setUint32(0, feedId, true);
	const feedIdBytes = new Uint8Array(buffer);
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('pyth_lazer')),
			Buffer.from(feedIdBytes),
		],
		progarmId
	)[0];
}

export function getTokenProgramForSpotMarket(
	spotMarketAccount: SpotMarketAccount
): PublicKey {
	if ((spotMarketAccount.tokenProgramFlag & TokenProgramFlag.Token2022) > 0) {
		return TOKEN_2022_PROGRAM_ID;
	}
	return TOKEN_PROGRAM_ID;
}

export function getHighLeverageModeConfigPublicKey(
	programId: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from(anchor.utils.bytes.utf8.encode('high_leverage_mode_config'))],
		programId
	)[0];
}

export function getProtectedMakerModeConfigPublicKey(
	programId: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(
				anchor.utils.bytes.utf8.encode('protected_maker_mode_config')
			),
		],
		programId
	)[0];
}

export function getIfRebalanceConfigPublicKey(
	programId: PublicKey,
	inMarketIndex: number,
	outMarketIndex: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('if_rebalance_config')),
			new BN(inMarketIndex).toArrayLike(Buffer, 'le', 2),
			new BN(outMarketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getRevenueShareAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('REV_SHARE')),
			authority.toBuffer(),
		],
		programId
	)[0];
}

export function getRevenueShareEscrowAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('REV_ESCROW')),
			authority.toBuffer(),
		],
		programId
	)[0];
}

export function getLpPoolPublicKey(
	programId: PublicKey,
	lpPoolId: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('lp_pool')),
			new anchor.BN(lpPoolId).toArrayLike(Buffer, 'le', 1),
		],
		programId
	)[0];
}

export function getLpPoolTokenVaultPublicKey(
	programId: PublicKey,
	lpPool: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('LP_POOL_TOKEN_VAULT')),
			lpPool.toBuffer(),
		],
		programId
	)[0];
}
export function getAmmConstituentMappingPublicKey(
	programId: PublicKey,
	lpPoolPublicKey: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('AMM_MAP')),
			lpPoolPublicKey.toBuffer(),
		],
		programId
	)[0];
}

export function getConstituentTargetBasePublicKey(
	programId: PublicKey,
	lpPoolPublicKey: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(
				anchor.utils.bytes.utf8.encode('constituent_target_base_seed')
			),
			lpPoolPublicKey.toBuffer(),
		],
		programId
	)[0];
}

export function getConstituentPublicKey(
	programId: PublicKey,
	lpPoolPublicKey: PublicKey,
	spotMarketIndex: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('CONSTITUENT')),
			lpPoolPublicKey.toBuffer(),
			new anchor.BN(spotMarketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getConstituentVaultPublicKey(
	programId: PublicKey,
	lpPoolPublicKey: PublicKey,
	spotMarketIndex: number
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('CONSTITUENT_VAULT')),
			lpPoolPublicKey.toBuffer(),
			new anchor.BN(spotMarketIndex).toArrayLike(Buffer, 'le', 2),
		],
		programId
	)[0];
}

export function getAmmCachePublicKey(programId: PublicKey): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from(anchor.utils.bytes.utf8.encode('amm_cache_seed'))],
		programId
	)[0];
}

export function getConstituentCorrelationsPublicKey(
	programId: PublicKey,
	lpPoolPublicKey: PublicKey
): PublicKey {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(anchor.utils.bytes.utf8.encode('constituent_correlations')),
			lpPoolPublicKey.toBuffer(),
		],
		programId
	)[0];
}

export async function getLpPoolTokenTokenAccountPublicKey(
	lpPoolTokenMint: PublicKey,
	authority: PublicKey
): Promise<PublicKey> {
	return await getAssociatedTokenAddress(lpPoolTokenMint, authority, true);
}
