import {
	AlertRecord,
	BaseDynamoRecord,
	CandleRecord,
	ClaimRecord,
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
	InsuranceFundSwapRecord,
	LiquidationRecord,
	LPMintRedeemRecord,
	LPRecord,
	NOTIFICATION_RECORD_DELETE_TTL_DAYS,
	NotificationPreferencesRecord,
	NotificationRecord,
	OffChainRecord,
	OrderActionRecord,
	OrderFillStatusRecord,
	OrderRecord,
	PoolSnapshotRecord,
	PredictionRecord,
	RECORD_DELETE_TTL_DAYS,
	RECORD_TTL_DAYS,
	RecordKeys,
	RecordTypes,
	RewardRecord,
	SecondaryIndex,
	SerializedMarketFilter,
	SettlePnlRecord,
	SwapRecord,
	TradeRecord,
	VaultDepositorRecord,
	VaultDepositorSnapshotRecord,
	VaultSnapshotRecord,
	WhitelistRecord,
} from '@backend/common';

export const MARKET_PK = 'MARKET';
export const USER_PK = 'USER';
export const AUTHORITY_PK = 'AUTHORITY';
export const CANDLE_PK = 'CANDLE';
export const DEVICE_PK = 'DEVICE';
export const VAULT_PK = 'VAULT';
export const ANALYTICS_PK = 'ANALYTICS';
export const POOL_PK = 'POOL';

export const ORDER_RECORD_ID = 'ORDER';
export const ORDER_ACTION_RECORD_ID = 'ORDER_ACTION';
export const ORDER_FILL_STATUS_RECORD_ID = 'ORDER_FILLED';
export const TRADE_RECORD_ID = 'TRADE';
export const SWAP_RECORD_ID = 'SWAP';
export const PREDICTION_RECORD_ID = 'PREDICTION';
export const SETTLE_PNL_RECORD_ID = 'SETTLE_PNL';
export const DEPOSIT_RECORD_ID = 'DEPOSIT';
export const REWARD_RECORD_ID = 'REWARD';
export const LIQUIDATION_RECORD_ID = 'LIQUIDATION';
export const BANKRUPTCY_RECORD_ID = 'BANKRUPTCY';
export const LP_RECORD_ID = 'LP';
export const LP_MINT_REDEEM_RECORD_ID = 'LP_MINT_REDEEM';
export const FUNDING_PAYMENT_RECORD_ID = 'FUNDING_PAYMENT';
export const INSURANCE_FUND_STAKE_RECORD_ID = 'INSURANCE_FUND_STAKE';
export const INSURANCE_FUND_RECORD_ID = 'INSURANCE_FUND';
export const INSURANCE_FUND_SWAP_RECORD_ID = 'INSURANCE_FUND_SWAP';
export const FUNDING_RATE_RECORD_ID = 'FUNDING_RATE';
export const AUTHORITY_MAP_ID = 'AUTHORITY_MAP';
export const FEE_RECORD_ID = 'CUMULATIVE_FEE';

export const DEVICE_RECORD_ID = 'DEVICE';
export const ALERT_RECORD_ID = 'ALERT';
export const NOTIFICATION_RECORD_ID = 'NOTIFICATION';
export const NOTIFICATION_PREFERENCES_RECORD_ID = 'NOTIFICATION_PREFERENCES';
export const WHITELIST_RECORD_ID = 'WHITELIST';
export const CLAIM_RECORD_ID = 'CLAIM';

export const VAULT_SNAPSHOT_RECORD_ID = 'VAULT_SNAPSHOT';
export const TRADE_SNAPSHOT_RECORD_ID = 'TRADE_SNAPSHOT';
export const EARN_SNAPSHOT_RECORD_ID = 'EARN_SNAPSHOT';
export const REFERRAL_SNAPSHOT_RECORD_ID = 'REFERRAL_SNAPSHOT';
export const VERIFY_SNAPSHOT_RECORD_ID = 'VERIFY_SNAPSHOT';
export const DLP_SNAPSHOT_RECORD_ID = 'DLP_POOL_SNAPSHOT';

export const HOURLY_VAULT_SNAPSHOT_RECORD_ID = 'HOURLY_VAULT_SNAPSHOT';
export const HOURLY_TRADE_SNAPSHOT_RECORD_ID = 'HOURLY_TRADE_SNAPSHOT';
export const HOURLY_EARN_SNAPSHOT_RECORD_ID = 'HOURLY_EARN_SNAPSHOT';
export const HOURLY_DLP_SNAPSHOT_RECORD_ID = 'HOURLY_DLP_POOL_SNAPSHOT';

