import {
	DEFAULT_SNAPSHOT_TABLE,
	EarnSnapshotRecord,
	EntityTypes,
	PoolSnapshotRecord,
	RecordTypes,
	ReferralSnapshotRecord,
	SecondaryIndex,
	SnapshotFrequency,
	SnapshotRecordTypes,
	TradeSnapshotRecord,
	VaultDepositorSnapshotRecord,
	VaultSnapshotRecord,
} from '@backend/common';
import {
	AUTHORITY_PK,
	DLP_SNAPSHOT_RECORD_ID,
	DynamoDB,
	EARN_SNAPSHOT_RECORD_ID,
	getBaseRecordFields,
	getRecordKeys,
	HOURLY_DLP_SNAPSHOT_RECORD_ID,
	HOURLY_EARN_SNAPSHOT_RECORD_ID,
	HOURLY_TRADE_SNAPSHOT_RECORD_ID,
	HOURLY_VAULT_SNAPSHOT_RECORD_ID,
	POOL_PK,
	REFERRAL_SNAPSHOT_RECORD_ID,
	TRADE_SNAPSHOT_RECORD_ID,
	USER_PK,
	VAULT_SNAPSHOT_RECORD_ID,
	VERIFY_SNAPSHOT_RECORD_ID,
} from '..';

