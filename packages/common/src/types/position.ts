import { BaseDynamoRecord, TradeRecord } from '.';

export type PositionHistoryRecord = TradeRecord &
	BaseDynamoRecord & { baseClosedForPnl: number; userFee: number };
