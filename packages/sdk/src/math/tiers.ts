import { isVariant, PerpMarketAccount, SpotMarketAccount } from '../types';

/**
 * Maps a perp market's `contractTier` to an ordinal safety rank, lower is safer. Matches the
 * declaration order of the Rust `ContractTier` enum (which derives `Ord` from declaration order,
 * used by `ContractTier::is_as_safe_as_contract`'s `self <= other`).
 *
 * @param {PerpMarketAccount} perpMarket - The perp market account
 * @return {number} `0` (A, safest) through `5` (Isolated, riskiest); `4` = HighlySpeculative
 */
export function getPerpMarketTierNumber(perpMarket: PerpMarketAccount): number {
	if (isVariant(perpMarket.contractTier, 'a')) {
		return 0;
	} else if (isVariant(perpMarket.contractTier, 'b')) {
		return 1;
	} else if (isVariant(perpMarket.contractTier, 'c')) {
		return 2;
	} else if (isVariant(perpMarket.contractTier, 'speculative')) {
		return 3;
	} else if (isVariant(perpMarket.contractTier, 'highlySpeculative')) {
		return 4;
	} else {
		return 5;
	}
}

/**
 * Maps a spot market's `assetTier` to an ordinal safety rank, lower is safer. Matches the
 * declaration order of the Rust `AssetTier` enum, used by `ContractTier::is_as_safe_as_asset`.
 *
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @return {number} `0` (Collateral, safest) through `4` (Unlisted, riskiest); `5` is unreachable
 *   (falls through only if `assetTier` matches none of the known variants)
 */
export function getSpotMarketTierNumber(spotMarket: SpotMarketAccount): number {
	if (isVariant(spotMarket.assetTier, 'collateral')) {
		return 0;
	} else if (isVariant(spotMarket.assetTier, 'protected')) {
		return 1;
	} else if (isVariant(spotMarket.assetTier, 'cross')) {
		return 2;
	} else if (isVariant(spotMarket.assetTier, 'isolated')) {
		return 3;
	} else if (isVariant(spotMarket.assetTier, 'unlisted')) {
		return 4;
	} else {
		return 5;
	}
}

/**
 * True if a perp market's tier is at least as safe as both a reference perp tier and a reference
 * spot tier, mirroring `ContractTier::is_as_safe_as`. Used to gate cross-margining: a position in
 * a market riskier than the account's other collateral/positions can force isolated margin.
 * A perp tier is "as safe as" a spot tier if the spot tier is Unlisted (anything beats Unlisted);
 * otherwise, if the spot tier is Cross or Isolated, the perp tier must be C-or-safer (tiers 0-2).
 *
 * @param {number} perpTier - This market's tier number, from `getPerpMarketTierNumber`
 * @param {number} otherPerpTier - The reference perp tier number to compare against
 * @param {number} otherSpotTier - The reference spot tier number to compare against, from
 *   `getSpotMarketTierNumber`
 * @return {boolean} Whether `perpTier` is as safe as both references
 */
export function perpTierIsAsSafeAs(
	perpTier: number,
	otherPerpTier: number,
	otherSpotTier: number
): boolean {
	const asSafeAsPerp = perpTier <= otherPerpTier;
	const asSafeAsSpot =
		otherSpotTier === 4 || (otherSpotTier >= 2 && perpTier <= 2);
	return asSafeAsSpot && asSafeAsPerp;
}
