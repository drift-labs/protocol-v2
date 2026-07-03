/**
 * PDA derivation helpers for all Velocity protocol accounts.
 * Covers: User, UserStats, PerpMarket, SpotMarket, InsuranceFundStake, State,
 * LP pool (and its constituents/caches), revenue share, and vault PDAs.
 * All functions are pure (no RPC calls).
 */
import { PublicKey } from '@solana/web3.js';
import * as anchor from '../isomorphic/anchor';
import {
	getAssociatedTokenAddress,
	TOKEN_2022_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { SpotMarketAccount, TokenProgramFlag } from '../types';

/**
 * Derives the singleton `State` account PDA (seed `"velocity_state"`), plus its bump nonce. There
 * is exactly one `State` account per program deployment.
 * @param programId - Deployed velocity program id.
 * @returns Tuple of `[stateAccountPublicKey, bumpNonce]`.
 */
export async function getVelocityStateAccountPublicKeyAndNonce(
	programId: PublicKey
): Promise<[PublicKey, number]> {
	return Promise.resolve(
		PublicKey.findProgramAddressSync(
			[Buffer.from(anchor.utils.bytes.utf8.encode('velocity_state'))],
			programId
		)
	);
}

/**
 * Derives the singleton `State` account PDA (seed `"velocity_state"`).
 * @param programId - Deployed velocity program id.
 * @returns The `State` account's public key.
 */
export async function getVelocityStateAccountPublicKey(
	programId: PublicKey
): Promise<PublicKey> {
	return (await getVelocityStateAccountPublicKeyAndNonce(programId))[0];
}

/**
 * Derives a `User` (sub-account) PDA, plus its bump nonce, from seeds `["user", authority,
 * subAccountId as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey that owns the sub-account.
 * @param subAccountId - Sub-account index (u16); defaults to 0, the wallet's first/main sub-account.
 * @returns Tuple of `[userAccountPublicKey, bumpNonce]`.
 */
export async function getUserAccountPublicKeyAndNonce(
	programId: PublicKey,
	authority: PublicKey,
	subAccountId = 0
): Promise<[PublicKey, number]> {
	return Promise.resolve(
		PublicKey.findProgramAddressSync(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('user')),
				authority.toBuffer(),
				new anchor.BN(subAccountId).toArrayLike(Buffer, 'le', 2),
			],
			programId
		)
	);
}

/**
 * Derives a `User` (sub-account) PDA from seeds `["user", authority, subAccountId as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey that owns the sub-account.
 * @param subAccountId - Sub-account index (u16); defaults to 0, the wallet's first/main sub-account.
 * @returns The `User` account's public key.
 */
export async function getUserAccountPublicKey(
	programId: PublicKey,
	authority: PublicKey,
	subAccountId = 0
): Promise<PublicKey> {
	return (
		await getUserAccountPublicKeyAndNonce(programId, authority, subAccountId)
	)[0];
}

/**
 * Synchronous variant of `getUserAccountPublicKey` (no RPC/async round-trip; pure PDA math).
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey that owns the sub-account.
 * @param subAccountId - Sub-account index (u16); defaults to 0.
 * @returns The `User` account's public key.
 */
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

/**
 * Derives the `UserStats` PDA (one per authority, shared across all of that authority's
 * sub-accounts) from seeds `["user_stats", authority]`.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey the stats account tracks.
 * @returns The `UserStats` account's public key.
 */
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

/**
 * Derives the `SignedMsgUserOrders` PDA (holds a user's pending swift/signed-message orders) from
 * seeds `["SIGNED_MSG", authority]`.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey (the user's main authority, not the sub-account) that owns the account.
 * @returns The `SignedMsgUserOrders` account's public key.
 */
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

/**
 * Derives the PDA that stores a user's approved signed-message (swift) websocket delegate keys,
 * from seeds `["SIGNED_MSG_WS", authority]`.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey (the user's main authority) that owns the delegates account.
 * @returns The delegates account's public key.
 */
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

/**
 * Derives a `PerpMarket` PDA from seeds `["perp_market", marketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Perp market index.
 * @returns The `PerpMarket` account's public key.
 */
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

