import { BN } from '@coral-xyz/anchor';
import { OracleInfo } from './types';

export const DEFAULT_ORACLE_CACHE_MAX_AGE_SLOTS = 60;

export type OracleCacheSlot = BN | number;

export type OracleCacheEntry = OracleInfo & {
	cachedSlot: OracleCacheSlot;
	maxAgeSlotsOverride?: OracleCacheSlot | null;
};

export type OracleCacheRefreshConfig = {
	prewarmSlots?: OracleCacheSlot;
};

export type OracleCacheRefreshCandidate = OracleCacheEntry & {
	ageSlots: number;
	maxAgeSlots: number;
	isFresh: boolean;
	isStale: boolean;
	shouldRefresh: boolean;
};

function toSlotNumber(value?: OracleCacheSlot | null): number {
	if (value === undefined || value === null) {
		return 0;
	}

	if (value instanceof BN) {
		return value.toNumber();
	}

	return value;
}

export function getOracleCacheDefaultMaxAgeSlots(
	cacheMaxAgeSlots?: OracleCacheSlot | null
): number {
	const maxAgeSlots = toSlotNumber(cacheMaxAgeSlots);
	return maxAgeSlots === 0 ? DEFAULT_ORACLE_CACHE_MAX_AGE_SLOTS : maxAgeSlots;
}

export function getOracleCacheEntryMaxAgeSlots(
	entry: Pick<OracleCacheEntry, 'maxAgeSlotsOverride'>,
	cacheMaxAgeSlots?: OracleCacheSlot | null
): number {
	const overrideMaxAgeSlots = toSlotNumber(entry.maxAgeSlotsOverride);
	return overrideMaxAgeSlots > 0
		? overrideMaxAgeSlots
		: getOracleCacheDefaultMaxAgeSlots(cacheMaxAgeSlots);
}

export function getOracleCacheEntryAgeSlots(
	entry: Pick<OracleCacheEntry, 'cachedSlot'>,
	currentSlot: OracleCacheSlot
): number {
	return Math.max(
		0,
		toSlotNumber(currentSlot) - toSlotNumber(entry.cachedSlot)
	);
}

export function isOracleCacheEntryFresh(
	entry: Pick<OracleCacheEntry, 'cachedSlot' | 'maxAgeSlotsOverride'>,
	currentSlot: OracleCacheSlot,
	cacheMaxAgeSlots?: OracleCacheSlot | null
): boolean {
	if (toSlotNumber(entry.cachedSlot) === 0) {
		return false;
	}

	return (
		getOracleCacheEntryAgeSlots(entry, currentSlot) <=
		getOracleCacheEntryMaxAgeSlots(entry, cacheMaxAgeSlots)
	);
}

export function shouldRefreshOracleCacheEntry(
	entry: Pick<OracleCacheEntry, 'cachedSlot' | 'maxAgeSlotsOverride'>,
	currentSlot: OracleCacheSlot,
	cacheMaxAgeSlots?: OracleCacheSlot | null,
	config?: OracleCacheRefreshConfig
): boolean {
	if (toSlotNumber(entry.cachedSlot) === 0) {
		return true;
	}

	const maxAgeSlots = getOracleCacheEntryMaxAgeSlots(entry, cacheMaxAgeSlots);
	const prewarmSlots = Math.max(0, toSlotNumber(config?.prewarmSlots));
	const refreshThreshold = Math.max(0, maxAgeSlots - prewarmSlots);

	return getOracleCacheEntryAgeSlots(entry, currentSlot) >= refreshThreshold;
}

export function getOracleCacheRefreshCandidates(
	entries: OracleCacheEntry[],
	currentSlot: OracleCacheSlot,
	cacheMaxAgeSlots?: OracleCacheSlot | null,
	config?: OracleCacheRefreshConfig
): OracleCacheRefreshCandidate[] {
	return entries.map((entry) => {
		const ageSlots = getOracleCacheEntryAgeSlots(entry, currentSlot);
		const maxAgeSlots = getOracleCacheEntryMaxAgeSlots(entry, cacheMaxAgeSlots);
		const isFresh = isOracleCacheEntryFresh(
			entry,
			currentSlot,
			cacheMaxAgeSlots
		);

		return {
			...entry,
			ageSlots,
			maxAgeSlots,
			isFresh,
			isStale: !isFresh,
			shouldRefresh: shouldRefreshOracleCacheEntry(
				entry,
				currentSlot,
				cacheMaxAgeSlots,
				config
			),
		};
	});
}

export function getOracleInfosToRefresh(
	entries: OracleCacheEntry[],
	currentSlot: OracleCacheSlot,
	cacheMaxAgeSlots?: OracleCacheSlot | null,
	config?: OracleCacheRefreshConfig
): OracleInfo[] {
	return getOracleCacheRefreshCandidates(
		entries,
		currentSlot,
		cacheMaxAgeSlots,
		config
	)
		.filter((entry) => entry.shouldRefresh)
		.map(({ publicKey, source }) => ({
			publicKey,
			source,
		}));
}
