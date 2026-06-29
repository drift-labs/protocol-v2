import { MemcmpFilter, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { BorshAccountsCoder } from './isomorphic/anchor29';
import { encodeName } from './userName';

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

export function getNonIdleUserFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_IDLE_OFFSET,
			bytes: bs58.encode(Uint8Array.from([0])),
		},
	};
}

export function getUserWithOrderFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_HAS_OPEN_ORDER_OFFSET,
			bytes: bs58.encode(Uint8Array.from([1])),
		},
	};
}

export function getUserWithoutOrderFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_HAS_OPEN_ORDER_OFFSET,
			bytes: bs58.encode(Uint8Array.from([0])),
		},
	};
}

export function getUserWithAuctionFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_HAS_OPEN_AUCTION_OFFSET,
			bytes: bs58.encode(Uint8Array.from([1])),
		},
	};
}

export function getUserWithName(name: string): MemcmpFilter {
	return {
		memcmp: {
			offset: 72,
			bytes: bs58.encode(Uint8Array.from(encodeName(name))),
		},
	};
}

export function getUsersWithPoolId(poolId: number): MemcmpFilter {
	return {
		memcmp: {
			offset: USER_POOL_ID_OFFSET,
			bytes: bs58.encode(Uint8Array.from([poolId])),
		},
	};
}

export function getUserStatsFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('UserStats')),
		},
	};
}

export function getUserStatsIsReferredFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 188,
			bytes: bs58.encode(Buffer.from(Uint8Array.from([2]))),
		},
	};
}

export function getUserStatsIsReferredOrReferrerFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 188,
			bytes: bs58.encode(Buffer.from(Uint8Array.from([3]))),
		},
	};
}

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

export function getPerpMarketAccountsFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('PerpMarket')),
		},
	};
}
export function getSpotMarketAccountsFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('SpotMarket')),
		},
	};
}

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
