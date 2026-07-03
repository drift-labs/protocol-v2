import { PublicKey, type AccountMeta } from '@solana/web3.js';
import { isVariant } from '../types';
import { QUOTE_SPOT_MARKET_INDEX, ZERO } from '../constants/numericConstants';
import { isSpotPositionAvailable } from '../math/spotPosition';
import { positionIsAvailable } from '../math/position';
import type {
	UserAccount,
	SpotMarketAccount,
	PerpMarketAccount,
} from '../types';

/**
 * Per-call inputs to `getRemainingAccounts`, describing which markets and users' open
 * positions must be represented in the built `remainingAccounts` list.
 */
export type RemainingAccountParams = {
	/** Every open (non-available) spot/perp position across these accounts is included — this is how a `User`'s own margined positions get their market + oracle accounts passed to an instruction. */
	userAccounts: UserAccount[];
	/** Perp market indexes to include as writable (plus their oracle and quote spot market), in addition to whatever `userAccounts`' positions already require. */
	writablePerpMarketIndexes?: number[];
	/** Spot market indexes to include as writable (plus their oracle), in addition to whatever `userAccounts`' positions already require. */
	writableSpotMarketIndexes?: number[];
	/** Perp market index(es) to include as read-only (plus their oracle and quote spot market) — typically the market(s) an instruction is acting on. */
	readablePerpMarketIndex?: number | number[];
	/** Spot market indexes to include as read-only (plus their oracle). */
	readableSpotMarketIndexes?: number[];
	/** If true, also re-includes any market still tracked in `ctx.perpMarketLastSlotCache` / `ctx.spotMarketLastSlotCache` whose cached slot is newer than the resolved user's last-active slot — a cache-invalidation guard so a market touched by a very recent instruction doesn't get dropped from the very next one before its state can be considered "seen" by the user account. Stale cache entries (slot ≤ the user's last-active slot) are evicted as a side effect. */
	useMarketLastSlotCache?: boolean;
};

/**
 * Caller-supplied hooks and mutable state `getRemainingAccounts` needs to resolve market
 * accounts and apply cache-invalidation logic without depending on a subscribed
 * `VelocityClient`. All fields are read (and the `Map`/`Set` fields also mutated in
 * place — entries may be added or evicted) by `getRemainingAccounts`; the caller owns
 * their lifetime and should typically persist them across calls for the caches to be
 * useful.
 */
export type RemainingAccountsContext = {
	/** Resolves a perp market index to its loaded `PerpMarketAccount` (including `pubkey`, `oracle`, `oracleSource`, `quoteSpotMarketIndex`). Should throw or the caller should ensure the market is loaded before calling. */
	getPerpMarketAccount: (marketIndex: number) => PerpMarketAccount;
	/** Resolves a spot market index to its loaded `SpotMarketAccount` (including `pubkey` and `oracle`). */
	getSpotMarketAccount: (marketIndex: number) => SpotMarketAccount;

	/** Resolves a user's most recent on-chain-active slot, used to decide whether cached markets from `perpMarketLastSlotCache`/`spotMarketLastSlotCache` are still relevant. Returns `undefined` if the user account isn't known/loaded, in which case cache entries are treated as stale and dropped. */
	getUserAccountAndSlot: (
		subAccountId: number | undefined,
		authority: PublicKey
	) => { slot: number } | undefined;

	/** Sub-account id used (together with `authority`) to look up the acting user when `params.userAccounts` is empty and `useMarketLastSlotCache` is set. */
	activeSubAccountId: number | undefined;
	/** Wallet authority used (together with `activeSubAccountId`) for the same lookup. */
	authority: PublicKey;

	/** Mutable cache of perp market index → last slot it was touched at; consulted (and pruned) only when `params.useMarketLastSlotCache` is true. Owned by the caller. */
	perpMarketLastSlotCache: Map<number, number>;
	/** Mutable cache of spot market index → last slot it was touched at; consulted (and pruned) only when `params.useMarketLastSlotCache` is true. Owned by the caller. */
	spotMarketLastSlotCache: Map<number, number>;
	/** Perp market indexes that must always be included as read-only, regardless of `params` (e.g. markets forced in by other in-flight instructions in the same transaction). Owned by the caller. */
	mustIncludePerpMarketIndexes: Set<number>;
	/** Spot market indexes that must always be included as read-only, regardless of `params`. Owned by the caller. */
	mustIncludeSpotMarketIndexes: Set<number>;
};

