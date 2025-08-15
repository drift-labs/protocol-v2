import { ZERO } from '../constants/numericConstants';
import { hasOpenOrders } from './position';
import { isVariant } from '../types';
import { User } from '../user';

export function isUserBankrupt(user: User): boolean {
	const userAccount = user.getUserAccount();
	let hasLiability = false;
	for (const position of userAccount.spotPositions) {
		if (position.scaledBalance.gt(ZERO)) {
			if (isVariant(position.balanceType, 'deposit')) {
				return false;
			}
			if (isVariant(position.balanceType, 'borrow')) {
				hasLiability = true;
			}
		}
	}

	for (const position of userAccount.perpPositions) {
		if (
			!position.baseAssetAmount.eq(ZERO) ||
			position.quoteAssetAmount.gt(ZERO) ||
			hasOpenOrders(position)
		) {
			return false;
		}

		if (position.quoteAssetAmount.lt(ZERO)) {
			hasLiability = true;
		}
	}

	return hasLiability;
}
