import { RevenueShareOrder } from '../types';

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
