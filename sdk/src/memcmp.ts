import { MemcmpFilter } from '@solana/web3.js';
import bs58 from 'bs58';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { encodeName } from './userName';

export function getUserFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 0,
			bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator('User')),
		},
	};
}

export function getNonIdleUserFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 4350,
			bytes: bs58.encode(Uint8Array.from([0])),
		},
	};
}

export function getUserWithOrderFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 4352,
			bytes: bs58.encode(Uint8Array.from([1])),
		},
	};
}

export function getUserWithoutOrderFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 4352,
			bytes: bs58.encode(Uint8Array.from([0])),
		},
	};
}

export function getUserWithAuctionFilter(): MemcmpFilter {
	return {
		memcmp: {
			offset: 4354,
			bytes: bs58.encode(Uint8Array.from([1])),
		},
	};
}

export function getUserThatHasBeenLP(): MemcmpFilter {
	return {
		memcmp: {
			offset: 4267,
			bytes: bs58.encode(Uint8Array.from([99])),
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