export const VAULT_DEPOSIT_RECORD_ID = 'VAULT_DEPOSIT';
export const CUMULATIVE_VAULT_DEPOSIT_RECORD_ID = 'CUMULATIVE_VAULT_DEPOSIT';

export const AUCTION_LATENCY_ID = 'AUCTION_LATENCY';
export const TRIGGER_ORDER_FILL_ID = 'TRIGGER_ORDER_FILL';
export const LIQUIDITY_SOURCE_ID = 'LIQUIDITY_SOURCE';

export const getRecordKeys = <T extends RecordTypes>(
	record:
		| DBRecord
		| OffChainRecord
		| Pick<NotificationRecord, 'authorityId' | 'notificationId' | 'status'>,
	eventType: T
): RecordKeys => {
	switch (eventType) {
		case RecordTypes.OrderRecord: {
			const orderRecord = record as OrderRecord;
			return {
				...getOrderRecordPrimaryKeysV2({
					user: orderRecord.user,
					marketFilter: orderRecord.marketFilter ?? orderRecord.marketType,
					orderId: orderRecord.orderId,
					ts: orderRecord.ts,
				}),
				GSI1PK: `${USER_PK}#${orderRecord.user}`,
				GSI1SK: `${ORDER_RECORD_ID}#MARKET#${orderRecord.symbol}#TS#${orderRecord.ts}#ID#${orderRecord.orderId}`,
				GSI2PK: `${USER_PK}#${orderRecord.user}#${ORDER_RECORD_ID}#${orderRecord.orderId}`,
				GSI2SK: `${ORDER_RECORD_ID}#TS#${orderRecord.ts}#ID#${orderRecord.orderId}`,
			};
		}

		case RecordTypes.OrderActionRecord: {
			const orderActionRecord = record as OrderActionRecord;
			return {
				pk: `${USER_PK}#${orderActionRecord.user}#${ORDER_RECORD_ID}#${orderActionRecord.userOrderId}`,
				sk: `${ORDER_ACTION_RECORD_ID}#TS#${orderActionRecord.ts}#SLOT#${
					orderActionRecord.slot
				}#SIG#${orderActionRecord.txSig}#INDEX#${padTxSigIndex(
					orderActionRecord.txSigIndex
				)}`,
			};
		}

		case RecordTypes.OrderFillStatusRecord: {
			const orderFillStatusRecord = record as OrderFillStatusRecord;
			const recordTs = orderFillStatusRecord.ts;
			const marketFilter = orderFillStatusRecord.marketFilter.toUpperCase();
			const symbol = orderFillStatusRecord.symbol.toUpperCase();

			const keys: RecordKeys = {
				pk: `${USER_PK}#${orderFillStatusRecord.user}`,
				sk: `${ORDER_FILL_STATUS_RECORD_ID}#ID#${orderFillStatusRecord.orderId}`,
				GSI1PK: `${USER_PK}#${orderFillStatusRecord.user}`,
				GSI1SK: `${ORDER_FILL_STATUS_RECORD_ID}#MARKET#${symbol}#TS#${recordTs}#ID#${orderFillStatusRecord.orderId}`,
				GSI2PK: `${USER_PK}#${orderFillStatusRecord.user}`,
				GSI2SK: `${ORDER_FILL_STATUS_RECORD_ID}#TYPE#${marketFilter}#TS#${recordTs}#ID#${orderFillStatusRecord.orderId}`,
			};

			return keys;
		}

		case RecordTypes.TradeRecord: {
			const tradeRecord = record as TradeRecord;

			if (tradeRecord.entity === EntityTypes.Market) {
				return {
					pk: `${MARKET_PK}#${tradeRecord.symbol}`,
					sk: `${TRADE_RECORD_ID}#TS#${tradeRecord.ts}#SLOT#${tradeRecord.slot}#SIG#${
						tradeRecord.txSig
					}#INDEX#${padTxSigIndex(tradeRecord.txSigIndex)}`,
				};
			}

			if (tradeRecord.entity === EntityTypes.User) {
				return {
					pk: `${USER_PK}#${tradeRecord.user}`,
					sk: `${TRADE_RECORD_ID}#TS#${tradeRecord.ts}#SLOT#${tradeRecord.slot}#SIG#${
						tradeRecord.txSig
					}#INDEX#${padTxSigIndex(tradeRecord.txSigIndex)}`,
					GSI1PK: `${USER_PK}#${tradeRecord.user}`,
					GSI1SK: `${TRADE_RECORD_ID}#MARKET#${tradeRecord.symbol}#TS#${
						tradeRecord.ts
					}#SLOT#${tradeRecord.slot}#SIG#${tradeRecord.txSig}#INDEX#${padTxSigIndex(
						tradeRecord.txSigIndex
					)}`,
				};
			}

			throw new Error(`Trade record does not recognize ${tradeRecord.entity}`);
		}

		case RecordTypes.PredictionRecord: {
			const predictionRecord = record as PredictionRecord;

			if (predictionRecord.entity === EntityTypes.Market) {
				return {
					pk: `${MARKET_PK}#${predictionRecord.symbol}`,
					sk: `${PREDICTION_RECORD_ID}#TS#${predictionRecord.ts}#SLOT#${
						predictionRecord.slot
					}#SIG#${predictionRecord.txSig}#INDEX#${padTxSigIndex(
						predictionRecord.txSigIndex
					)}`,
				};
			}

			if (predictionRecord.entity === EntityTypes.User) {
				return {
					pk: `${USER_PK}#${predictionRecord.user}`,
					sk: `${PREDICTION_RECORD_ID}#TS#${predictionRecord.ts}#SLOT#${
						predictionRecord.slot
					}#SIG#${predictionRecord.txSig}#INDEX#${padTxSigIndex(
						predictionRecord.txSigIndex
					)}`,
					GSI1PK: `${USER_PK}#${predictionRecord.user}`,
					GSI1SK: `${PREDICTION_RECORD_ID}#MARKET#${predictionRecord.symbol}#TS#${
						predictionRecord.ts
					}#SLOT#${predictionRecord.slot}#SIG#${
						predictionRecord.txSig
					}#INDEX#${padTxSigIndex(predictionRecord.txSigIndex)}`,
				};
			}

			throw new Error(`Prediction record does not recognize ${predictionRecord.entity}`);
		}

		case RecordTypes.SwapRecord: {
			const swapRecord = record as SwapRecord;

			if (swapRecord.entity === EntityTypes.Market) {
				const symbol = swapRecord.isInMarket ? swapRecord.inSymbol : swapRecord.outSymbol;

				return {
					pk: `${MARKET_PK}#${symbol}`,
					sk: `${SWAP_RECORD_ID}#TS#${swapRecord.ts}#SLOT#${swapRecord.slot}#SIG#${
						swapRecord.txSig
					}#INDEX#${padTxSigIndex(swapRecord.txSigIndex)}`,
				};
			}

			if (swapRecord.entity === EntityTypes.User) {
				return {
					pk: `${USER_PK}#${swapRecord.user}`,
					sk: `${SWAP_RECORD_ID}#TS#${swapRecord.ts}#SLOT#${swapRecord.slot}#SIG#${
						swapRecord.txSig
					}#INDEX#${padTxSigIndex(swapRecord.txSigIndex)}`,
				};
			}

			throw new Error(`Swap record does not recognize ${swapRecord.entity}`);
		}

		case RecordTypes.SettlePnlRecord: {
			const settlePnlRecord = record as SettlePnlRecord;
			return {
				pk: `${USER_PK}#${settlePnlRecord.user}`,
				sk: `${SETTLE_PNL_RECORD_ID}#TS#${settlePnlRecord.ts}#SLOT#${
					settlePnlRecord.slot
				}#SIG#${settlePnlRecord.txSig}#INDEX#${padTxSigIndex(settlePnlRecord.txSigIndex)}`,
			};
		}

		case RecordTypes.DepositRecord: {
			const depositRecord = record as DepositRecord;

			if (depositRecord.entity === EntityTypes.Market) {
				return {
					pk: `${MARKET_PK}#${depositRecord.symbol}`,
					sk: `${DEPOSIT_RECORD_ID}#TS#${depositRecord.ts}#SLOT#${
						depositRecord.slot
					}#SIG#${depositRecord.txSig}#INDEX#${padTxSigIndex(depositRecord.txSigIndex)}`,
				};
			}

			if (depositRecord.entity === EntityTypes.User) {
				return {
					pk: `${USER_PK}#${depositRecord.user}`,
					sk: `${DEPOSIT_RECORD_ID}#TS#${depositRecord.ts}#SLOT#${
						depositRecord.slot
					}#SIG#${depositRecord.txSig}#INDEX#${padTxSigIndex(depositRecord.txSigIndex)}`,
					GSI1PK: `${USER_PK}#${depositRecord.user}`,
					GSI1SK: `${DEPOSIT_RECORD_ID}#MARKET#${depositRecord.symbol}#TS#${
						depositRecord.ts
					}#SLOT#${depositRecord.slot}#SIG#${depositRecord.txSig}#INDEX#${padTxSigIndex(
						depositRecord.txSigIndex
					)}`,
				};
			}

			throw new Error(`Deposit record does not recognize ${depositRecord.entity}`);
		}

		case RecordTypes.RewardRecord: {
			const rewardRecord = record as RewardRecord;

			if (rewardRecord.entity === EntityTypes.Market) {
				return {
					pk: `${MARKET_PK}#${rewardRecord.symbol}`,
					sk: `${REWARD_RECORD_ID}#TS#${rewardRecord.ts}#SLOT#${rewardRecord.slot}#SIG#${
						rewardRecord.txSig
					}#INDEX#${padTxSigIndex(rewardRecord.txSigIndex)}`,
				};
			}

			if (rewardRecord.entity === EntityTypes.User) {
				return {
					pk: `${USER_PK}#${rewardRecord.user}`,
					sk: `${REWARD_RECORD_ID}#TS#${rewardRecord.ts}#SLOT#${rewardRecord.slot}#SIG#${
						rewardRecord.txSig
					}#INDEX#${padTxSigIndex(rewardRecord.txSigIndex)}`,
				};
			}

			throw new Error(`Deposit record does not recognize ${rewardRecord.entity}`);
		}

		case RecordTypes.LiquidationRecord: {
			const liquidationRecord = record as LiquidationRecord;

			const secondaryIndexKey = liquidationRecord.bankrupt
				? BANKRUPTCY_RECORD_ID
				: LIQUIDATION_RECORD_ID;

			return {
				pk: `${USER_PK}#${liquidationRecord.user}`,
				sk: `${LIQUIDATION_RECORD_ID}#TS#${liquidationRecord.ts}#SLOT#${
					liquidationRecord.slot
				}#SIG#${liquidationRecord.txSig}#INDEX#${padTxSigIndex(
					liquidationRecord.txSigIndex
				)}`,
				GSI1PK: `${secondaryIndexKey}`,
				GSI1SK: `${secondaryIndexKey}#TS#${liquidationRecord.ts}#SLOT#${
					liquidationRecord.slot
				}#SIG#${liquidationRecord.txSig}#INDEX#${padTxSigIndex(
					liquidationRecord.txSigIndex
				)}`,
			};
		}

		case RecordTypes.LPRecord: {
			const lpRecord = record as LPRecord;
			return {
				pk: `${USER_PK}#${lpRecord.user}`,
				sk: `${LP_RECORD_ID}#TS#${lpRecord.ts}#SLOT#${lpRecord.slot}#SIG#${
					lpRecord.txSig
				}#INDEX#${padTxSigIndex(lpRecord.txSigIndex)}`,
			};
		}

		case RecordTypes.FundingPaymentRecord: {
			const fundingPaymentRecord = record as FundingPaymentRecord;
			return {
				pk: `${USER_PK}#${fundingPaymentRecord.user}`,
				sk: `${FUNDING_PAYMENT_RECORD_ID}#TS#${fundingPaymentRecord.ts}#SLOT#${
					fundingPaymentRecord.slot
				}#SIG#${fundingPaymentRecord.txSig}#INDEX#${padTxSigIndex(
					fundingPaymentRecord.txSigIndex
				)}`,
			};
		}

		case RecordTypes.InsuranceFundStakeRecord: {
			const insuranceFundStakeRecord = record as InsuranceFundStakeRecord;

			if (insuranceFundStakeRecord.entity === EntityTypes.Market) {
				return {
					pk: `${MARKET_PK}#${insuranceFundStakeRecord.symbol}`,
					sk: `${INSURANCE_FUND_STAKE_RECORD_ID}#TS#${insuranceFundStakeRecord.ts}#SLOT#${
						insuranceFundStakeRecord.slot
					}#SIG#${insuranceFundStakeRecord.txSig}#INDEX#${padTxSigIndex(
						insuranceFundStakeRecord.txSigIndex
					)}`,
				};
			}

			if (insuranceFundStakeRecord.entity === EntityTypes.Authority) {
				return {
					pk: `${AUTHORITY_PK}#${insuranceFundStakeRecord.userAuthority}`,
					sk: `${INSURANCE_FUND_STAKE_RECORD_ID}#TS#${insuranceFundStakeRecord.ts}#SLOT#${
						insuranceFundStakeRecord.slot
					}#SIG#${insuranceFundStakeRecord.txSig}#INDEX#${padTxSigIndex(
						insuranceFundStakeRecord.txSigIndex
					)}`,
					GSI1PK: `${AUTHORITY_PK}#${insuranceFundStakeRecord.userAuthority}`,
					GSI1SK: `${INSURANCE_FUND_STAKE_RECORD_ID}#MARKET#${
						insuranceFundStakeRecord.symbol
					}#TS#${insuranceFundStakeRecord.ts}#SLOT#${insuranceFundStakeRecord.slot}#SIG#${
						insuranceFundStakeRecord.txSig
					}#INDEX#${padTxSigIndex(insuranceFundStakeRecord.txSigIndex)}`,
				};
			}

			throw new Error(
				`Insurance fund stake record does not recognize ${insuranceFundStakeRecord.entity}`
			);
		}

		case RecordTypes.InsuranceFundRecord: {
			const insuranceFundRecord = record as InsuranceFundRecord;
			return {
				pk: `${MARKET_PK}#${insuranceFundRecord.symbol}`,
				sk: `${INSURANCE_FUND_RECORD_ID}#TS#${insuranceFundRecord.ts}#SLOT#${
					insuranceFundRecord.slot
				}#SIG#${insuranceFundRecord.txSig}#INDEX#${padTxSigIndex(
					insuranceFundRecord.txSigIndex
				)}`,
			};
		}

		case RecordTypes.FundingRateRecord: {
			const fundingRateRecord = record as FundingRateRecord;
			return {
				pk: `${MARKET_PK}#${fundingRateRecord.symbol}`,
				sk: `${FUNDING_RATE_RECORD_ID}#TS#${fundingRateRecord.ts}#SLOT#${
					fundingRateRecord.slot
				}#SIG#${fundingRateRecord.txSig}#INDEX#${padTxSigIndex(
					fundingRateRecord.txSigIndex
				)}`,
			};
		}

		case RecordTypes.CandleRecord: {
			const candleRecord = record as CandleRecord;
			return {
				pk: `${CANDLE_PK}#${candleRecord.symbol}#${candleRecord.resolution}`,
				sk: `${candleRecord.ts}`,
			};
		}

		case RecordTypes.DeviceRecord: {
			const deviceRecord = record as DeviceRecord;
			return {
				pk: `${AUTHORITY_PK}#${deviceRecord.authorityId}`,
				sk: `${DEVICE_RECORD_ID}#${deviceRecord.deviceId}`,
			};
		}

		case RecordTypes.AlertRecord: {
			const alertRecord = record as AlertRecord;
			return {
				...getAlertRecordPrimaryKeys({
					authorityId: alertRecord.authorityId,
					alertId: alertRecord.alertId,
				}),
				GSI1PK: `${ALERT_RECORD_ID}#${alertRecord.symbol}#DIRECTION#${alertRecord.direction}`,
				GSI1SK: alertRecord.targetPrice.toString(),
			};
		}

		case RecordTypes.NotificationRecord: {
			const notificationRecord = record as NotificationRecord;

			return {
				pk: `${AUTHORITY_PK}#${notificationRecord.authorityId}`,
				sk: `${NOTIFICATION_RECORD_ID}#STATUS#${notificationRecord.status}#${notificationRecord.notificationId}`,
				GSI1PK: `${AUTHORITY_PK}#${notificationRecord.authorityId}`,
				GSI1SK: `${NOTIFICATION_RECORD_ID}#TYPE#${notificationRecord.type}#${notificationRecord.notificationId}`,
			};
		}

		case RecordTypes.NotificationPreferencesRecord: {
			const preferencesRecord = record as NotificationPreferencesRecord;
			return {
				pk: `${AUTHORITY_PK}#${preferencesRecord.authorityId}`,
				sk: `${NOTIFICATION_PREFERENCES_RECORD_ID}`,
			};
		}

		case RecordTypes.WhitelistRecord: {
			const whitelistRecord = record as WhitelistRecord;
			return {
				pk: `${AUTHORITY_PK}#${whitelistRecord.authorityId}`,
				sk: `${WHITELIST_RECORD_ID}#${whitelistRecord.whitelistId}`,
			};
		}

		case RecordTypes.ClaimRecord: {
			const claimRecord = record as ClaimRecord;
			const updatedAt = claimRecord.updatedAt ?? getTimestamp();
			return {
				pk: `${AUTHORITY_PK}#${claimRecord.authorityId}`,
				sk: `${CLAIM_RECORD_ID}#${claimRecord.campaignId}`,
				GSI1PK: `${CLAIM_RECORD_ID}#${claimRecord.campaignId}#${claimRecord.status}`,
				GSI1SK: `TS#${updatedAt}#AUTHORITY#${claimRecord.authorityId}`,
			};
		}

		case RecordTypes.VaultSnapshotRecord: {
			const vaultSnapshotRecords = record as VaultSnapshotRecord;
			return {
				pk: `${VAULT_PK}#${vaultSnapshotRecords.vault}`,
				sk: `${VAULT_SNAPSHOT_RECORD_ID}#${vaultSnapshotRecords.ts}`,
			};
		}

		case RecordTypes.VaultDepositorSnapshotRecord: {
			const vaultDepositorSnapshotRecord = record as VaultDepositorSnapshotRecord;

			const sk = vaultDepositorSnapshotRecord.isDaily
				? VAULT_SNAPSHOT_RECORD_ID
				: HOURLY_VAULT_SNAPSHOT_RECORD_ID;

			return {
				pk: `${USER_PK}#${vaultDepositorSnapshotRecord.user}`,
				sk: `${sk}#${vaultDepositorSnapshotRecord.ts}`,
				GSI1PK: `${AUTHORITY_PK}#${vaultDepositorSnapshotRecord.authority}`,
				GSI1SK: `${sk}#${vaultDepositorSnapshotRecord.ts}`,
			};
		}

		case RecordTypes.EarnSnapshotRecord: {
			const earnSnapshotRecord = record as EarnSnapshotRecord;
			const sk = earnSnapshotRecord.isDaily
				? EARN_SNAPSHOT_RECORD_ID
				: HOURLY_EARN_SNAPSHOT_RECORD_ID;

			return {
				pk: `${USER_PK}#${earnSnapshotRecord.user}`,
				sk: `${sk}#${earnSnapshotRecord.ts}`,
				GSI1PK: `${AUTHORITY_PK}#${earnSnapshotRecord.authority}`,
				GSI1SK: `${sk}#${earnSnapshotRecord.ts}`,
			};
		}

		case RecordTypes.TradeSnapshotRecord: {
			const tradeSnapshotRecord = record as EarnSnapshotRecord;

			const sk = tradeSnapshotRecord.isDaily
				? TRADE_SNAPSHOT_RECORD_ID
				: HOURLY_TRADE_SNAPSHOT_RECORD_ID;

			return {
				pk: `${USER_PK}#${tradeSnapshotRecord.user}`,
				sk: `${sk}#${tradeSnapshotRecord.ts}`,
				GSI1PK: `${AUTHORITY_PK}#${tradeSnapshotRecord.authority}`,
				GSI1SK: `${sk}#${tradeSnapshotRecord.ts}`,
			};
		}

		case RecordTypes.ReferralSnapshotRecord: {
			const referralSnapshotRecord = record as EarnSnapshotRecord;
			return {
				pk: `${AUTHORITY_PK}#${referralSnapshotRecord.authority}`,
				sk: `${REFERRAL_SNAPSHOT_RECORD_ID}#${referralSnapshotRecord.ts}`,
			};
		}

		case RecordTypes.VaultDepositorRecord: {
			const depositRecord = record as VaultDepositorRecord;
			return {
				pk: `${AUTHORITY_PK}#${depositRecord.depositorAuthority}`,
				sk: `${VAULT_DEPOSIT_RECORD_ID}#VAULT#${depositRecord.vault}#TS#${
					depositRecord.ts
				}#SLOT#${depositRecord.slot}#SIG#${depositRecord.txSig}#INDEX#${padTxSigIndex(
					depositRecord.txSigIndex
				)}`,
			};
		}

		case RecordTypes.InsuranceFundSwapRecord: {
			const insuranceFundSwapRecord = record as InsuranceFundSwapRecord;

			return {
				pk: INSURANCE_FUND_SWAP_RECORD_ID,
				sk: `${INSURANCE_FUND_SWAP_RECORD_ID}#TS#${insuranceFundSwapRecord.ts}#SLOT#${
					insuranceFundSwapRecord.slot
				}#SIG#${insuranceFundSwapRecord.txSig}#INDEX#${padTxSigIndex(
					insuranceFundSwapRecord.txSigIndex
				)}`,
			};
		}

		case RecordTypes.FeeRecord: {
			const tradeRecord = record as TradeRecord;
			return {
				pk: `${USER_PK}#${tradeRecord.user}#ORDER#${tradeRecord.userOrderId}`,
				sk: FEE_RECORD_ID,
			};
		}

		case RecordTypes.PoolSnapshotRecord: {
			const dlpPoolSnapshotRecord = record as PoolSnapshotRecord;

			const sk = dlpPoolSnapshotRecord.isDaily
				? DLP_SNAPSHOT_RECORD_ID
				: HOURLY_DLP_SNAPSHOT_RECORD_ID;

			return {
				pk: `${POOL_PK}#${dlpPoolSnapshotRecord.pool}`,
				sk: `${sk}#${dlpPoolSnapshotRecord.ts}`,
			};
		}

		case RecordTypes.LPMintRedeemRecord: {
			const lPMintRedeemRecord = record as LPMintRedeemRecord;

			if (lPMintRedeemRecord.entity === EntityTypes.Authority) {
				return {
					pk: `${AUTHORITY_PK}#${lPMintRedeemRecord.authority}`,
					sk: `${LP_MINT_REDEEM_RECORD_ID}#TS#${lPMintRedeemRecord.ts}#SLOT#${
						lPMintRedeemRecord.slot
					}#SIG#${lPMintRedeemRecord.txSig}#INDEX#${padTxSigIndex(
						lPMintRedeemRecord.txSigIndex
					)}`,
					GSI1PK: `${AUTHORITY_PK}#${lPMintRedeemRecord.authority}`,
					GSI1SK: `${LP_MINT_REDEEM_RECORD_ID}#POOL#${lPMintRedeemRecord.lpPool}#TS#${
						lPMintRedeemRecord.ts
					}#SLOT#${lPMintRedeemRecord.slot}#SIG#${
						lPMintRedeemRecord.txSig
					}#INDEX#${padTxSigIndex(lPMintRedeemRecord.txSigIndex)}`,
				};
			}

			throw new Error(
				`LP mint redeem record does not recognize ${lPMintRedeemRecord.entity}`
			);
		}

		default:
			throw new Error(`Unsupported event type: ${eventType}`);
	}
};

