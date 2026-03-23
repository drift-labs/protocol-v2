import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import {
	DEFAULT_ORACLE_CACHE_MAX_AGE_SLOTS,
	OracleCacheEntry,
	OracleSource,
	getOracleCacheDefaultMaxAgeSlots,
	getOracleCacheEntryMaxAgeSlots,
	getOracleCacheRefreshCandidates,
	getOracleInfosToRefresh,
	isOracleCacheEntryFresh,
	shouldRefreshOracleCacheEntry,
} from '../../src';
import { assert } from '../../src/assert/assert';

function makePublicKey(seed: number): PublicKey {
	return new PublicKey(new Uint8Array(32).fill(seed));
}

function makeEntry(args?: Partial<OracleCacheEntry>): OracleCacheEntry {
	return {
		publicKey: makePublicKey(1),
		source: OracleSource.PYTH,
		cachedSlot: new BN(100),
		maxAgeSlotsOverride: 0,
		...args,
	};
}

describe('Oracle Cache Keeper Tests', () => {
	it('treats cache maxAgeSlots=0 as the default keeper threshold', () => {
		assert(
			getOracleCacheDefaultMaxAgeSlots(0) ===
				DEFAULT_ORACLE_CACHE_MAX_AGE_SLOTS
		);
		assert(
			getOracleCacheDefaultMaxAgeSlots(new BN(45)) ===
				45
		);
	});

	it('refreshes seeded entries that have never been populated', () => {
		const entry = makeEntry({ cachedSlot: new BN(0) });

		assert(!isOracleCacheEntryFresh(entry, new BN(50), 60));
		assert(shouldRefreshOracleCacheEntry(entry, new BN(50), 60));
	});

	it('skips entries that are still comfortably fresh', () => {
		const entry = makeEntry({ cachedSlot: 150 });

		assert(isOracleCacheEntryFresh(entry, 180, 60));
		assert(!shouldRefreshOracleCacheEntry(entry, 180, 60));
	});

	it('refreshes entries once they hit the keeper threshold', () => {
		const entry = makeEntry({ cachedSlot: 100 });

		assert(isOracleCacheEntryFresh(entry, 160, 60));
		assert(shouldRefreshOracleCacheEntry(entry, 160, 60));
		assert(!isOracleCacheEntryFresh(entry, 161, 60));
	});

	it('honors per-entry max age overrides', () => {
		const strictEntry = makeEntry({
			publicKey: makePublicKey(2),
			maxAgeSlotsOverride: 20,
		});
		const relaxedEntry = makeEntry({
			publicKey: makePublicKey(3),
			maxAgeSlotsOverride: new BN(120),
		});

		assert(getOracleCacheEntryMaxAgeSlots(strictEntry, 60) === 20);
		assert(getOracleCacheEntryMaxAgeSlots(relaxedEntry, 60) === 120);
		assert(!isOracleCacheEntryFresh(strictEntry, 130, 60));
		assert(isOracleCacheEntryFresh(relaxedEntry, 130, 60));
	});

	it('can prewarm entries before they become stale', () => {
		const entries = [
			makeEntry({
				publicKey: makePublicKey(4),
				cachedSlot: 145,
			}),
			makeEntry({
				publicKey: makePublicKey(5),
				cachedSlot: 100,
			}),
			makeEntry({
				publicKey: makePublicKey(6),
				cachedSlot: 0,
			}),
		];

		const candidates = getOracleCacheRefreshCandidates(entries, 200, 60, {
			prewarmSlots: 10,
		});
		const oraclesToRefresh = getOracleInfosToRefresh(entries, 200, 60, {
			prewarmSlots: 10,
		});

		assert(candidates.length === 3);
		assert(candidates[0].isFresh);
		assert(candidates[0].shouldRefresh);
		assert(candidates[0].ageSlots === 55);
		assert(candidates[0].maxAgeSlots === 60);

		assert(candidates[1].isStale);
		assert(candidates[1].shouldRefresh);
		assert(candidates[2].isStale);
		assert(candidates[2].shouldRefresh);

		assert(oraclesToRefresh.length === 3);
		assert(oraclesToRefresh[0].publicKey.equals(makePublicKey(4)));
		assert(oraclesToRefresh[1].publicKey.equals(makePublicKey(5)));
		assert(oraclesToRefresh[2].publicKey.equals(makePublicKey(6)));
	});
});
