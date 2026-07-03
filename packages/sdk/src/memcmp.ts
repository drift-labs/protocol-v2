import { MemcmpFilter, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { BorshAccountsCoder } from './isomorphic/anchor29';
import { encodeName } from './userName';

/**
 * Builds a `getProgramAccounts` memcmp filter matching the 8-byte Anchor discriminator of the
 * `User` account type at offset 0. Use to fetch all `User` (sub-account) accounts.
 * @returns A memcmp filter for `User` accounts.
 */
export function getUserFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('User')),
		},
	};
}

/*
 * Byte offsets of the trailing scalar flags in the `User` account.
 *
 * These MUST match the on-chain `User` layout decoded in `decode/user.ts`. The
 * current Velocity layout is 4496 bytes, with the tail block laid out as
 * consecutive single bytes:
 *   status(4468) isMarginTradingEnabled(4469) idle(4470) openOrders(4471)
 *   hasOpenOrder(4472) openAuctions(4473) hasOpenAuction(4474) poolId(4475)
 *   specialUserStatus(4476)
 *
 * NOTE: these were previously hardcoded to the older (4376-byte) layout
 * (idle@4350, hasOpenOrder@4352, ...). After Velocity added fields to
 * `PerpPosition`, the account grew by 120 bytes and these flags shifted, but
 * the filters were not updated — so `getUserWithOrderFilter()` matched zero
 * accounts and the DLOB order book never populated. Keep these in sync with
 * `decode/user.ts` if the `User` layout changes again.
 */
const USER_IDLE_OFFSET = 4470;
const USER_HAS_OPEN_ORDER_OFFSET = 4472;
const USER_HAS_OPEN_AUCTION_OFFSET = 4474;
const USER_POOL_ID_OFFSET = 4475;

/**
 * Builds a memcmp filter matching `User` accounts whose `idle` flag (offset 4470) is `false`.
 * Idle sub-accounts have no open positions/orders and have been inactive past the idle threshold;
 * this filter excludes them, e.g. when scanning for accounts that need active monitoring.
 * @returns A memcmp filter for non-idle `User` accounts.
 */
export function getNonIdleUserFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_IDLE_OFFSET,
			bytes: bs58.encode(Uint8Array.from([0])),
		},
	};
}

/**
 * Builds a memcmp filter matching `User` accounts with `hasOpenOrder` (offset 4472) set to `true`
 * — i.e. at least one live order. Used by the DLOB to fetch only accounts that can populate the
 * order book.
 * @returns A memcmp filter for `User` accounts with at least one open order.
 */
export function getUserWithOrderFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_HAS_OPEN_ORDER_OFFSET,
			bytes: bs58.encode(Uint8Array.from([1])),
		},
	};
}

/**
 * Builds a memcmp filter matching `User` accounts with `hasOpenOrder` (offset 4472) set to `false`
 * — i.e. no live orders.
 * @returns A memcmp filter for `User` accounts with no open orders.
 */
export function getUserWithoutOrderFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_HAS_OPEN_ORDER_OFFSET,
			bytes: bs58.encode(Uint8Array.from([0])),
		},
	};
}

/**
 * Builds a memcmp filter matching `User` accounts with `hasOpenAuction` (offset 4474) set to
 * `true` — i.e. at least one order still in its Dutch-auction window.
 * @returns A memcmp filter for `User` accounts with an active order auction.
 */
export function getUserWithAuctionFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_HAS_OPEN_AUCTION_OFFSET,
			bytes: bs58.encode(Uint8Array.from([1])),
		},
	};
}

/**
 * Builds a memcmp filter matching `User` accounts whose `name` field (32 bytes, offset 72) equals
 * `name` once encoded/padded the same way as on-chain.
 * @param name - Human-readable sub-account name to match; encoded via `encodeName` (UTF-8,
 * space-padded/truncated to 32 bytes) before comparison.
 * @returns A memcmp filter for `User` accounts with the given name.
 */
export function getUserWithName(name: string): MemcmpFilter {
	return {
		memcmp: {
			offset: 72,
			bytes: bs58.encode(Uint8Array.from(encodeName(name))),
		},
	};
}

/**
 * Builds a memcmp filter matching `User` accounts whose `poolId` (single byte, offset 4475) equals
 * `poolId`. Used to scope account scans to a specific isolated pool.
 * @param poolId - Pool id byte (0 = main/cross pool) to match.
 * @returns A memcmp filter for `User` accounts in the given pool.
 */
export function getUsersWithPoolId(poolId: number): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_POOL_ID_OFFSET,
			bytes: bs58.encode(Uint8Array.from([poolId])),
		},
	};
}

/**
 * Builds a `getProgramAccounts` memcmp filter matching the 8-byte Anchor discriminator of the
 * `UserStats` account type at offset 0. Use to fetch all `UserStats` accounts.
 * @returns A memcmp filter for `UserStats` accounts.
 */