/**
 * Builds the ordered `remainingAccounts: AccountMeta[]` that Velocity trading/keeper
 * instructions require — one `AccountMeta` per oracle, then per spot market, then per
 * perp market, deduplicated by pubkey/index. This is the pure, subscription-free
 * equivalent of `VelocityClient`'s internal remaining-accounts builder: pass it whatever
 * markets/positions are relevant and it derives the same account set an instruction
 * builder (`buildDepositInstruction`, `buildPlacePerpOrderInstruction`, etc.) expects in
 * its `remainingAccounts` argument.
 *
 * Every open position on `params.userAccounts` contributes its market (+ oracle); open
 * spot positions with resting orders (`openAsks`/`openBids` non-zero) also pull in the
 * quote spot market so margin can be computed against it. `params.writable*`/`readable*`
 * indexes are added on top, and an oracle is marked writable only for a perp market on a
 * `prelaunch` oracle source being written to (needed so the prelaunch oracle CPI can
 * update its own account).
 *
 * @param ctx - resolver hooks and caller-owned mutable caches (see `RemainingAccountsContext`).
 * @param params - which markets/positions to include for this call (see `RemainingAccountParams`).
 * @returns the deduplicated `AccountMeta[]`, ordered oracles → spot markets → perp markets.
 */
export function getRemainingAccounts(
	ctx: RemainingAccountsContext,
	params: RemainingAccountParams
): AccountMeta[] {
	const { oracleAccountMap, spotMarketAccountMap, perpMarketAccountMap } =
		getRemainingAccountMapsForUsers(ctx, params.userAccounts);

	if (params.useMarketLastSlotCache) {
		const lastUserSlot = ctx.getUserAccountAndSlot(
			params.userAccounts.length > 0
				? params.userAccounts[0].subAccountId
				: ctx.activeSubAccountId,
			params.userAccounts.length > 0
				? params.userAccounts[0].authority
				: ctx.authority
		)?.slot;

		for (const [marketIndex, slot] of ctx.perpMarketLastSlotCache.entries()) {
			if (lastUserSlot !== undefined && slot > lastUserSlot) {
				addPerpMarketToRemainingAccountMaps(
					ctx,
					marketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap,
					perpMarketAccountMap
				);
			} else {
				ctx.perpMarketLastSlotCache.delete(marketIndex);
			}
		}

		for (const [marketIndex, slot] of ctx.spotMarketLastSlotCache.entries()) {
			if (lastUserSlot !== undefined && slot > lastUserSlot) {
				addSpotMarketToRemainingAccountMaps(
					ctx,
					marketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap
				);
			} else {
				ctx.spotMarketLastSlotCache.delete(marketIndex);
			}
		}
	}

	if (params.readablePerpMarketIndex !== undefined) {
		const readablePerpMarketIndexes = Array.isArray(
			params.readablePerpMarketIndex
		)
			? params.readablePerpMarketIndex
			: [params.readablePerpMarketIndex];
		for (const marketIndex of readablePerpMarketIndexes) {
			addPerpMarketToRemainingAccountMaps(
				ctx,
				marketIndex,
				false,
				oracleAccountMap,
				spotMarketAccountMap,
				perpMarketAccountMap
			);
		}
	}

	for (const perpMarketIndex of ctx.mustIncludePerpMarketIndexes.values()) {
		addPerpMarketToRemainingAccountMaps(
			ctx,
			perpMarketIndex,
			false,
			oracleAccountMap,
			spotMarketAccountMap,
			perpMarketAccountMap
		);
	}

	if (params.readableSpotMarketIndexes !== undefined) {
		for (const readableSpotMarketIndex of params.readableSpotMarketIndexes) {
			addSpotMarketToRemainingAccountMaps(
				ctx,
				readableSpotMarketIndex,
				false,
				oracleAccountMap,
				spotMarketAccountMap
			);
		}
	}

	for (const spotMarketIndex of ctx.mustIncludeSpotMarketIndexes.values()) {
		addSpotMarketToRemainingAccountMaps(
			ctx,
			spotMarketIndex,
			false,
			oracleAccountMap,
			spotMarketAccountMap
		);
	}

	if (params.writablePerpMarketIndexes !== undefined) {
		for (const writablePerpMarketIndex of params.writablePerpMarketIndexes) {
			addPerpMarketToRemainingAccountMaps(
				ctx,
				writablePerpMarketIndex,
				true,
				oracleAccountMap,
				spotMarketAccountMap,
				perpMarketAccountMap
			);
		}
	}

	if (params.writableSpotMarketIndexes !== undefined) {
		for (const writableSpotMarketIndex of params.writableSpotMarketIndexes) {
			addSpotMarketToRemainingAccountMaps(
				ctx,
				writableSpotMarketIndex,
				true,
				oracleAccountMap,
				spotMarketAccountMap
			);
		}
	}

	return [
		...oracleAccountMap.values(),
		...spotMarketAccountMap.values(),
		...perpMarketAccountMap.values(),
	];
}