export const SnapshotRepository = () => {
	const { batchWrite, query, batchGet, queryAll } = DynamoDB({
		overrideTableName: process.env.SNAPSHOT_TABLE ?? DEFAULT_SNAPSHOT_TABLE,
	});

	const RECORD_TYPE_TO_PREFIX: Record<SnapshotRecordTypes, string> = {
		[RecordTypes.TradeSnapshotRecord]: TRADE_SNAPSHOT_RECORD_ID,
		[RecordTypes.EarnSnapshotRecord]: EARN_SNAPSHOT_RECORD_ID,
		[RecordTypes.VaultDepositorSnapshotRecord]: VAULT_SNAPSHOT_RECORD_ID,
		[RecordTypes.VaultSnapshotRecord]: VAULT_SNAPSHOT_RECORD_ID,
		[RecordTypes.ReferralSnapshotRecord]: REFERRAL_SNAPSHOT_RECORD_ID,
		[RecordTypes.PoolSnapshotRecord]: DLP_SNAPSHOT_RECORD_ID,
	};

	const HOURLY_RECORD_TYPE_TO_PREFIX: Record<SnapshotRecordTypes, string> = {
		[RecordTypes.TradeSnapshotRecord]: HOURLY_TRADE_SNAPSHOT_RECORD_ID,
		[RecordTypes.EarnSnapshotRecord]: HOURLY_EARN_SNAPSHOT_RECORD_ID,
		[RecordTypes.VaultDepositorSnapshotRecord]: HOURLY_VAULT_SNAPSHOT_RECORD_ID,
		[RecordTypes.VaultSnapshotRecord]: HOURLY_VAULT_SNAPSHOT_RECORD_ID,
		[RecordTypes.ReferralSnapshotRecord]: REFERRAL_SNAPSHOT_RECORD_ID,
		[RecordTypes.PoolSnapshotRecord]: HOURLY_DLP_SNAPSHOT_RECORD_ID,
	};

	const getSkPrefix = (
		recordType: SnapshotRecordTypes,
		frequency: SnapshotFrequency = 'daily'
	) => {
		return frequency === 'daily'
			? RECORD_TYPE_TO_PREFIX[recordType]
			: HOURLY_RECORD_TYPE_TO_PREFIX[recordType];
	};

	const createSnapshotRecords = async (
		snapshotRecords: (
			| TradeSnapshotRecord
			| VaultDepositorSnapshotRecord
			| EarnSnapshotRecord
			| VaultSnapshotRecord
			| ReferralSnapshotRecord
			| PoolSnapshotRecord
		)[],
		type: SnapshotRecordTypes
	) => {
		const records = snapshotRecords.map((record) => ({
			...getRecordKeys(record, type),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const createVerifySnapshotRecords = async (snapshotRecords: EarnSnapshotRecord[]) => {
		const records = snapshotRecords.map((record) => ({
			pk: VERIFY_SNAPSHOT_RECORD_ID,
			sk: `${VERIFY_SNAPSHOT_RECORD_ID}#${record.user}#${record.ts}`,
		}));

		return batchWrite({ records });
	};

	const getSnapshotsForTimestamps = async <
		T extends TradeSnapshotRecord | EarnSnapshotRecord | VaultDepositorSnapshotRecord
	>({
		entity = EntityTypes.User,
		recordType,
		id,
		timestamps,
		frequency = 'daily',
	}: {
		entity: EntityTypes;
		recordType: SnapshotRecordTypes;
		id: string;
		timestamps: number[];
		frequency: SnapshotFrequency;
	}): Promise<T[] | undefined> => {
		if (timestamps.length === 0) {
			return [];
		}
		const pk = entity === EntityTypes.User ? USER_PK : AUTHORITY_PK;
		const skPrefix = getSkPrefix(recordType, frequency);

		const keys = timestamps.map((timestamp) => ({
			pk: `${pk}#${id}`,
			sk: `${skPrefix}#${timestamp}`,
		}));

		const result = await batchGet({ keys });

		return (result as T[]).sort((a, b) => a.ts - b.ts);
	};

	const getSnapshotsBetweenTimestamps = async <
		T extends
			| TradeSnapshotRecord
			| EarnSnapshotRecord
			| VaultDepositorSnapshotRecord
			| PoolSnapshotRecord
			| ReferralSnapshotRecord
	>({
		entity = EntityTypes.User,
		id,
		startTs,
		endTs,
		recordType,
		frequency = 'daily',
	}: {
		entity: EntityTypes;
		recordType: SnapshotRecordTypes;
		id: string;
		startTs: number;
		endTs: number;
		frequency: SnapshotFrequency;
	}): Promise<T[] | undefined> => {
		const skPrefix = getSkPrefix(recordType, frequency);

		if (entity === EntityTypes.Pool) {
			const records = await queryAll({
				pk: `${POOL_PK}#${id}`,
				expression: 'pk = :pk AND sk BETWEEN :start AND :end',
				expressionValues: {
					':start': `${skPrefix}#${startTs}`,
					':end': `${skPrefix}#${endTs}`,
				},
			});

			return records as T[];
		}

		if (entity === EntityTypes.Authority) {
			if (recordType === RecordTypes.ReferralSnapshotRecord) {
				const records = await queryAll({
					pk: `${AUTHORITY_PK}#${id}`,
					expression: 'pk = :pk AND sk BETWEEN :start AND :end',
					expressionValues: {
						':start': `${skPrefix}#${startTs}`,
						':end': `${skPrefix}#${endTs}`,
					},
				});

				return records as T[];
			}

			const records = await queryAll({
				pk: `${AUTHORITY_PK}#${id}`,
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
				secondaryIndex: SecondaryIndex.GSI1,
				expressionValues: {
					':start': `${skPrefix}#${startTs}`,
					':end': `${skPrefix}#${endTs}`,
				},
			});

			return records as T[];
		}

		const records = await queryAll({
			pk: `${USER_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :start AND :end',
			expressionValues: {
				':start': `${skPrefix}#${startTs}`,
				':end': `${skPrefix}#${endTs}`,
			},
		});

		return records as T[];
	};

	const getSnapshot = async <
		T extends
			| TradeSnapshotRecord
			| VaultDepositorSnapshotRecord
			| EarnSnapshotRecord
			| ReferralSnapshotRecord
	>({
		entity = EntityTypes.User,
		id,
		orderAsc = true,
		recordType,
		frequency = 'daily',
	}: {
		entity: EntityTypes;
		recordType: SnapshotRecordTypes;
		id: string;
		orderAsc?: boolean;
		frequency: SnapshotFrequency;
	}): Promise<T | undefined> => {
		const pk = entity === EntityTypes.User ? USER_PK : AUTHORITY_PK;
		const skPrefix = getSkPrefix(recordType, frequency);

		const { Items = [] } = await query({
			pk: `${pk}#${id}`,
			sk: skPrefix,
			orderAsc,
			limit: 1,
		});

		return Items[0] as T;
	};

	const getPreviousSnapshot = async <
		T extends
			| TradeSnapshotRecord
			| VaultDepositorSnapshotRecord
			| EarnSnapshotRecord
			| ReferralSnapshotRecord
	>({
		entity = EntityTypes.User,
		recordType,
		id,
		timestamp,
		frequency = 'daily',
	}: {
		entity: EntityTypes;
		recordType: SnapshotRecordTypes;
		id: string;
		timestamp: number;
		frequency: SnapshotFrequency;
	}): Promise<T | undefined> => {
		const pk = entity === EntityTypes.User ? USER_PK : AUTHORITY_PK;
		const skPrefix = getSkPrefix(recordType, frequency);
		const { Items = [] } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :start AND :end',
			expressionValues: {
				':start': `${skPrefix}#0`,
				':end': `${skPrefix}#${timestamp}`,
			},
			limit: 1,
		});

		return Items[0] as T;
	};

	return {
		createSnapshotRecords,
		getSnapshot,
		getPreviousSnapshot,
		getSnapshotsBetweenTimestamps,
		getSnapshotsForTimestamps,

		createVerifySnapshotRecords,
	};
};