export function getUserStatsFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('UserStats')),
		},
	};
}

/*
 * Byte offset of `referrer_status` in the `UserStats` account: 8 (discriminator)
 * + authority(32) + referrer(32) + fees(32) + maker/taker/filler volume 30d(24)
 * + last maker/taker/filler volume 30d ts(24) + if_staked_quote_asset_amount(8)
 * + number_of_sub_accounts(2) + number_of_sub_accounts_created(2) = 164.
 */
const USER_STATS_REFERRER_STATUS_OFFSET = 164;

/**
 * Builds a memcmp filter matching `UserStats` accounts whose `referrerStatus` bitflag byte (offset
 * 164) is exactly `ReferrerStatus.IsReferred` (2) — i.e. the account was referred and is *not*
 * also flagged `IsReferrer`. Because memcmp does an exact byte match rather than a bitwise test,
 * this excludes accounts that are both `IsReferrer` and `IsReferred` (byte value 3); use
 * `getUserStatsIsReferredOrReferrerFilter` for that combined case.
 * @returns A memcmp filter for `UserStats` accounts referred by (but not also referring) another user.
 */
export function getUserStatsIsReferredFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_STATS_REFERRER_STATUS_OFFSET,
			bytes: bs58.encode(Buffer.from(Uint8Array.from([2]))),
		},
	};
}

/**
 * Builds a memcmp filter matching `UserStats` accounts whose `referrerStatus` bitflag byte (offset
 * 164) is exactly 3 — i.e. `ReferrerStatus.IsReferrer | ReferrerStatus.IsReferred` both set on the
 * same account. Despite the name, this is an exact-byte match (memcmp can't test bits in
 * isolation), so it does *not* match an account that is only `IsReferrer` (1) or only `IsReferred`
 * (2) — use `getUserStatsIsReferredFilter` for the referred-only case.
 * @returns A memcmp filter for `UserStats` accounts with both the referrer and referred flags set.
 */
export function getUserStatsIsReferredOrReferrerFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_STATS_REFERRER_STATUS_OFFSET,
			bytes: bs58.encode(Buffer.from(Uint8Array.from([3]))),
		},
	};
}

/**
 * Builds a `getProgramAccounts` memcmp filter matching the 8-byte Anchor discriminator of the
 * `SignedMsgUserOrders` account type at offset 0. Use to fetch all swift/signed-message order
 * accounts.
 * @returns A memcmp filter for `SignedMsgUserOrders` accounts.
 */
export function getSignedMsgUserOrdersFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(
				BorshAccountsCoder.accountDiscriminator('SignedMsgUserOrders')
			),
		},
	};
}

/**
 * Builds a `getProgramAccounts` memcmp filter matching the 8-byte Anchor discriminator of the
 * `PerpMarket` account type at offset 0. Use to fetch all perp market accounts.
 * @returns A memcmp filter for `PerpMarket` accounts.
 */
export function getPerpMarketAccountsFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('PerpMarket')),
		},
	};
}
/**
 * Builds a `getProgramAccounts` memcmp filter matching the 8-byte Anchor discriminator of the
 * `SpotMarket` account type at offset 0. Use to fetch all spot market accounts.
 * @returns A memcmp filter for `SpotMarket` accounts.
 */
export function getSpotMarketAccountsFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('SpotMarket')),
		},
	};
}

/**
 * Builds a `getProgramAccounts` memcmp filter matching the 8-byte Anchor discriminator of the
 * `RevenueShareEscrow` account type at offset 0. Use to fetch all revenue-share escrow accounts
 * (builder-fee approvals/referral state).
 * @returns A memcmp filter for `RevenueShareEscrow` accounts.
 */
export function getRevenueShareEscrowFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(
				BorshAccountsCoder.accountDiscriminator('RevenueShareEscrow')
			),
		},
	};
}

/**
 * Builds a `getProgramAccounts` memcmp filter matching the 8-byte Anchor discriminator of the
 * `Constituent` account type at offset 0. Use to fetch all LP-pool constituent accounts.
 * @returns A memcmp filter for `Constituent` accounts.
 */
export function getConstituentFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(
				BorshAccountsCoder.accountDiscriminator('Constituent')
			),
		},
	};
}

/**
 * Builds a memcmp filter matching `Constituent` accounts belonging to a specific LP pool, by
 * comparing the `lpPool` pubkey field (32 bytes, offset 72) against `lpPoolPublicKey`.
 * @param lpPoolPublicKey - The `LpPool` account's pubkey to match constituents against.
 * @returns A memcmp filter for `Constituent` accounts of the given LP pool.
 */
export function getConstituentLpPoolFilter(
	lpPoolPublicKey: PublicKey
): MemcmpFilter {
	return {
		memcmp: {
			offset: 72,
			bytes: lpPoolPublicKey.toBase58(),
		},
	};
}