export const getOrderRecordPrimaryKeys = ({
	user,
	orderId,
	marketFilter,
}: {
	user: string;
	orderId: number;
	marketFilter: SerializedMarketFilter;
}) => {
	return {
		pk: `${USER_PK}#${user}`,
		sk: `${ORDER_RECORD_ID}#TYPE#${marketFilter.toUpperCase()}#ID#${orderId}`,
	};
};

export const getAlertRecordPrimaryKeys = ({
	authorityId,
	alertId,
}: {
	authorityId: string;
	alertId: string;
}) => {
	return {
		pk: `${AUTHORITY_PK}#${authorityId}`,
		sk: `${DEVICE_RECORD_ID}#${alertId}`,
	};
};

export const getOrderRecordPrimaryKeysV2 = ({
	user,
	orderId,
	marketFilter,
	ts,
}: {
	user: string;
	orderId: number;
	marketFilter: SerializedMarketFilter;
	ts: number;
}) => {
	return {
		pk: `${USER_PK}#${user}`,
		sk: `${ORDER_RECORD_ID}#TYPE#${marketFilter.toUpperCase()}#TS#${ts}#ID#${orderId}`,
	};
};

export const authorityMapKeys = (user: string) => {
	return {
		pk: `${USER_PK}#${user}`,
		sk: `${AUTHORITY_MAP_ID}`,
	};
};