/**
 * Synchronous variant of `getPerpMarketPublicKey`.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Perp market index.
 * @returns The `PerpMarket` account's public key.
 */
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

/**
 * Derives a `SpotMarket` PDA from seeds `["spot_market", marketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Spot market index.
 * @returns The `SpotMarket` account's public key.
 */
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

/**
 * Synchronous variant of `getSpotMarketPublicKey`.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Spot market index.
 * @returns The `SpotMarket` account's public key.
 */
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

/**
 * Derives the token vault PDA (an SPL/Token-2022 token account owned by the `velocity_signer` PDA)
 * that custodies a spot market's deposits, from seeds `["spot_market_vault", marketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Spot market index.
 * @returns The spot market vault token account's public key.
 */
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

/**
 * Derives the insurance fund's token vault PDA for a market, from seeds `["insurance_fund_vault",
 * marketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Spot market index whose insurance fund this vault backs.
 * @returns The insurance fund vault token account's public key.
 */
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

/**
 * Derives an `InsuranceFundStake` PDA (an authority's staked share of one market's insurance fund)
 * from seeds `["insurance_fund_stake", authority, marketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey staking into the insurance fund.
 * @param marketIndex - Spot market index whose insurance fund is being staked into.
 * @returns The `InsuranceFundStake` account's public key.
 */
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

/**
 * Derives the singleton `velocity_signer` PDA — the program-derived authority that owns/signs for
 * all program-controlled token vaults (spot market vaults, insurance fund vaults, etc.) via CPI.
 * @param programId - Deployed velocity program id.
 * @returns The velocity signer PDA's public key.
 */
export function getVelocitySignerPublicKey(programId: PublicKey): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from(anchor.utils.bytes.utf8.encode('velocity_signer'))],
		programId
	)[0];
}

/**
 * Derives the PDA that reserves a unique referrer name, from seeds `["referrer_name", nameBuffer]`.
 * Used to enforce name uniqueness for referrers on-chain.
 * @param programId - Deployed velocity program id.
 * @param nameBuffer - The 32-byte encoded name (see `encodeName`) to reserve.
 * @returns The referrer-name PDA's public key.
 */
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

/**
 * Derives the `PrelaunchOracle` PDA used as a placeholder/synthetic oracle for a not-yet-listed
 * perp market, from seeds `["prelaunch_oracle", marketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Perp market index the prelaunch oracle backs.
 * @returns The `PrelaunchOracle` account's public key.
 */
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

/**
 * Derives a Pyth Lazer oracle account PDA from seeds `["pyth_lazer", feedId as u32 LE]`. One
 * account exists per Lazer feed id and is shared across all markets using that feed.
 * @param progarmId - Deployed velocity program id (note: parameter name is misspelled but stable API).
 * @param feedId - Pyth Lazer feed id (u32).
 * @returns The Pyth Lazer oracle account's public key.
 */
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

/**
 * Picks the correct SPL token program for a spot market's mint, based on its `tokenProgramFlag`.
 * Needed because Velocity supports both classic SPL tokens and Token-2022 mints; passing the wrong
 * token program id to an instruction's accounts will fail owner checks.
 * @param spotMarketAccount - The spot market to inspect.
 * @returns `TOKEN_2022_PROGRAM_ID` if `TokenProgramFlag.Token2022` is set, otherwise `TOKEN_PROGRAM_ID`.
 */
export function getTokenProgramForSpotMarket(
	spotMarketAccount: SpotMarketAccount
): PublicKey {
	if ((spotMarketAccount.tokenProgramFlag & TokenProgramFlag.Token2022) > 0) {
		return TOKEN_2022_PROGRAM_ID;
	}
	return TOKEN_PROGRAM_ID;
}

/**
 * Derives a builder/referrer's `RevenueShare` PDA from seeds `["REV_SHARE", authority]`. Tracks
 * fees a builder/referrer has accrued from orders that credited them.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey of the builder/referrer.
 * @returns The `RevenueShare` account's public key.
 */
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

