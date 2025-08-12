import { RevenueShareOrder } from '../types';

const FLAG_IS_OPEN = 0x01;
export function isRevenueShareOrderOpen(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_OPEN) !== 0;
}

const FLAG_IS_COMPLETED = 0x02;
export function isRevenueShareOrderCompleted(
	order: RevenueShareOrder
): boolean {
	return (order.bitFlags & FLAG_IS_COMPLETED) !== 0;
}

export function isRevenueShareOrderAvailable(
	order: RevenueShareOrder
): boolean {
	return (
		!isRevenueShareOrderOpen(order) && !isRevenueShareOrderCompleted(order)
	);
}
