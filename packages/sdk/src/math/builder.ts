import { PublicKey } from '@solana/web3.js';
import {
	OrderParams,
	ReferrerStatus,
	RevenueShareEscrowAccount,
	RevenueShareOrder,
	UserStatsAccount,
} from '../types';

/**
 * True when the user's RevenueShareEscrow was initialized with a referrer.
 * Fills for such users must include the escrow account or the program rejects
 * them with UnableToLoadRevenueShareAccount.
 */
export function isBuilderReferral(
	userStats: Pick<UserStatsAccount, 'referrerStatus'>
): boolean {
	return (userStats.referrerStatus & ReferrerStatus.BuilderReferral) !== 0;
}

/**
 * True when the escrow was initialized with a referrer. Referral rewards
 * accrue into such escrows on fills, so fills of the escrow owner's orders
 * must include the escrow account (see `isBuilderReferral`).
 */
export function escrowHasReferrer(
	escrow: Pick<RevenueShareEscrowAccount, 'referrer'>
): boolean {
	return !escrow.referrer.equals(PublicKey.default);
}

/**
 * True when the order params carry a builder code (`builderIdx` +
 * `builderFeeTenthBps`).
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
export function isBuilderOrderOpen(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_OPEN) !== 0;
}

const FLAG_IS_COMPLETED = 0x02;
export function isBuilderOrderCompleted(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_COMPLETED) !== 0;
}

const FLAG_IS_REFERRAL = 0x04;
export function isBuilderOrderReferral(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_REFERRAL) !== 0;
}

export function isBuilderOrderAvailable(order: RevenueShareOrder): boolean {
	return !isBuilderOrderOpen(order) && !isBuilderOrderCompleted(order);
}
