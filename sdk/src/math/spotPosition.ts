import { SpotPosition } from '../types';
import { ZERO } from '../constants/numericConstants';

export function isSpotPositionAvailable(position: SpotPosition): boolean {
	return position.balance.eq(ZERO) && position.openOrders === 0;
}
