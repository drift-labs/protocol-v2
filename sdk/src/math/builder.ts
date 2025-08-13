import { BuilderOrder } from '../types';

const FLAG_IS_OPEN = 0x01;
export function isBuilderOrderOpen(order: BuilderOrder): boolean {
	return (order.bitFlags & FLAG_IS_OPEN) !== 0;
}

const FLAG_IS_COMPLETED = 0x02;
export function isBuilderOrderCompleted(order: BuilderOrder): boolean {
	return (order.bitFlags & FLAG_IS_COMPLETED) !== 0;
}

export function isBuilderOrderAvailable(order: BuilderOrder): boolean {
	return !isBuilderOrderOpen(order) && !isBuilderOrderCompleted(order);
}
