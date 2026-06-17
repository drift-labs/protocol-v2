import { getPerpMarketSymbol, getSpotMarketSymbol } from '@backend/common';
import { PositionState, UserPositions } from '../types';

const PRECISION = 1e6;

export const PositionTracker = () => {
	const userPositions: Map<string, PositionState> = new Map();
	const marketUsers: Map<string, Set<string>> = new Map();
	const marketPrices: Map<string, number> = new Map();

	const calculateUserHealth = (positions: UserPositions) => {
		const depositWeightedValue =
			positions.deposits.reduce((sum, pos) => sum + parseInt(pos.weightedValue), 0) /
			PRECISION;

		const pnlValue =
			positions.perpPnl.reduce((sum, pos) => sum + parseInt(pos.value), 0) / PRECISION;

		const perpMarginRequirement =
			positions.perpPositions.reduce((sum, pos) => sum + parseInt(pos.weightedValue), 0) /
			PRECISION;

		const borrowMarginRequirement =
			positions.borrows.reduce((sum, pos) => sum + parseInt(pos.weightedValue), 0) /
			PRECISION;

		const marginRequirement = perpMarginRequirement + borrowMarginRequirement;

		const totalCollateral = depositWeightedValue + pnlValue;
		const freeCollateral = totalCollateral - marginRequirement;

		let healthRatio: number;
		if (marginRequirement === 0 && totalCollateral >= 0) {
			healthRatio = 100;
		} else if (totalCollateral <= 0) {
			healthRatio = 0;
		} else {
			healthRatio = Math.round(
				Math.min(100, Math.max(0, (1 - marginRequirement / totalCollateral) * 100))
			);
		}

		return {
			healthRatio,
			totalCollateral,
			marginRequirement,
			freeCollateral,
		};
	};

	const trackUserMarkets = (user: string, positions: UserPositions) => {
		positions.perpPositions.forEach((pos) => {
			const symbol = getPerpMarketSymbol(pos.marketIndex);
			if (!marketUsers.has(symbol)) {
				marketUsers.set(symbol, new Set());
			}
			marketUsers.get(symbol)!.add(user);
		});

		positions.deposits.forEach((pos) => {
			const symbol = getSpotMarketSymbol(pos.marketIndex);
			if (!marketUsers.has(symbol)) {
				marketUsers.set(symbol, new Set());
			}
			marketUsers.get(symbol)!.add(user);
		});
	};

	const initializeUserPosition = (user: string, positions: UserPositions) => {
		const health = calculateUserHealth(positions);
		userPositions.set(user, { positions, health });
		trackUserMarkets(user, positions);
	};

	const updatePrice = ({ symbol, price }: { symbol: string; price: number }) => {
		marketPrices.set(symbol, price);
		const users = marketUsers.get(symbol);

		if (!users) return [];

		const updatedUsers: string[] = [];

		users.forEach((user) => {
			const userState = userPositions.get(user);
			if (!userState) return;

			// TODO:
			// Apply update to the value of the users positions
			// Calculate user health

			updatedUsers.push(user);
		});

		return updatedUsers;
	};

	const updatePosition = ({ user }: { user: string }) => {
		// TODO:
		// CRUD of the users positions and calculate new value?
		// Perp position
		// Spot borrow
		return getUserState(user);
	};

	const getUserState = (user: string) => {
		return userPositions.get(user);
	};

	const getAllUserState = () => {
		return userPositions;
	};

	const getUsersBelowHealth = (threshold: number): string[] => {
		const atRiskUsers: string[] = [];
		userPositions.forEach((state, user) => {
			if (state.health.healthRatio < threshold) {
				atRiskUsers.push(user);
			}
		});
		return atRiskUsers;
	};

	return {
		initializeUserPosition,
		updatePrice,
		updatePosition,
		getUserState,
		getAllUserState,
		getUsersBelowHealth,
	};
};
