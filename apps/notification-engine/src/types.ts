import {
	DepositRecord,
	FundingPaymentRecord,
	LiquidationRecord,
	NotificationType,
	OrderActionRecord,
	OrderRecord,
	RewardRecord,
	RiskBucket,
	SettlePnlRecord,
	SwapRecord,
} from '@backend/common';

import { DeviceRecord, NotificationRecord } from '@backend/common';

export interface NotificationProvider {
	id: string;
	isEnabled: () => boolean;
	canHandle: (notification: NotificationRecord) => boolean;
	sendNotification: (notification: NotificationRecord, devices?: DeviceRecord[]) => Promise<void>;
}

export interface OraclePriceData {
	oracle: string;
	symbol: string;
	price: number;
	confidence: number;
	timestamp: number;
	slot: number;
	priceChange: number;
}

export interface OracleData {
	price: number;
	confidence: number;
	slot: number;
}

export interface LastPriceInfo {
	price: number;
	lastPublished: number;
	confidence: number;
}

export interface PriceUpdate {
	symbol: string;
	oldPrice: number;
	newPrice: number;
}

interface BaseMessage {
	type: NotificationType;
}

export interface PriceMessage extends BaseMessage {
	type: NotificationType.PRICE_ALERT;
	data: OraclePriceData;
}

export interface RecordMessage extends BaseMessage {
	type: NotificationType.RECORD_UPDATE;
	data: any;
}

export interface AccountMessage extends BaseMessage {
	type: NotificationType.ACCOUNT_UPDATE;
	data: RiskNotification;
}

export type MessageBody = PriceMessage | RecordMessage | AccountMessage;

export interface Position {
	marketIndex: number;
	size: string;
	value: string;
	weight: string;
	weightedValue: string;
}

export interface UserPositions {
	deposits: Position[];
	borrows: Position[];
	perpPositions: Position[];
	perpPnl: Position[];
}

export interface PositionState {
	positions: UserPositions;
	health: {
		totalCollateral: number;
		marginRequirement: number;
		freeCollateral: number;
		healthRatio: number;
	};
}

export interface HealthComparison {
	user: string;
	sdkHealth: number;
	calculatedHealth: number;
	difference: number;
	percentageDiff: number;
	collateral: {
		sdk: number;
		calculated: number;
		difference: number;
	};
	margin: {
		sdk: number;
		calculated: number;
		difference: number;
	};
}

export interface RiskNotification {
	user: string;
	oldBucket: RiskBucket;
	newBucket: RiskBucket;
	healthRatio: number;
	timestamp: number;
}

export interface UserRiskData {
	user: string;
	healthRatio: number;
}

export interface VerificationDetail {
	user: string;
	status: 'verified' | 'mismatched' | 'failed';
	storedHealth?: number;
	currentHealth?: number;
	storedBucket?: RiskBucket;
	currentBucket?: RiskBucket;
	reason?: string;
}

export interface VerificationResults {
	total: number;
	verified: number;
	mismatched: number;
	failed: number;
	notificationsSent: number;
	details: VerificationDetail[];
}

export type UserUpdateRecord =
	| OrderRecord
	| OrderActionRecord
	| SettlePnlRecord
	| LiquidationRecord
	| DepositRecord
	| FundingPaymentRecord
	| SwapRecord
	| RewardRecord;
