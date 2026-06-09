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

export type RemainingAccountParams = {
	userAccounts: UserAccount[];
	writablePerpMarketIndexes?: number[];
	writableSpotMarketIndexes?: number[];
	readablePerpMarketIndex?: number | number[];
	readableSpotMarketIndexes?: number[];
	useMarketLastSlotCache?: boolean;
};

export type RemainingAccountsContext = {
	/** Used to resolve market accounts. */
	getPerpMarketAccount: (marketIndex: number) => PerpMarketAccount;
	getSpotMarketAccount: (marketIndex: number) => SpotMarketAccount;

	/** Used to resolve user's last slot for cache invalidation. */
	getUserAccountAndSlot: (
		subAccountId: number,
		authority: PublicKey
	) => { slot: number } | undefined;

	activeSubAccountId: number;
	authority: PublicKey;

	/** Mutable caches + forced-market sets (owned by caller). */
	perpMarketLastSlotCache: Map<number, number>;
	spotMarketLastSlotCache: Map<number, number>;
	mustIncludePerpMarketIndexes: Set<number>;
	mustIncludeSpotMarketIndexes: Set<number>;
};

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
			if (slot > lastUserSlot) {
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
			if (slot > lastUserSlot) {
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