/**
 * Derives a user's `RevenueShareEscrow` PDA from seeds `["REV_ESCROW", authority]`. Holds the
 * user's referrer link and approved builder-fee list; required as a remaining account whenever a
 * placed order references a `builderIdx`/builder fee, or when a taker was referred.
 * @param programId - Deployed velocity program id.
 * @param authority - Wallet pubkey of the user (order placer), not the builder/referrer.
 * @returns The `RevenueShareEscrow` account's public key.
 */
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

/**
 * Derives an `LpPool` PDA from seeds `["lp_pool", lpPoolId as u8 LE]`.
 * @param programId - Deployed velocity program id.
 * @param lpPoolId - Single-byte LP pool id.
 * @returns The `LpPool` account's public key.
 */
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

/**
 * Derives the token vault PDA holding an `LpPool`'s minted LP token supply's backing, from seeds
 * `["LP_POOL_TOKEN_VAULT", lpPool]`.
 * @param programId - Deployed velocity program id.
 * @param lpPool - The `LpPool` account's public key.
 * @returns The LP pool token vault's public key.
 */
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
/**
 * Derives the `AmmConstituentMapping` PDA (maps LP-pool constituents to the perp AMMs they hedge)
 * from seeds `["AMM_MAP", lpPoolPublicKey]`.
 * @param programId - Deployed velocity program id.
 * @param lpPoolPublicKey - The `LpPool` account's public key.
 * @returns The `AmmConstituentMapping` account's public key.
 */
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

/**
 * Derives the `ConstituentTargetBase` PDA (target base-asset weights for an LP pool's
 * constituents) from seeds `["constituent_target_base_seed", lpPoolPublicKey]`.
 * @param programId - Deployed velocity program id.
 * @param lpPoolPublicKey - The `LpPool` account's public key.
 * @returns The `ConstituentTargetBase` account's public key.
 */
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

/**
 * Derives a `Constituent` PDA (one per spot market backing an LP pool) from seeds `["CONSTITUENT",
 * lpPoolPublicKey, spotMarketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param lpPoolPublicKey - The `LpPool` account's public key.
 * @param spotMarketIndex - Spot market index of this constituent.
 * @returns The `Constituent` account's public key.
 */
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

/**
 * Derives the token vault PDA that custodies a `Constituent`'s deposits, from seeds
 * `["CONSTITUENT_VAULT", lpPoolPublicKey, spotMarketIndex as u16 LE]`.
 * @param programId - Deployed velocity program id.
 * @param lpPoolPublicKey - The `LpPool` account's public key.
 * @param spotMarketIndex - Spot market index of the constituent this vault backs.
 * @returns The constituent vault token account's public key.
 */
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

/**
 * Derives the singleton `AmmCache` PDA (caches per-AMM data used by LP-pool hedging/settlement)
 * from seed `"amm_cache_seed"`. One per program deployment.
 * @param programId - Deployed velocity program id.
 * @returns The `AmmCache` account's public key.
 */
export function getAmmCachePublicKey(programId: PublicKey): PublicKey {
	return PublicKey.findProgramAddressSync(
		[Buffer.from(anchor.utils.bytes.utf8.encode('amm_cache_seed'))],
		programId
	)[0];
}

/**
 * Derives the `ConstituentCorrelations` PDA (pairwise correlation data between an LP pool's
 * constituents) from seeds `["constituent_correlations", lpPoolPublicKey]`.
 * @param programId - Deployed velocity program id.
 * @param lpPoolPublicKey - The `LpPool` account's public key.
 * @returns The `ConstituentCorrelations` account's public key.
 */
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

/**
 * Derives the associated token account for an LP pool's mint under a given owner (not a
 * program-derived PDA — a standard SPL associated token account).
 * @param lpPoolTokenMint - The LP pool's token mint.
 * @param authority - Owner of the associated token account.
 * @returns The associated token account's public key.
 */
export async function getLpPoolTokenTokenAccountPublicKey(
	lpPoolTokenMint: PublicKey,
	authority: PublicKey
): Promise<PublicKey> {
	return await getAssociatedTokenAddress(lpPoolTokenMint, authority, true);
}
