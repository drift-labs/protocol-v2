import {
	AlertDirection,
	AlertRecord,
	DBRecord,
	DepositRecord,
	DeviceRecord,
	EarnSnapshotRecord,
	EntityTypes,
	FundingPaymentRecord,
	FundingRateRecord,
	getTimestamp,
	GRPC_RECORD_TTL_MINS,
	IngestionSource,
	InsuranceFundRecord,
	InsuranceFundStakeRecord,
	LiquidationRecord,
	LPRecord,
	NotificationRecord,
	NotificationStatus,
	NotificationType,
	OrderActionRecord,
	OrderFillStatusRecord,
	OrderRecord,
	RECORD_TTL_DAYS,
	RecordTypes,
	RewardRecord,
	SerializedMarketFilter,
	SettlePnlRecord,
	SwapRecord,
	TradeRecord,
	VaultDepositorRecord,
	VaultDepositorSnapshotRecord,
	VaultSnapshotRecord,
	WhitelistRecord,
} from '@backend/common';
import {
	authorityMapKeys,
	cumulativeVaultDepositKeys,
	getBaseRecordFields,
	getRecordKeys,
} from '../src/utils';

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
}));

describe('getRecordKeys', () => {
	it('should return correct keys for OrderRecord', () => {
		const orderRecord: OrderRecord = {
			user: 'user456',
			slot: 123,
			ts: 9876543210,
			txSig: '123',
			marketType: 'perp',
			marketFilter: 'perp',
			symbol: 'SOL-PERP',
			txSigIndex: 23,
			orderId: 123,
		} as OrderRecord;

		const result = getRecordKeys(orderRecord, RecordTypes.OrderRecord);

		expect(result).toEqual({
			pk: 'USER#user456',
			sk: 'ORDER#TYPE#PERP#TS#9876543210#ID#123',
			GSI1PK: 'USER#user456',
			GSI1SK: 'ORDER#MARKET#SOL-PERP#TS#9876543210#ID#123',
			GSI2PK: 'USER#user456#ORDER#123',
			GSI2SK: 'ORDER#TS#9876543210#ID#123',
		});
	});

	it('should return correct keys for OrderActionRecord', () => {
		const orderActionRecord: OrderActionRecord = {
			user: 'user456',
			slot: 123,
			ts: 9876543210,
			txSig: '123',
			txSigIndex: 123,
			userOrderId: 123,
		} as OrderActionRecord;

		const result = getRecordKeys(orderActionRecord, RecordTypes.OrderActionRecord);

		expect(result).toEqual({
			pk: 'USER#user456#ORDER#123',
			sk: 'ORDER_ACTION#TS#9876543210#SLOT#123#SIG#123#INDEX#00123',
		});
	});

	it('should return correct keys for OrderFillStatusRecord', () => {
		const orderFillStatusRecord: OrderFillStatusRecord = {
			user: 'user456',
			orderId: 123,
			ts: 9876543210,
			marketFilter: SerializedMarketFilter.PERP,
			symbol: 'SOL-PERP',
		};

		const result = getRecordKeys(orderFillStatusRecord, RecordTypes.OrderFillStatusRecord);

		expect(result).toEqual({
			pk: 'USER#user456',
			sk: 'ORDER_FILLED#ID#123',
			GSI1PK: 'USER#user456',
			GSI1SK: 'ORDER_FILLED#MARKET#SOL-PERP#TS#9876543210#ID#123',
			GSI2PK: 'USER#user456',
			GSI2SK: 'ORDER_FILLED#TYPE#PERP#TS#9876543210#ID#123',
		});
	});

	it('should return correct keys for DepositRecord', () => {
		const depositRecord: DepositRecord = {
			user: 'user456',
			slot: 123,
			ts: 9876543210,
			txSig: '123',
			symbol: 'USDC',
			txSigIndex: 3,
			entity: EntityTypes.User,
		} as DepositRecord;

		const result = getRecordKeys(depositRecord, RecordTypes.DepositRecord);

		expect(result).toEqual({
			pk: 'USER#user456',
			sk: 'DEPOSIT#TS#9876543210#SLOT#123#SIG#123#INDEX#00003',
			GSI1PK: 'USER#user456',
			GSI1SK: 'DEPOSIT#MARKET#USDC#TS#9876543210#SLOT#123#SIG#123#INDEX#00003',
		});
	});

	it('should handle market entity for DepositRecord', () => {
		const depositRecord = {
			symbol: 'SOL',
			slot: 123,
			ts: 1234567890,
			txSig: 'tx-abc',
			txSigIndex: 2,
			entity: EntityTypes.Market,
		} as DepositRecord;

		const result = getRecordKeys(depositRecord, RecordTypes.DepositRecord);

		expect(result).toEqual({
			pk: 'MARKET#SOL',
			sk: 'DEPOSIT#TS#1234567890#SLOT#123#SIG#tx-abc#INDEX#00002',
		});
	});

	it('should return correct keys for RewardRecord', () => {
		const rewardRecord = {
			user: 'user456',
			slot: 123,
			ts: 9876543210,
			txSig: '123',
			symbol: 'USDC',
			txSigIndex: 3,
			entity: EntityTypes.User,
		} as RewardRecord;

		const result = getRecordKeys(rewardRecord, RecordTypes.RewardRecord);

		expect(result).toEqual({
			pk: 'USER#user456',
			sk: 'REWARD#TS#9876543210#SLOT#123#SIG#123#INDEX#00003',
		});
	});

	it('should handle market entity for RewardRecord', () => {
		const rewardRecord = {
			symbol: 'SOL',
			slot: 123,
			ts: 1234567890,
			txSig: 'tx-abc',
			txSigIndex: 2,
			entity: EntityTypes.Market,
		} as RewardRecord;

		const result = getRecordKeys(rewardRecord, RecordTypes.RewardRecord);

		expect(result).toEqual({
			pk: 'MARKET#SOL',
			sk: 'REWARD#TS#1234567890#SLOT#123#SIG#tx-abc#INDEX#00002',
		});
	});

	it('should return correct keys for FundingPaymentRecord', () => {
		const fundingPaymentRecord: FundingPaymentRecord = {
			user: 'user123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
		} as FundingPaymentRecord;

		const result = getRecordKeys(fundingPaymentRecord, RecordTypes.FundingPaymentRecord);

		expect(result).toEqual({
			pk: 'USER#user123',
			sk: 'FUNDING_PAYMENT#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for FundingRateRecord', () => {
		const fundingRateRecord: FundingRateRecord = {
			symbol: 'SOL-PERP',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
		} as FundingRateRecord;

		const result = getRecordKeys(fundingRateRecord, RecordTypes.FundingRateRecord);

		expect(result).toEqual({
			pk: 'MARKET#SOL-PERP',
			sk: 'FUNDING_RATE#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for InsuranceFundStakeRecord', () => {
		const insuranceFundStakeRecord: InsuranceFundStakeRecord = {
			userAuthority: 'user-123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
			entity: EntityTypes.Authority,
			symbol: 'USDC',
		} as InsuranceFundStakeRecord;

		const result = getRecordKeys(
			insuranceFundStakeRecord,
			RecordTypes.InsuranceFundStakeRecord
		);

		expect(result).toEqual({
			pk: 'AUTHORITY#user-123',
			sk: 'INSURANCE_FUND_STAKE#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
			GSI1PK: 'AUTHORITY#user-123',
			GSI1SK: 'INSURANCE_FUND_STAKE#MARKET#USDC#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for InsuranceFundRecord', () => {
		const insuranceFundRecord: InsuranceFundRecord = {
			symbol: 'SOL-PERP',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
		} as InsuranceFundRecord;

		const result = getRecordKeys(insuranceFundRecord, RecordTypes.InsuranceFundRecord);

		expect(result).toEqual({
			pk: 'MARKET#SOL-PERP',
			sk: 'INSURANCE_FUND#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for LiquidationRecord with bankrupt=false', () => {
		const liquidationRecord: LiquidationRecord = {
			user: 'user123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
			bankrupt: false,
		} as LiquidationRecord;

		const result = getRecordKeys(liquidationRecord, RecordTypes.LiquidationRecord);

		expect(result).toEqual({
			pk: 'USER#user123',
			sk: 'LIQUIDATION#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
			GSI1PK: 'LIQUIDATION',
			GSI1SK: 'LIQUIDATION#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for LiquidationRecord with bankrupt=true', () => {
		const liquidationRecord: LiquidationRecord = {
			user: 'user123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
			bankrupt: true,
		} as LiquidationRecord;

		const result = getRecordKeys(liquidationRecord, RecordTypes.LiquidationRecord);

		expect(result).toEqual({
			pk: 'USER#user123',
			sk: 'LIQUIDATION#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
			GSI1PK: 'BANKRUPTCY',
			GSI1SK: 'BANKRUPTCY#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for LPRecord', () => {
		const lpRecord: LPRecord = {
			user: 'user-123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
		} as LPRecord;

		const result = getRecordKeys(lpRecord, RecordTypes.LPRecord);

		expect(result).toEqual({
			pk: 'USER#user-123',
			sk: 'LP#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for SettlePnlRecord', () => {
		const settlePnlRecord: SettlePnlRecord = {
			user: 'user123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
		} as SettlePnlRecord;

		const result = getRecordKeys(settlePnlRecord, RecordTypes.SettlePnlRecord);

		expect(result).toEqual({
			pk: 'USER#user123',
			sk: 'SETTLE_PNL#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for SwapRecord', () => {
		const swapRecord: SwapRecord = {
			user: 'user123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
			entity: EntityTypes.User,
		} as SwapRecord;

		const result = getRecordKeys(swapRecord, RecordTypes.SwapRecord);

		expect(result).toEqual({
			pk: 'USER#user123',
			sk: 'SWAP#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should handle market entity for SwapRecord', () => {
		const swapRecord = {
			inSymbol: 'SOL',
			outSymbol: 'USDC',
			isInMarket: true,
			slot: 123,
			ts: 1234567890,
			txSig: 'tx-abc',
			txSigIndex: 3,
			entity: EntityTypes.Market,
		} as SwapRecord;

		const result = getRecordKeys(swapRecord, RecordTypes.SwapRecord);

		expect(result).toEqual({
			pk: 'MARKET#SOL',
			sk: 'SWAP#TS#1234567890#SLOT#123#SIG#tx-abc#INDEX#00003',
		});
	});

	it('should use outSymbol when isInMarket is false for SwapRecord with market entity', () => {
		const swapRecord = {
			inSymbol: 'SOL',
			outSymbol: 'USDC',
			isInMarket: false,
			slot: 123,
			ts: 1234567890,
			txSig: 'tx-abc',
			txSigIndex: 3,
			entity: EntityTypes.Market,
		} as SwapRecord;

		const result = getRecordKeys(swapRecord, RecordTypes.SwapRecord);

		expect(result).toEqual({
			pk: 'MARKET#USDC',
			sk: 'SWAP#TS#1234567890#SLOT#123#SIG#tx-abc#INDEX#00003',
		});
	});

	it('should return correct keys for TradeRecord with symbol', () => {
		const tradeRecord: TradeRecord = {
			symbol: 'BTC',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
			entity: 'market',
		} as TradeRecord;

		const result = getRecordKeys(tradeRecord, RecordTypes.TradeRecord);

		expect(result).toEqual({
			pk: 'MARKET#BTC',
			sk: 'TRADE#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should return correct keys for TradeRecord with user', () => {
		const tradeRecord: TradeRecord = {
			user: 'user123',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
			entity: 'user',
			symbol: 'SOL-PERP',
		} as TradeRecord;

		const result = getRecordKeys(tradeRecord, RecordTypes.TradeRecord);

		expect(result).toEqual({
			pk: 'USER#user123',
			sk: 'TRADE#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
			GSI1PK: 'USER#user123',
			GSI1SK: 'TRADE#MARKET#SOL-PERP#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should throw an error for TradeRecord without entity', () => {
		const tradeRecord: TradeRecord = {
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
		} as TradeRecord;

		expect(() => {
			getRecordKeys(tradeRecord, RecordTypes.TradeRecord);
		}).toThrow('Trade record does not recognize undefined');
	});

	it('should handle PredictionRecord type', () => {
		const predictionRecord: TradeRecord = {
			symbol: 'BTC',
			slot: 123,
			ts: 1234567890,
			txSig: '123',
			txSigIndex: 5,
			entity: 'market',
		} as TradeRecord;

		const result = getRecordKeys(predictionRecord, RecordTypes.PredictionRecord);

		expect(result).toEqual({
			pk: 'MARKET#BTC',
			sk: 'PREDICTION#TS#1234567890#SLOT#123#SIG#123#INDEX#00005',
		});
	});

	it('should handle DeviceRecord type', () => {
		const deviceRecord = {
			authorityId: '123',
			deviceId: '123',
		} as DeviceRecord;

		const result = getRecordKeys(deviceRecord, RecordTypes.DeviceRecord);

		expect(result).toEqual({
			pk: 'AUTHORITY#123',
			sk: 'DEVICE#123',
		});
	});

	it('should handle AlertRecord type', () => {
		const alertRecord = {
			alertId: '123',
			authorityId: '123',
			deviceId: '123',
			targetPrice: 23,
			symbol: 'SOL',
			direction: AlertDirection.ABOVE,
		} as AlertRecord;

		const result = getRecordKeys(alertRecord, RecordTypes.AlertRecord);

		expect(result).toEqual({
			GSI1PK: 'ALERT#SOL#DIRECTION#ABOVE',
			GSI1SK: '23',
			pk: 'AUTHORITY#123',
			sk: 'DEVICE#123',
		});
	});

	it('should handle NotificationRecord type', () => {
		const notificationRecord = {
			notificationId: '23',
			authorityId: '123',
			deviceId: '123',
			status: NotificationStatus.PENDING,
			type: NotificationType.ACCOUNT_UPDATE,
		} as unknown as NotificationRecord;

		const result = getRecordKeys(notificationRecord, RecordTypes.NotificationRecord);

		expect(result).toEqual({
			pk: 'AUTHORITY#123',
			sk: 'NOTIFICATION#STATUS#PENDING#23',
			GSI1PK: 'AUTHORITY#123',
			GSI1SK: 'NOTIFICATION#TYPE#ACCOUNT_UPDATE#23',
		});
	});

	it('should handle WhitelistRecord type', () => {
		const whitelistRecord = {
			whitelistId: 'wl-1',
			authorityId: '123',
		} as WhitelistRecord;

		const result = getRecordKeys(whitelistRecord, RecordTypes.WhitelistRecord);

		expect(result).toEqual({
			pk: 'AUTHORITY#123',
			sk: 'WHITELIST#wl-1',
		});
	});

	it('should return correct keys for VaultSnapshotRecord', () => {
		const vaultSnapshotRecord: VaultSnapshotRecord = {
			vault: 'vault-123',
			ts: 1234567890,
		} as VaultSnapshotRecord;

		const result = getRecordKeys(vaultSnapshotRecord, RecordTypes.VaultSnapshotRecord);

		expect(result).toEqual({
			pk: 'VAULT#vault-123',
			sk: 'VAULT_SNAPSHOT#1234567890',
		});
	});

	it('should return correct keys for VaultDepositorSnapshotRecord with isDaily=true', () => {
		const vaultDepositorSnapshotRecord: VaultDepositorSnapshotRecord = {
			authority: 'auth-1',
			user: 'user-1',
			ts: 1234567890,
			isDaily: true,
		} as VaultDepositorSnapshotRecord;

		const result = getRecordKeys(
			vaultDepositorSnapshotRecord,
			RecordTypes.VaultDepositorSnapshotRecord
		);

		expect(result).toEqual({
			GSI1PK: 'AUTHORITY#auth-1',
			GSI1SK: 'VAULT_SNAPSHOT#1234567890',
			pk: 'USER#user-1',
			sk: 'VAULT_SNAPSHOT#1234567890',
		});
	});

	it('should return correct keys for VaultDepositorSnapshotRecord with isDaily=false', () => {
		const vaultDepositorSnapshotRecord: VaultDepositorSnapshotRecord = {
			authority: 'auth-1',
			user: 'user-1',
			ts: 1234567890,
			isDaily: false,
		} as VaultDepositorSnapshotRecord;

		const result = getRecordKeys(
			vaultDepositorSnapshotRecord,
			RecordTypes.VaultDepositorSnapshotRecord
		);

		expect(result).toEqual({
			GSI1PK: 'AUTHORITY#auth-1',
			GSI1SK: 'HOURLY_VAULT_SNAPSHOT#1234567890',
			pk: 'USER#user-1',
			sk: 'HOURLY_VAULT_SNAPSHOT#1234567890',
		});
	});

	it('should return correct keys for EarnSnapshotRecord with isDaily=true', () => {
		const earnSnapshotRecord: EarnSnapshotRecord = {
			authority: 'auth-1',
			user: 'user-1',
			ts: 1234567890,
			isDaily: true,
		} as EarnSnapshotRecord;

		const result = getRecordKeys(earnSnapshotRecord, RecordTypes.EarnSnapshotRecord);

		expect(result).toEqual({
			GSI1PK: 'AUTHORITY#auth-1',
			GSI1SK: 'EARN_SNAPSHOT#1234567890',
			pk: 'USER#user-1',
			sk: 'EARN_SNAPSHOT#1234567890',
		});
	});

	it('should return correct keys for EarnSnapshotRecord with isDaily=false', () => {
		const earnSnapshotRecord: EarnSnapshotRecord = {
			authority: 'auth-1',
			user: 'user-1',
			ts: 1234567890,
			isDaily: false,
		} as EarnSnapshotRecord;

		const result = getRecordKeys(earnSnapshotRecord, RecordTypes.EarnSnapshotRecord);

		expect(result).toEqual({
			GSI1PK: 'AUTHORITY#auth-1',
			GSI1SK: 'HOURLY_EARN_SNAPSHOT#1234567890',
			pk: 'USER#user-1',
			sk: 'HOURLY_EARN_SNAPSHOT#1234567890',
		});
	});

	it('should return correct keys for TradeSnapshotRecord with isDaily=true', () => {
		const tradeSnapshotRecord: EarnSnapshotRecord = {
			authority: 'auth-1',
			user: 'user-1',
			ts: 1234567890,
			isDaily: true,
		} as EarnSnapshotRecord;

		const result = getRecordKeys(tradeSnapshotRecord, RecordTypes.TradeSnapshotRecord);

		expect(result).toEqual({
			GSI1PK: 'AUTHORITY#auth-1',
			GSI1SK: 'TRADE_SNAPSHOT#1234567890',
			pk: 'USER#user-1',
			sk: 'TRADE_SNAPSHOT#1234567890',
		});
	});

	it('should return correct keys for TradeSnapshotRecord with isDaily=false', () => {
		const tradeSnapshotRecord: EarnSnapshotRecord = {
			authority: 'auth-1',
			user: 'user-1',
			ts: 1234567890,
			isDaily: false,
		} as EarnSnapshotRecord;

		const result = getRecordKeys(tradeSnapshotRecord, RecordTypes.TradeSnapshotRecord);

		expect(result).toEqual({
			GSI1PK: 'AUTHORITY#auth-1',
			GSI1SK: 'HOURLY_TRADE_SNAPSHOT#1234567890',
			pk: 'USER#user-1',
			sk: 'HOURLY_TRADE_SNAPSHOT#1234567890',
		});
	});

	it('should return correct keys for VaultDepositorRecord', () => {
		const vaultDepositorRecord: VaultDepositorRecord = {
			depositorAuthority: 'authority-123',
			vault: 'vault-456',
			slot: 123,
			ts: 1234567890,
			txSig: 'sig-abc',
			txSigIndex: 7,
		} as VaultDepositorRecord;

		const result = getRecordKeys(vaultDepositorRecord, RecordTypes.VaultDepositorRecord);

		expect(result).toEqual({
			pk: 'AUTHORITY#authority-123',
			sk: 'VAULT_DEPOSIT#VAULT#vault-456#TS#1234567890#SLOT#123#SIG#sig-abc#INDEX#00007',
		});
	});

	it('should return correct keys for FeeRecord', () => {
		const tradeRecord: TradeRecord = {
			user: '123',
			userOrderId: 123,
		} as TradeRecord;

		const result = getRecordKeys(tradeRecord, RecordTypes.FeeRecord);

		expect(result).toEqual({
			pk: 'USER#123#ORDER#123',
			sk: 'CUMULATIVE_FEE',
		});
	});

	it('should throw an error for unsupported event type', () => {
		const unsupportedRecord: DBRecord = {} as DBRecord;
		expect(() => {
			getRecordKeys(unsupportedRecord, 'UnsupportedType' as RecordTypes);
		}).toThrow('Unsupported event type: UnsupportedType');
	});
});

describe('Util Functions', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should return correct base record fields for SEQUENTIAL source', () => {
		const mockTimestamp = getTimestamp();
		const expected = mockTimestamp + RECORD_TTL_DAYS * 24 * 60 * 60;

		const result = getBaseRecordFields({
			ts: mockTimestamp,
			source: IngestionSource.SEQUENTIAL,
		} as DBRecord);

		expect(result).toEqual({
			createdAt: mockTimestamp,
			ttl: expected,
		});
	});

	it('should return correct base record fields for GRPC source', () => {
		const mockTimestamp = getTimestamp();
		const expected = mockTimestamp + GRPC_RECORD_TTL_MINS * 60;

		const result = getBaseRecordFields({
			ts: mockTimestamp,
			source: IngestionSource.GRPC,
		} as DBRecord);

		expect(result).toEqual({
			createdAt: mockTimestamp,
			ttl: expected,
		});
	});

	it('should return correct keys for authority map', () => {
		const result = authorityMapKeys('user-123');

		expect(result).toEqual({
			pk: 'USER#user-123',
			sk: 'AUTHORITY_MAP',
		});
	});

	it('should return correct keys for cumulative vault deposit with vault', () => {
		const result = cumulativeVaultDepositKeys('auth-123', 'vault-456');

		expect(result).toEqual({
			pk: 'AUTHORITY#auth-123',
			sk: 'CUMULATIVE_VAULT_DEPOSIT#VAULT#vault-456',
		});
	});

	it('should return correct keys for cumulative vault deposit without vault', () => {
		const result = cumulativeVaultDepositKeys('auth-123');

		expect(result).toEqual({
			pk: 'AUTHORITY#auth-123',
			sk: 'CUMULATIVE_VAULT_DEPOSIT',
		});
	});
});