function addPerpMarketToRemainingAccountMaps(
	ctx: RemainingAccountsContext,
	marketIndex: number,
	writable: boolean,
	oracleAccountMap: Map<string, AccountMeta>,
	spotMarketAccountMap: Map<number, AccountMeta>,
	perpMarketAccountMap: Map<number, AccountMeta>
): void {
	const perpMarketAccount = ctx.getPerpMarketAccount(marketIndex);
	perpMarketAccountMap.set(marketIndex, {
		pubkey: perpMarketAccount.pubkey,
		isSigner: false,
		isWritable: writable,
	});
	const oracleWritable =
		writable && isVariant(perpMarketAccount.oracleSource, 'prelaunch');
	oracleAccountMap.set(perpMarketAccount.oracle.toString(), {
		pubkey: perpMarketAccount.oracle,
		isSigner: false,
		isWritable: oracleWritable,
	});
	addSpotMarketToRemainingAccountMaps(
		ctx,
		perpMarketAccount.quoteSpotMarketIndex,
		false,
		oracleAccountMap,
		spotMarketAccountMap
	);
}

function addSpotMarketToRemainingAccountMaps(
	ctx: RemainingAccountsContext,
	marketIndex: number,
	writable: boolean,
	oracleAccountMap: Map<string, AccountMeta>,
	spotMarketAccountMap: Map<number, AccountMeta>
): void {
	const spotMarketAccount = ctx.getSpotMarketAccount(marketIndex);
	spotMarketAccountMap.set(spotMarketAccount.marketIndex, {
		pubkey: spotMarketAccount.pubkey,
		isSigner: false,
		isWritable: writable,
	});
	if (!spotMarketAccount.oracle.equals(PublicKey.default)) {
		oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
			pubkey: spotMarketAccount.oracle,
			isSigner: false,
			isWritable: false,
		});
	}
}

function getRemainingAccountMapsForUsers(
	ctx: RemainingAccountsContext,
	userAccounts: UserAccount[]
): {
	oracleAccountMap: Map<string, AccountMeta>;
	spotMarketAccountMap: Map<number, AccountMeta>;
	perpMarketAccountMap: Map<number, AccountMeta>;
} {
	const oracleAccountMap = new Map<string, AccountMeta>();
	const spotMarketAccountMap = new Map<number, AccountMeta>();
	const perpMarketAccountMap = new Map<number, AccountMeta>();

	for (const userAccount of userAccounts) {
		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				addSpotMarketToRemainingAccountMaps(
					ctx,
					spotPosition.marketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap
				);

				if (
					!spotPosition.openAsks.eq(ZERO) ||
					!spotPosition.openBids.eq(ZERO)
				) {
					addSpotMarketToRemainingAccountMaps(
						ctx,
						QUOTE_SPOT_MARKET_INDEX,
						false,
						oracleAccountMap,
						spotMarketAccountMap
					);
				}
			}
		}
		for (const position of userAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				addPerpMarketToRemainingAccountMaps(
					ctx,
					position.marketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap,
					perpMarketAccountMap
				);
			}
		}
	}

	return { oracleAccountMap, spotMarketAccountMap, perpMarketAccountMap };
}
