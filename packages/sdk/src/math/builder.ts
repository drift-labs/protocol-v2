import { PublicKey } from '@solana/web3.js';
import { BN } from '../isomorphic/anchor';
import {
	OrderParams,
	ReferrerStatus,
	RevenueShareEscrowAccount,
	RevenueShareOrder,
	UserStatsAccount,
} from '../types';

const BUILDER_FEE_TENTH_BPS_DENOMINATOR = new BN(100_000);

/**
 * Calculates the builder fee charged on top of the tiered taker/maker fee, mirroring the
 * program's builder-fee calc. `builderFeeTenthBps` is denominated in tenth-basis-points, i.e.
 * `10 * builderFeeTenthBps == 1 bp == 0.01%` — the fee fraction is `builderFeeTenthBps / 100_000`.
 *
 * @param {BN} quoteAssetAmount - The fill's quote asset amount the fee is charged against,
 *   QUOTE_PRECISION (1e6)
 * @param {number} builderFeeTenthBps - The builder fee rate, in tenth-bps (`OrderParams.builderFeeTenthBps`)
 * @return {BN} The builder fee, QUOTE_PRECISION (1e6)
 */
export function calculateBuilderFee(
	quoteAssetAmount: BN,
	builderFeeTenthBps: number
): BN {
	return quoteAssetAmount
		.mul(new BN(builderFeeTenthBps))
		.div(BUILDER_FEE_TENTH_BPS_DENOMINATOR);
}

/**
 * True when the user's `RevenueShareEscrow` was initialized with a referrer.
 *
 * @param {Pick<UserStatsAccount, 'referrerStatus'>} userStats - The user's stats account (or a
 *   pick containing just `referrerStatus`)
 * @return {boolean} Whether `ReferrerStatus.BuilderReferral` is set in `referrerStatus`. When
 *   true, fills for this user must include the escrow account as a remaining account or the
 *   program rejects them with `UnableToLoadRevenueShareAccount`
 */
export function isBuilderReferral(
	userStats: Pick<UserStatsAccount, 'referrerStatus'>
): boolean {
	return (userStats.referrerStatus & ReferrerStatus.BuilderReferral) !== 0;
}

/**
 * True when the escrow was initialized with a referrer (its `referrer` field is not the default
 * pubkey).
 *
 * @param {Pick<RevenueShareEscrowAccount, 'referrer'>} escrow - The revenue share escrow account
 *   (or a pick containing just `referrer`)
 * @return {boolean} Whether `escrow.referrer` is set. Referral rewards accrue into such escrows on
 *   fills, so fills of the escrow owner's orders must include the escrow account (see `isBuilderReferral`)
 */
export function escrowHasReferrer(
	escrow: Pick<RevenueShareEscrowAccount, 'referrer'>
): boolean {
	return !escrow.referrer.equals(PublicKey.default);
}

/**
 * True when the order params carry a builder code (both `builderIdx` and `builderFeeTenthBps`
 * are set, i.e. neither `null` nor `undefined`).
 *
 * @param {Pick<OrderParams, 'builderIdx' | 'builderFeeTenthBps'>} orderParams - The order params
 *   (or a pick containing just the builder fields)
 * @return {boolean} Whether both builder fields are present
 */
export function hasBuilderParams(
	orderParams: Pick<OrderParams, 'builderIdx' | 'builderFeeTenthBps'>
): boolean {
	return (
		orderParams.builderIdx !== null &&
		orderParams.builderIdx !== undefined &&
		orderParams.builderFeeTenthBps !== null &&
		orderParams.builderFeeTenthBps !== undefined
	);
}

const FLAG_IS_OPEN = 0x01;
/**
 * True if this `RevenueShareOrder` slot is occupied by an active order, mirroring
 * `RevenueShareOrder::is_open` (`RevenueShareOrderBitFlag::Open`). While open, `orderId` and
 * `subAccountId` identify the live order this slot is tracking.
 *
 * @param {RevenueShareOrder} order - The revenue share order slot
 * @return {boolean} Whether the `Open` bit is set in `order.bitFlags`
 */
export function isBuilderOrderOpen(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_OPEN) !== 0;
}

const FLAG_IS_COMPLETED = 0x02;
/**
 * True if this `RevenueShareOrder` has been filled or canceled and is awaiting settlement into
 * the builder's account, mirroring `RevenueShareOrder::is_completed`
 * (`RevenueShareOrderBitFlag::Completed`). Once completed, `orderId`/`subAccountId` are no
 * longer meaningful and the slot's accrued fees may be merged with other completed orders.
 *
 * @param {RevenueShareOrder} order - The revenue share order slot
 * @return {boolean} Whether the `Completed` bit is set in `order.bitFlags`
 */
export function isBuilderOrderCompleted(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_COMPLETED) !== 0;
}

const FLAG_IS_REFERRAL = 0x04;
/**
 * True if this `RevenueShareOrder` slot instead holds referral rewards pending settlement for a
 * market (`RevenueShareOrderBitFlag::Referral`), rather than tracking a builder-fee order. When
 * set, no other bit flag should be set and `builderIdx` is ignored.
 *
 * @param {RevenueShareOrder} order - The revenue share order slot
 * @return {boolean} Whether the `Referral` bit is set in `order.bitFlags`
 */
export function isBuilderOrderReferral(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_REFERRAL) !== 0;
}

/**
 * True if this `RevenueShareOrder` slot is free to be (re)written — neither open nor completed —
 * mirroring `RevenueShareOrder::is_available`.
 *
 * @param {RevenueShareOrder} order - The revenue share order slot
 * @return {boolean} Whether the slot can be claimed for a new order
 */
export function isBuilderOrderAvailable(order: RevenueShareOrder): boolean {
	return !isBuilderOrderOpen(order) && !isBuilderOrderCompleted(order);
}
