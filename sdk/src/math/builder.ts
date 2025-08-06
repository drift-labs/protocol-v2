import { RevenueShareOrder } from '../types';

const FLAG_IS_FILLED = 0x01;
export function isRevenueShareOrderFilled(order: RevenueShareOrder): boolean {
	return (order.bitFlags & FLAG_IS_FILLED) !== 0;
}

const FLAG_ORDER_IS_CANCELLED = 0x02;
export function isRevenueShareOrderCAncelled(
	order: RevenueShareOrder
): boolean {
	return (order.bitFlags & FLAG_ORDER_IS_CANCELLED) !== 0;
}
