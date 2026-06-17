import { getTimestamp, logger, NotificationType, OrderLabel } from '@backend/common';
import { NotificationRepository } from '@backend/dynamodb';
import Decimal from 'decimal.js';

export const getNotificationTitle = () => {
	return 'test title';
};
export const getNotificationBody = () => {
	return 'test body';
};

export const getLiquidationWarningTitle = () => {
	return 'Liquidation warning!';
};
export const getLiquidationWarningBody = () => {
	return 'Your account health is below 20% and is facing liquidation. Please deposit more collateral or manage your position!';
};

export const getIsolatedPositionLiquidationWarningTitle = (symbols?: string[] | string) => {
	const label = Array.isArray(symbols) ? symbols.join(', ') : symbols;
	return label
		? `Isolated position liquidation warning (${label})!`
		: 'Isolated position liquidation warning!';
};
export const getIsolatedPositionLiquidationWarningBody = (symbols?: string[] | string) => {
	const label = Array.isArray(symbols) ? symbols.join(', ') : symbols;
	const subject =
		label && (Array.isArray(symbols) ? symbols.length > 1 : false)
			? `Your isolated positions (${label})`
			: label
			? `Your isolated position (${label})`
			: 'Your isolated position';
	return `${subject} health is below 20% and is facing liquidation. Please deposit more collateral or manage your position!`;
};

export const getLiquidationAlertTitle = () => {
	return 'Liquidation called!';
};
export const getLiquidationAlertBody = () => {
	return 'We regret to inform you that your cross account has been triggered into liquidation.';
};

export const getIsolatedPositionLiquidationAlertTitle = (symbols?: string[] | string) => {
	const label = Array.isArray(symbols) ? symbols.join(', ') : symbols;
	return label
		? `Isolated position liquidation called (${label})!`
		: 'Isolated position liquidation called!';
};
export const getIsolatedPositionLiquidationAlertBody = (symbols?: string[] | string) => {
	const label = Array.isArray(symbols) ? symbols.join(', ') : symbols;
	const subject =
		label && (Array.isArray(symbols) ? symbols.length > 1 : false)
			? `Your isolated positions (${label})`
			: label
			? `Your isolated position (${label})`
			: 'Your isolated position';
	return `We regret to inform you that ${subject.toLowerCase()} has been triggered into liquidation.`;
};

export const checkNotificationCooldown = async (
	authorityId: string,
	notificationType: NotificationType,
	cooldownDuration: number
): Promise<boolean> => {
	const { getLastNotificationByType } = NotificationRepository();

	const lastNotification = await getLastNotificationByType({
		authorityId,
		type: notificationType,
	});

	if (!lastNotification) {
		return false;
	}

	const createdAtTime = lastNotification.createdAt ?? 0;
	const timeSinceLastNotification = getTimestamp() - createdAtTime;
	const inCooldown = timeSinceLastNotification < cooldownDuration;

	if (inCooldown) {
		logger.info(
			`Authority ${authorityId} is in cooldown period for ${notificationType}. Notification: ${
				lastNotification.notificationId
			}, Age: ${Math.floor(timeSinceLastNotification / 60)} minutes`
		);
	}

	return inCooldown;
};

export const checkNotificationAge = (timestamp: number, maxAgeSeconds: number): boolean => {
	const now = getTimestamp();
	const age = now - timestamp;
	return age > maxAgeSeconds;
};

const ORDER_FILL_LABELS: Record<OrderLabel, string> = {
	[OrderLabel.MARKET]: 'Market Order',
	[OrderLabel.LIMIT]: 'Limit Order',
	[OrderLabel.ORACLE]: 'Oracle Order',
	[OrderLabel.ORACLE_LIMIT]: 'Oracle Limit Order',
	[OrderLabel.STOP_MARKET]: 'SL Market Order',
	[OrderLabel.STOP_LIMIT]: 'SL Limit Order',
	[OrderLabel.TAKE_PROFIT_MARKET]: 'TP Market Order',
	[OrderLabel.TAKE_PROFIT_LIMIT]: 'TP Limit Order',
};

const toPlainString = (value: Decimal) => {
	return value.toFixed(value.decimalPlaces() ?? 0);
};

export const formatNumber = (value: number, maximumFractionDigits = 10) => {
	const decimal = new Decimal(value);
	if (decimal.isZero()) {
		return '0';
	}
	if (decimal.abs().gte(1)) {
		const decimalPlaces = Math.min(decimal.decimalPlaces() ?? 0, maximumFractionDigits);
		return decimal.toFixed(decimalPlaces);
	}
	return toPlainString(decimal.toSignificantDigits(Math.min(maximumFractionDigits, 6)));
};

export const getOrderFillNotificationTitle = (orderType: OrderLabel) => {
	return `${ORDER_FILL_LABELS[orderType] || 'Order'} Filled`;
};

export const getOrderFillNotificationBody = ({
	orderType,
	size,
	symbol,
	price,
}: {
	orderType: OrderLabel;
	size: number;
	symbol: string;
	price: number;
}) => {
	return `Your ${ORDER_FILL_LABELS[orderType] || 'Order'} of ${formatNumber(
		size
	)} ${symbol} at $${formatNumber(price)} has been filled`;
};