export const cumulativeVaultDepositKeys = (authority: string, vault = '') => {
	if (vault) {
		return {
			pk: `${AUTHORITY_PK}#${authority}`,
			sk: `${CUMULATIVE_VAULT_DEPOSIT_RECORD_ID}#VAULT#${vault}`,
		};
	}

	return {
		pk: `${AUTHORITY_PK}#${authority}`,
		sk: CUMULATIVE_VAULT_DEPOSIT_RECORD_ID,
	};
};

export const getBaseRecordFields = (record: DBRecord | OffChainRecord) => {
	if ('source' in record) {
		return {
			createdAt: getTimestamp(),
			ttl:
				record.source === IngestionSource.GRPC
					? getTTLTimestampFromGRPCRecord(record.ts)
					: getTTLTimestampFromRecord(record.ts),
		};
	}

	return {
		createdAt: getTimestamp(),
	};
};

export const getTTLTimestampFromGRPCRecord = (ts: number) => {
	return ts + GRPC_RECORD_TTL_MINS * 60;
};

export const getTTLTimestampFromRecord = (ts: number) => {
	return ts + RECORD_TTL_DAYS * 24 * 60 * 60;
};

export const getTTLTimestampForDelete = () => {
	return getTimestamp({ days: RECORD_DELETE_TTL_DAYS });
};

