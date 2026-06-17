import { DynamoDB } from '@backend/dynamodb';
import { ExportFileType, ExportJobRow, ExportMode, ExportStatus } from './types';

const EXPORTS_TTL_DAYS = 30;

// Worker handles both modes per message → it sets prefixed envs
// (VELOCITY_/DRIFT_). API Lambdas only handle their own mode → they set the
// unprefixed env. Look mode-prefixed first, fall back to unprefixed.
const tableName = (mode: ExportMode) => {
	const t =
		process.env[`${mode.toUpperCase()}_USER_EXPORTS_TABLE`] ?? process.env.USER_EXPORTS_TABLE;
	if (!t) {
		throw new Error(`USER_EXPORTS_TABLE env var not set (mode=${mode})`);
	}
	return t;
};

const authorityPk = (authority: string) => `AUTHORITY#${authority}`;

// SK encodes createdAt so DDB-native descending order on the SK gives a
// newest-first listing. Padded to 10 digits — fits unix seconds well past
// year 2286 and keeps lexicographic order == numeric order.
const requestSk = (createdAt: number, requestId: string) =>
	`REQUEST#${String(createdAt).padStart(10, '0')}#${requestId}`;

export const ExportJobRepository = (mode: ExportMode) => {
	const { put, query, update, get } = DynamoDB({ overrideTableName: tableName(mode) });

	const createJob = async (args: {
		requestId: string;
		authority: string;
		fileType: ExportFileType;
		from: number;
		to: number;
		userPublicKeys: string[];
		market?: string;
	}): Promise<ExportJobRow> => {
		const now = Math.floor(Date.now() / 1000);
		const row: ExportJobRow = {
			pk: authorityPk(args.authority),
			sk: requestSk(now, args.requestId),
			requestId: args.requestId,
			authority: args.authority,
			mode,
			status: ExportStatus.Pending,
			fileType: args.fileType,
			from: args.from,
			to: args.to,
			userPublicKeys: args.userPublicKeys,
			...(args.market ? { market: args.market } : {}),
			createdAt: now,
			expiresAt: now + EXPORTS_TTL_DAYS * 24 * 60 * 60,
		};
		await put({ record: row });
		return row;
	};

	const getJob = async (
		authority: string,
		requestId: string,
		createdAt: number
	): Promise<ExportJobRow | null> => {
		const res = await get({
			pk: authorityPk(authority),
			sk: requestSk(createdAt, requestId),
		});
		return (res.Item as ExportJobRow | undefined) ?? null;
	};

	const listJobsForAuthority = async (
		authority: string,
		page?: Record<string, any>
	): Promise<{ records: ExportJobRow[]; meta: { nextPage: Record<string, any> | null } }> => {
		// Default `orderAsc: false` in the wrapper => ScanIndexForward: false
		// => SK descending => newest-first (because SK is timestamp-prefixed).
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: authorityPk(authority),
			sk: 'REQUEST#',
			lastEvaluatedKey: page,
		});
		return {
			records: Items as ExportJobRow[],
			meta: { nextPage: LastEvaluatedKey },
		};
	};

	const markInProgress = async (authority: string, requestId: string, createdAt: number) => {
		await update({
			pk: authorityPk(authority),
			sk: requestSk(createdAt, requestId),
			updateExpression: 'SET #status = :inProgress, startedAt = :now',
			conditionExpression: '#status = :pending',
			expressionNames: { '#status': 'status' },
			expressionValues: {
				':inProgress': ExportStatus.InProgress,
				':pending': ExportStatus.Pending,
				':now': Math.floor(Date.now() / 1000),
			},
		});
	};

	const markReady = async (
		authority: string,
		requestId: string,
		createdAt: number,
		s3Key: string,
		recordCount: number
	) => {
		await update({
			pk: authorityPk(authority),
			sk: requestSk(createdAt, requestId),
			updateExpression:
				'SET #status = :ready, s3Key = :key, recordCount = :count, completedAt = :now',
			expressionNames: { '#status': 'status' },
			expressionValues: {
				':ready': ExportStatus.Ready,
				':key': s3Key,
				':count': recordCount,
				':now': Math.floor(Date.now() / 1000),
			},
		});
	};

	const markFailed = async (
		authority: string,
		requestId: string,
		createdAt: number,
		reason: string
	) => {
		await update({
			pk: authorityPk(authority),
			sk: requestSk(createdAt, requestId),
			updateExpression: 'SET #status = :failed, errorReason = :reason, completedAt = :now',
			expressionNames: { '#status': 'status' },
			expressionValues: {
				':failed': ExportStatus.Failed,
				':reason': reason.slice(0, 1024),
				':now': Math.floor(Date.now() / 1000),
			},
		});
	};

	return {
		createJob,
		getJob,
		listJobsForAuthority,
		markInProgress,
		markReady,
		markFailed,
	};
};
