export type ExportMode = 'velocity' | 'drift';

export enum ExportFileType {
	Trades = 'trades',
	MarketTrades = 'market-trades',
	FundingRates = 'funding-rates',
	FundingPayments = 'funding-payments',
	Deposits = 'deposits',
	Liquidations = 'liquidations',
	SettlePnlRecords = 'settle-pnl-records',
	LpRecords = 'lp-records',
	IfStakeRecords = 'if-stake-records',
	SwapRecords = 'swap-records',
	Rewards = 'rewards',
}

export enum ExportStatus {
	Pending = 'PENDING',
	InProgress = 'IN_PROGRESS',
	Ready = 'READY',
	Failed = 'FAILED',
}

export interface ExportJobRow {
	pk: string;
	sk: string;
	requestId: string;
	authority: string;
	mode: ExportMode;
	status: ExportStatus;
	fileType: ExportFileType;
	from: number;
	to: number;
	userPublicKeys: string[];
	market?: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	s3Key?: string;
	recordCount?: number;
	errorReason?: string;
	expiresAt: number;
}

export interface ExportQueueMessage {
	requestId: string;
	authority: string;
	createdAt: number;
	mode: ExportMode;
}

export interface ExportSubmitPayload {
	fileType: ExportFileType;
	from: number;
	to: number;
	userPublicKeys: string[];
	market?: string;
}
