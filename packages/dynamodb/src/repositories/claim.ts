import {
	BaseDynamoRecord,
	ClaimRecord,
	ClaimStatus,
	ClaimType,
	getTimestamp,
	RecordTypes,
	SecondaryIndex,
} from '@backend/common';
import { DynamoDB } from '../client';
import { getBaseRecordFields, getRecordKeys } from '../utils';

interface AccrualClaimProgressInput {
	authorityId: string;
	campaignId: string;
	amount: number;
	assetSymbol: string;
	campaignStartTs: number;
	campaignEndTs: number;
	progressAmount: number;
	progressCap: number;
}

type ClaimBaseRecordFields = {
	createdAt: number;
};

type PersistedClaimRecord = ClaimRecord & BaseDynamoRecord & ClaimBaseRecordFields;

export const ClaimRepository = () => {
	const { batchWrite, get, put, query, update } = DynamoDB();

	const createEligibleClaims = async (
		claimRecords: Omit<ClaimRecord, 'status' | 'updatedAt'>[]
	) => {
		const records = claimRecords.map((record) => {
			const createdRecord: ClaimRecord = {
				...record,
				status: ClaimStatus.ELIGIBLE,
				rewardRunnerAttemptCount: 0,
				updatedAt: getTimestamp(),
			};

			return {
				...getRecordKeys(createdRecord, RecordTypes.ClaimRecord),
				...createdRecord,
				...getBaseRecordFields(createdRecord),
			};
		});

		return batchWrite({ records });
	};

	const getClaim = async ({
		authorityId,
		campaignId,
	}: {
		authorityId: string;
		campaignId: string;
	}): Promise<PersistedClaimRecord | null> => {
		const { pk, sk } = getRecordKeys(
			{
				authorityId,
				campaignId,
			} as ClaimRecord,
			RecordTypes.ClaimRecord
		);

		const { Item = null } = await get({ pk, sk });

		return Item ? (Item as PersistedClaimRecord) : null;
	};

	const reserveClaim = async ({
		authorityId,
		campaignId,
		deviceId,
		platform,
		targetUserAccount,
	}: {
		authorityId: string;
		campaignId: string;
		deviceId: string;
		platform?: ClaimRecord['platform'];
		targetUserAccount: string;
	}): Promise<PersistedClaimRecord> => {
		const updatedAt = getTimestamp();
		const { pk, sk } = getRecordKeys(
			{
				authorityId,
				campaignId,
			} as ClaimRecord,
			RecordTypes.ClaimRecord
		);
		const { GSI1PK, GSI1SK } = getRecordKeys(
			{
				authorityId,
				campaignId,
				status: ClaimStatus.PROCESSING,
				updatedAt,
			} as ClaimRecord,
			RecordTypes.ClaimRecord
		);

		const result = await update({
			pk,
			sk,
			updateExpression:
				'SET #status = :processing, claimedByDeviceId = :claimedByDeviceId, platform = :platform, targetUserAccount = :targetUserAccount, processingStartedAt = :processingStartedAt, rewardRunnerAttemptCount = :rewardRunnerAttemptCount, updatedAt = :updatedAt, GSI1PK = :gsi1pk, GSI1SK = :gsi1sk REMOVE lastError, retryAfterTs, sendStartedAt',
			conditionExpression:
				'attribute_exists(pk) AND attribute_exists(sk) AND #status = :expectedStatus',
			expressionNames: {
				'#status': 'status',
			},
			expressionValues: {
				':processing': ClaimStatus.PROCESSING,
				':claimedByDeviceId': deviceId,
				':platform': platform ?? '',
				':targetUserAccount': targetUserAccount,
				':processingStartedAt': updatedAt,
				':rewardRunnerAttemptCount': 0,
				':updatedAt': updatedAt,
				':gsi1pk': GSI1PK!,
				':gsi1sk': GSI1SK!,
				':expectedStatus': ClaimStatus.ELIGIBLE,
			},
		});

		return result.Attributes as PersistedClaimRecord;
	};

	const resetClaim = async ({
		authorityId,
		campaignId,
	}: {
		authorityId: string;
		campaignId: string;
	}): Promise<ClaimRecord & BaseDynamoRecord> => {
		const updatedAt = getTimestamp();
		const { pk, sk } = getRecordKeys(
			{
				authorityId,
				campaignId,
			} as ClaimRecord,
			RecordTypes.ClaimRecord
		);
		const { GSI1PK, GSI1SK } = getRecordKeys(
			{
				authorityId,
				campaignId,
				status: ClaimStatus.ELIGIBLE,
				updatedAt,
			} as ClaimRecord,
			RecordTypes.ClaimRecord
		);

		const result = await update({
			pk,
			sk,
			updateExpression:
				'SET #status = :eligible, rewardRunnerAttemptCount = :rewardRunnerAttemptCount, updatedAt = :updatedAt, GSI1PK = :gsi1pk, GSI1SK = :gsi1sk REMOVE claimedByDeviceId, platform, targetUserAccount, processingStartedAt, sendStartedAt, processedAt, rewardTxSig, lastError, retryAfterTs',
			conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			expressionNames: {
				'#status': 'status',
			},
			expressionValues: {
				':eligible': ClaimStatus.ELIGIBLE,
				':rewardRunnerAttemptCount': 0,
				':updatedAt': updatedAt,
				':gsi1pk': GSI1PK!,
				':gsi1sk': GSI1SK!,
			},
		});

		return result.Attributes as ClaimRecord & BaseDynamoRecord;
	};

	const getClaimsByStatus = async ({
		campaignId,
		status,
		page = undefined,
		limit = 20,
	}: {
		campaignId: string;
		status: ClaimStatus;
		page?: Record<string, any>;
		limit?: number;
	}): Promise<{
		records: PersistedClaimRecord[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `CLAIM#${campaignId}#${status}`,
			sk: '',
			secondaryIndex: SecondaryIndex.GSI1,
			lastEvaluatedKey: page,
			limit,
			orderAsc: true,
		});

		return {
			records: Items as PersistedClaimRecord[],
			meta: { nextPage: LastEvaluatedKey },
		};
	};

	const upsertAccrualClaimProgress = async (
		input: AccrualClaimProgressInput
	): Promise<PersistedClaimRecord> => {
		const {
			authorityId,
			campaignId,
			amount,
			assetSymbol,
			campaignStartTs,
			campaignEndTs,
			progressAmount: rawProgressAmount,
			progressCap,
		} = input;
		const existingClaim = await getClaim({ authorityId, campaignId });

		const updatedAt = getTimestamp();
		const progressAmount = Math.max(0, Math.min(rawProgressAmount, progressCap));
		const isCompleted = existingClaim?.status === ClaimStatus.COMPLETED;
		const isProcessing = existingClaim?.status === ClaimStatus.PROCESSING;
		const claimableAmount = isCompleted ? 0 : progressAmount >= progressCap ? amount : 0;

		const status = isCompleted
			? ClaimStatus.COMPLETED
			: isProcessing
			? ClaimStatus.PROCESSING
			: claimableAmount > 0
			? ClaimStatus.ELIGIBLE
			: ClaimStatus.ACCRUING;

		const claimedAmount = isCompleted
			? existingClaim?.claimedAmount ?? existingClaim?.amount ?? amount
			: existingClaim?.claimedAmount ?? 0;

		const createdAt = existingClaim?.createdAt ?? getTimestamp();
		const nextClaim: ClaimRecord & ClaimBaseRecordFields = {
			authorityId,
			campaignId,
			status,
			amount,
			assetSymbol,
			claimType: ClaimType.ACCRUAL,
			progressAmount,
			progressCap,
			claimableAmount,
			claimedAmount,
			lastSyncedAt: updatedAt,
			campaignStartTs,
			campaignEndTs,
			claimedByDeviceId: existingClaim?.claimedByDeviceId,
			platform: existingClaim?.platform,
			targetUserAccount: existingClaim?.targetUserAccount,
			processingStartedAt: existingClaim?.processingStartedAt,
			sendStartedAt: existingClaim?.sendStartedAt,
			processedAt: existingClaim?.processedAt,
			rewardTxSig: existingClaim?.rewardTxSig,
			rewardRunnerAttemptCount: existingClaim?.rewardRunnerAttemptCount ?? 0,
			lastError: existingClaim?.lastError,
			retryAfterTs: existingClaim?.retryAfterTs,
			createdAt,
			updatedAt,
		};

		const record = {
			...getRecordKeys(nextClaim, RecordTypes.ClaimRecord),
			...nextClaim,
		};

		await put({ record });

		return record as PersistedClaimRecord;
	};

	return {
		createEligibleClaims,
		getClaim,
		reserveClaim,
		resetClaim,
		getClaimsByStatus,
		upsertAccrualClaimProgress,
	};
};