export const getTTLTimestampForNotification = () => {
	return {
		ttl: getTimestamp({ days: NOTIFICATION_RECORD_DELETE_TTL_DAYS }),
	};
};

export const padTxSigIndex = (index: number, digits = 5) => index.toString().padStart(digits, '0');

export const getPaginatedRecordsWithUniqueIds = async <
	T extends BaseDynamoRecord,
	K extends T = T
>({
	queryFn,
	extractUniqueId,
	maxUniqueRecords = 20,
	page = null,
	combineRecordsFn,
	paginationIndex,
}: {
	queryFn: (lastEvaluatedKey: Record<string, any> | null) => Promise<{
		Items?: any[];
		LastEvaluatedKey?: Record<string, any> | null;
	}>;
	extractUniqueId: (record: T) => string | number | null;
	maxUniqueRecords?: number;
	page?: Record<string, any> | null;
	combineRecordsFn?: (records: T[]) => K;
	totalRecordsFn?: (uniqueIdFn: (record: T) => string | number | null) => Promise<number>;
	paginationIndex?: SecondaryIndex | null;
}): Promise<{
	records: K[];
	meta: { nextPage: Record<string, any> | null };
}> => {
	const uniqueIds = new Set<string | number>();
	let allRecords: T[] = [];
	let lastEvaluatedKey = page;

	// Fetch until we have at least maxUniqueRecords + 1
	while (uniqueIds.size <= maxUniqueRecords) {
		const { Items = [], LastEvaluatedKey = null } = await queryFn(lastEvaluatedKey);
		if (Items.length === 0) {
			break;
		}

		const newRecords = Items as T[];
		allRecords = [...allRecords, ...newRecords];

		newRecords.forEach((record) => {
			const id = extractUniqueId(record);
			if (id !== null) {
				uniqueIds.add(id);
			}
		});

		lastEvaluatedKey = LastEvaluatedKey;

		if (!LastEvaluatedKey || uniqueIds.size > maxUniqueRecords) {
			break;
		}
	}

	// If we have more than maxUniqueRecords, trim to return only maxUniqueRecords complete sets
	if (uniqueIds.size > maxUniqueRecords) {
		const idsToKeep = Array.from(uniqueIds).slice(0, maxUniqueRecords);
		const idsToKeepSet = new Set(idsToKeep);

		// Filter records to only those with IDs in our keep set
		const filteredRecords = allRecords.filter((record) => {
			const id = extractUniqueId(record);
			return id !== null && idsToKeepSet.has(id);
		});

		const lastIdToKeep = idsToKeep[idsToKeep.length - 1];
		const lastIdRecords = filteredRecords.filter((record) => {
			const id = extractUniqueId(record);
			return id === lastIdToKeep;
		});

		if (lastIdRecords.length > 0) {
			const lastRecord = lastIdRecords[lastIdRecords.length - 1] as Record<string, any>;
			lastEvaluatedKey = {
				pk: lastRecord.pk,
				sk: lastRecord.sk,
				// Include index keys only when querying that index
				...(paginationIndex === SecondaryIndex.GSI1 && {
					...(lastRecord.GSI1PK && { GSI1PK: lastRecord.GSI1PK }),
					...(lastRecord.GSI1SK && { GSI1SK: lastRecord.GSI1SK }),
				}),
				...(paginationIndex === SecondaryIndex.GSI2 && {
					...(lastRecord.GSI2PK && { GSI2PK: lastRecord.GSI2PK }),
					...(lastRecord.GSI2SK && { GSI2SK: lastRecord.GSI2SK }),
				}),
			};
		}

		allRecords = filteredRecords;
	}

	// 🆕 Combine records per unique ID if a combiner was provided
	let finalRecords: K[] = [];
	if (combineRecordsFn) {
		const recordsById = new Map<string | number, T[]>();

		for (const record of allRecords) {
			const id = extractUniqueId(record);
			if (id !== null) {
				if (!recordsById.has(id)) {
					recordsById.set(id, []);
				}
				recordsById.get(id)!.push(record);
			}
		}

		finalRecords = Array.from(recordsById.values()).map((group) => combineRecordsFn(group));
	} else {
		finalRecords = allRecords as K[];
	}

	return {
		records: finalRecords,
		meta: { nextPage: lastEvaluatedKey },
	};
};
